import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loginWithPkce } from "./oauth-login.js";
import { approveInBrowser, kubectl, sleep } from "../attack/lib.js";

/**
 * Black-box journey against a running deployment (local process or the cluster gateway):
 *   MCP_URL=http://localhost:8000/mcp TEST_USER_PASSWORD=... npm run test:e2e
 * Behaves like a real MCP client: 401 challenge -> discovery -> PKCE login (+ consent) -> retry; and like the
 * customer: opens the approval link, signs in again, approves. Runs the journey that matches the deployment:
 * sign in on first connect (REQUIRE_SIGN_IN=true, both scopes advertised) or anonymous first (false).
 */
const MCP_URL = process.env.MCP_URL ?? "http://localhost:8000/mcp";
const PASSWORD = process.env.TEST_USER_PASSWORD ?? "";
const CLIENT_ID = process.env.CLIENT_ID ?? "mcp-test-client";
const REDIRECT_URI = "http://localhost:53682/callback";

let bearer: string | undefined;
let lastChallenge: string | null = null;
let lastStatus = 0;
const authFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  const res = await fetch(input, { ...init, headers });
  lastStatus = res.status;
  if (res.status === 401 || res.status === 403) lastChallenge = res.headers.get("www-authenticate");
  return res;
};

/** Against the gateway the session id is issued by it. Hitting the server directly, supply our own. */
const LOCAL_SESSIONS = process.env.LOCAL_SESSIONS === "1";

async function connect() {
  const client = new Client({ name: "e2e-agent", version: "1.0.0" });
  const sessionId = `local-${Math.random().toString(36).slice(2)}`;
  const sessionFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    if (LOCAL_SESSIONS) headers.set("mcp-session-id", sessionId);
    return authFetch(input, { ...init, headers });
  };
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: sessionFetch }));
  return client;
}
/** Returns the structured payload, failing with the tool's own message if it errored. */
const structured = (r: unknown) => {
  const result = r as { isError?: boolean; structuredContent?: any; content?: { text: string }[] };
  if (result.isError) throw new Error(`tool error: ${result.content?.[0]?.text}`);
  return result.structuredContent;
};

async function stepUpLogin(challenge: string) {
  const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge)![1]!;
  const scope = /scope="([^"]+)"/.exec(challenge)![1]!;
  const prm = (await (await fetch(prmUrl)).json()) as { authorization_servers: string[] };
  const as = (await (await fetch(`${prm.authorization_servers[0]}/.well-known/openid-configuration`)).json()) as {
    authorization_endpoint: string;
    token_endpoint: string;
  };
  return loginWithPkce({
    authorizationEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scope: `openid ${scope}`,
    username: "testuser",
    password: PASSWORD,
  });
}

// Admin API: not on the gateway, reached through the admin port-forward.
const KC_URL = process.env.KC_URL ?? "http://localhost:8080";
const KC_ADMIN_PASSWORD = process.env.KC_ADMIN_PASSWORD;
const REALM = process.env.REALM ?? "mcp";

/**
 * Forgets the user's consent for the client so the "first time" path can be exercised repeatably. Needs the platform's
 * Keycloak admin password, which application teams do not have: without it the journey still runs, but the
 * consent screen may or may not appear depending on earlier runs.
 */
async function resetConsent() {
  if (!KC_ADMIN_PASSWORD) return;
  const tokenRes = await fetch(`${KC_URL}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({ client_id: "admin-cli", grant_type: "password", username: "admin", password: KC_ADMIN_PASSWORD! }),
  });
  const headers = { authorization: `Bearer ${((await tokenRes.json()) as { access_token: string }).access_token}` };
  const users = (await (await fetch(`${KC_URL}/admin/realms/${REALM}/users?username=testuser&exact=true`, { headers })).json()) as { id: string }[];
  await fetch(`${KC_URL}/admin/realms/${REALM}/users/${users[0]!.id}/consents/${CLIENT_ID}`, { method: "DELETE", headers });
}

/**
 * Carts are in memory and a customer's cart lives 24 h, so items left by earlier runs (smoke test, attack lab)
 * would change totals or hit the spend cap. Against the cluster, start from a clean shop (RESET_SHOP=0 to skip).
 */
async function resetShop() {
  if (process.env.RESET_SHOP === "0") return;
  kubectl(["-n", "mcp-servers", "rollout", "restart", "deploy/ecommerce-mcp-server"]);
  kubectl(["-n", "mcp-servers", "rollout", "status", "deploy/ecommerce-mcp-server", "--timeout=120s"]);
  await sleep(5000);
}

const prmUrl = new URL(`/.well-known/oauth-protected-resource${new URL(MCP_URL).pathname}`, MCP_URL).href;
const advertised = PASSWORD ? (((await (await fetch(prmUrl)).json()) as { scopes_supported?: string[] }).scopes_supported ?? []) : [];
/** Sign-in-first deployments advertise the checkout scope up front; anonymous-first ones only the API scope. */
const SIGN_IN_FIRST = advertised.includes("ecommerce:checkout");

describe.runIf(PASSWORD && SIGN_IN_FIRST)("shop MCP journey: sign in on first connect", () => {
  beforeAll(async () => {
    await resetShop();
    await resetConsent();
  }, 180_000);

  it("connecting without a token asks for one sign-in with both scopes; then browse, cart and checkout need no more", async () => {
    // 1. No token: refused before any session exists, with both scopes and what the customer should do
    await expect(connect()).rejects.toThrow();
    expect(lastStatus).toBe(401);
    expect(lastChallenge).toMatch(/scope="shop:api ecommerce:checkout"/);
    expect(lastChallenge).toMatch(/error_description="[^"]*sign in[^"]*"/);

    // 2. The customer signs in once and consents to the agent shopping for them
    const first = await stepUpLogin(lastChallenge!);
    if (KC_ADMIN_PASSWORD) expect(first.consentShown).toBe(true);
    expect(first.grantedScope).toContain("ecommerce:checkout");
    bearer = first.accessToken;

    // 3. Browse, cart, checkout on that one sign-in: no step-up; money still needs the customer's approval
    const agent = await connect();
    expect(structured(await agent.callTool({ name: "product_search", arguments: { query: "running shoes" } })).products.length).toBeGreaterThan(0);
    structured(await agent.callTool({ name: "add_to_cart", arguments: { productId: "shoe-trail-001", quantity: 1 } }));
    const pending = structured(await agent.callTool({ name: "one_step_checkout", arguments: {} }));
    expect(pending.status).toBe("approval_required");
    expect((await approveInBrowser(pending.approvalUrl)).result).toMatch(/Order ord_\w+ for \$[\d.]+ is placed/);
    const order = structured(await agent.callTool({ name: "one_step_checkout", arguments: {} })).order;
    expect(order.total).toBe(89.99);
    expect(structured(await agent.callTool({ name: "list_orders", arguments: {} })).orders.length).toBeGreaterThan(0);

    // 4. A second agent of the same customer (new connection) shares the customer's cart; a later sign-in skips consent
    const again = await stepUpLogin(lastChallenge!);
    expect(again.consentShown).toBe(false);
    bearer = again.accessToken;
    const second = await connect();
    structured(await agent.callTool({ name: "add_to_cart", arguments: { productId: "bottle-001", quantity: 1 } }));
    const shared = structured(await second.callTool({ name: "view_cart", arguments: {} }));
    expect(shared.cart.items.map((i: { productId: string }) => i.productId)).toContain("bottle-001");
    const pending2 = structured(await second.callTool({ name: "one_step_checkout", arguments: {} }));
    await approveInBrowser(pending2.approvalUrl);
    expect(structured(await second.callTool({ name: "one_step_checkout", arguments: {} })).order.total).toBe(24.99);
  });
});

describe.runIf(PASSWORD && !SIGN_IN_FIRST)("shop MCP journey: anonymous first", () => {
  beforeAll(async () => {
    await resetShop();
    await resetConsent();
  }, 180_000);

  it("anonymous browse+cart, step-up login with consent, then checkout; later checkouts skip consent", async () => {
    // 1. Anonymous browsing and cart
    const agent = await connect();
    const search = await agent.callTool({ name: "product_search", arguments: { query: "running shoes" } });
    expect(structured(search).products.length).toBeGreaterThan(0);
    structured(await agent.callTool({ name: "add_to_cart", arguments: { productId: "shoe-trail-001", quantity: 1 } }));

    // 2. Checkout without credentials is refused with a step-up challenge
    await expect(agent.callTool({ name: "one_step_checkout", arguments: {} })).rejects.toThrow();
    expect(lastStatus).toBe(401);
    expect(lastChallenge).toMatch(/scope="[^"]*ecommerce:checkout[^"]*"/);

    // 3. Customer signs in; first time they must consent to the agent buying for them
    const first = await stepUpLogin(lastChallenge!);
    if (KC_ADMIN_PASSWORD) expect(first.consentShown).toBe(true);
    expect(first.grantedScope).toContain("ecommerce:checkout");
    bearer = first.accessToken;

    // 4. Same session, now authenticated: the anonymous cart is claimed, but nothing is charged until the
    //    customer approves on the shop's own page (fresh sign-in there)
    const pending = structured(await agent.callTool({ name: "one_step_checkout", arguments: {} }));
    expect(pending.status).toBe("approval_required");
    expect((await approveInBrowser(pending.approvalUrl)).result).toMatch(/Order ord_\w+ for \$[\d.]+ is placed/);
    const order = structured(await agent.callTool({ name: "one_step_checkout", arguments: {} })).order;
    expect(order.orderId).toMatch(/^ord_/);
    expect(order.total).toBe(89.99);
    expect(order.payment.last4).toBe("4242");

    // 5. A later login (e.g. agent restarted) finds consent already on record: no consent screen
    bearer = undefined;
    const restarted = await connect();
    structured(await restarted.callTool({ name: "add_to_cart", arguments: { productId: "bottle-001", quantity: 1 } }));
    const again = await stepUpLogin(`resource_metadata="${prmUrl}", scope="shop:api ecommerce:checkout"`);
    expect(again.consentShown).toBe(false);
    bearer = again.accessToken;
    const pending2 = structured(await restarted.callTool({ name: "one_step_checkout", arguments: {} }));
    await approveInBrowser(pending2.approvalUrl);
    const second = structured(await restarted.callTool({ name: "one_step_checkout", arguments: {} })).order;
    expect(second.total).toBe(24.99);
  });
});

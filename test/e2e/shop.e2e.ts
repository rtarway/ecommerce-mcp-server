import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loginWithPkce } from "./oauth-login.js";

/**
 * Black-box journey against a running deployment (local process or the cluster gateway):
 *   MCP_URL=http://localhost:8000/mcp TEST_USER_PASSWORD=... npm run test:e2e
 * Behaves like a real MCP client: 401 challenge -> discovery -> PKCE login (+ consent) -> retry.
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

const KC_URL = process.env.KC_URL ?? "http://localhost:8080";
const KC_ADMIN_PASSWORD = process.env.KC_ADMIN_PASSWORD;
const REALM = process.env.REALM ?? "mcp";

/** Forgets the user's consent for the client so the "first time" path can be exercised repeatably. */
async function resetConsent() {
  const tokenRes = await fetch(`${KC_URL}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({ client_id: "admin-cli", grant_type: "password", username: "admin", password: KC_ADMIN_PASSWORD! }),
  });
  const headers = { authorization: `Bearer ${((await tokenRes.json()) as { access_token: string }).access_token}` };
  const users = (await (await fetch(`${KC_URL}/admin/realms/${REALM}/users?username=testuser&exact=true`, { headers })).json()) as { id: string }[];
  await fetch(`${KC_URL}/admin/realms/${REALM}/users/${users[0]!.id}/consents/${CLIENT_ID}`, { method: "DELETE", headers });
}

describe.runIf(PASSWORD && KC_ADMIN_PASSWORD)("shop MCP journey", () => {
  beforeAll(resetConsent);

  it("anonymous browse+cart, step-up login with consent, then checkout; later checkouts skip consent", async () => {
    // 1. Anonymous browsing and cart
    const agent = await connect();
    const search = await agent.callTool({ name: "product_search", arguments: { query: "running shoes" } });
    expect(structured(search).products.length).toBeGreaterThan(0);
    structured(await agent.callTool({ name: "add_to_cart", arguments: { productId: "shoe-trail-001", quantity: 1 } }));

    // 2. Checkout without credentials is refused with a step-up challenge
    await expect(agent.callTool({ name: "one_step_checkout", arguments: {} })).rejects.toThrow();
    expect(lastStatus).toBe(401);
    expect(lastChallenge).toMatch(/scope="ecommerce:checkout"/);

    // 3. Customer signs in; first time they must consent to the agent buying for them
    const first = await stepUpLogin(lastChallenge!);
    expect(first.consentShown).toBe(true);
    expect(first.grantedScope).toContain("ecommerce:checkout");
    bearer = first.accessToken;

    // 4. Same session, now authenticated: the anonymous cart is claimed and ordered
    const order = structured(await agent.callTool({ name: "one_step_checkout", arguments: {} })).order;
    expect(order.orderId).toMatch(/^ord_/);
    expect(order.total).toBe(89.99);
    expect(order.payment.last4).toBe("4242");

    // 5. A later login (e.g. agent restarted) finds consent already on record: no consent screen
    bearer = undefined;
    const restarted = await connect();
    structured(await restarted.callTool({ name: "add_to_cart", arguments: { productId: "bottle-001", quantity: 1 } }));
    const again = await stepUpLogin("resource_metadata=\"" + new URL("/.well-known/oauth-protected-resource" + new URL(MCP_URL).pathname, MCP_URL).href + "\", scope=\"ecommerce:checkout\"");
    expect(again.consentShown).toBe(false);
    bearer = again.accessToken;
    const second = structured(await restarted.callTool({ name: "one_step_checkout", arguments: {} })).order;
    expect(second.total).toBe(24.99);
  });
});

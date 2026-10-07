/**
 * Prints an access token for the demo customer (login + consent handled headlessly, PKCE).
 *   TEST_USER_PASSWORD=… npx tsx scripts/get-token.ts            # token on stdout
 * Paste it into Inspector as header `Authorization: Bearer <token>` to act as a signed-in customer.
 */
import { loginWithPkce } from "../test/e2e/oauth-login.js";

const MCP_URL = process.env.MCP_URL ?? "http://localhost:8000/mcp";
const password = process.env.TEST_USER_PASSWORD;
if (!password) {
  console.error("Set TEST_USER_PASSWORD (terraform -chdir=<infra>/terraform output -raw test_user_password)");
  process.exit(1);
}

const prmUrl = new URL(`/.well-known/oauth-protected-resource${new URL(MCP_URL).pathname}`, MCP_URL);
const prm = (await (await fetch(prmUrl)).json()) as { authorization_servers: string[]; scopes_supported: string[] };
const issuer = prm.authorization_servers[0]!;
const meta = (await (await fetch(`${issuer}/.well-known/openid-configuration`)).json()) as {
  authorization_endpoint: string;
  token_endpoint: string;
};

const { accessToken, consentShown } = await loginWithPkce({
  authorizationEndpoint: meta.authorization_endpoint,
  tokenEndpoint: meta.token_endpoint,
  clientId: process.env.CLIENT_ID ?? "mcp-test-client",
  redirectUri: "http://localhost:53682/callback",
  scope: `openid ${prm.scopes_supported.join(" ")}`,
  username: process.env.TEST_USER ?? "testuser",
  password,
});
if (consentShown) console.error("(consent screen was shown and accepted)");
console.log(accessToken);

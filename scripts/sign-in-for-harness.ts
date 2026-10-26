/**
 * Completes an agent harness's browser sign-in headlessly, as the demo customer: opens the authorization URL the
 * harness printed, signs in and consents on Keycloak's pages, then delivers the code to the harness's loopback
 * callback. For automated harness runs; a person would do the same in a browser.
 *   TEST_USER_PASSWORD=… npx tsx scripts/sign-in-for-harness.ts '<authorization URL>'
 *   … --print-callback   prints the redirect URL instead of calling it, for harnesses that ask you to paste it back
 */
import { authorizeInBrowser } from "../test/e2e/oauth-login.js";

const authorizationUrl = process.argv[2];
const password = process.env.TEST_USER_PASSWORD;
if (!authorizationUrl || !password) {
  console.error("usage: TEST_USER_PASSWORD=… sign-in-for-harness.ts '<authorization URL>'");
  process.exit(2);
}
const params = new URL(authorizationUrl).searchParams;
const redirectUri = params.get("redirect_uri");
if (!redirectUri) throw new Error("authorization URL has no redirect_uri");
const { callback, consentShown } = await authorizeInBrowser({ authorizationUrl, redirectUri, username: process.env.TEST_USER ?? "testuser", password });
if (process.argv.includes("--print-callback")) {
  console.error(JSON.stringify({ client: params.get("client_id"), scope: params.get("scope"), consentShown }));
  console.log(callback.toString());
} else {
  const delivered = await fetch(callback, { redirect: "manual" });
  console.log(JSON.stringify({ client: params.get("client_id"), scope: params.get("scope"), consentShown, callbackStatus: delivered.status }));
}

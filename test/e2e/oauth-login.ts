import { createHash, randomBytes } from "node:crypto";

/**
 * Headless Authorization Code + PKCE login against Keycloak's HTML pages, standing in for the
 * browser step a human (or agent harness) would do. Returns whether a consent page was shown.
 */
export interface LoginParams {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  username: string;
  password: string;
  /** Send this Origin on the token request, as a browser client would; reports the CORS verdict. */
  browserOrigin?: string;
  /** Extra authorization-request parameters, e.g. prompt/max_age. */
  authParams?: Record<string, string>;
  /** Attack lab: send no PKCE challenge, as a sloppy or malicious client would. Default true. */
  pkce?: boolean;
  /** Called when Keycloak asks for a one-time code; return the current TOTP. */
  otp?: (html: string) => Promise<string>;
}

const decode = (s: string) => s.replace(/&amp;/g, "&");
const formAction = (html: string, base: string) => {
  const m = /<form[^>]*\saction="([^"]+)"/.exec(html);
  if (!m) throw new Error(`no <form> in page: ${html.slice(0, 300)}`);
  return new URL(decode(m[1]!), base).toString();
};
const hiddenInputs = (html: string) => [...html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)].map((m) => m[0]);
const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];

class Cookies {
  private jar = new Map<string, string>();
  absorb(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, ...v] = pair!.split("=");
      this.jar.set(k!, v.join("="));
    }
  }
  header() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/**
 * The browser half of a sign-in: opens an authorization URL (built by us or by an agent harness), signs in on
 * Keycloak's login page, accepts the consent page if one appears, and stops at the client's redirect URI. Returns
 * that callback URL (code + state) without calling it.
 */
export async function authorizeInBrowser(p: { authorizationUrl: string; redirectUri: string; username: string; password: string }) {
  const cookies = new Cookies();
  const get = async (url: string, init: RequestInit = {}) => {
    const res = await fetch(url, { redirect: "manual", ...init, headers: { cookie: cookies.header(), ...(init.headers as object) } });
    cookies.absorb(res);
    return res;
  };
  const post = (url: string, form: URLSearchParams) =>
    get(url, { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded" } });
  const redirectedWithCode = (res: Response) => {
    const loc = res.headers.get("location");
    return loc?.startsWith(p.redirectUri) ? new URL(loc) : undefined;
  };

  const loginPage = await get(p.authorizationUrl);
  const loginHtml = await loginPage.text();
  /** Follows Keycloak-internal redirects, stopping at the client redirect_uri or a rendered page. */
  const settle = async (first: Response) => {
    let res = first;
    for (let hops = 0; hops < 8 && res.status >= 300 && res.status < 400 && !redirectedWithCode(res); hops++) {
      res = await get(new URL(res.headers.get("location")!, p.authorizationUrl).toString());
    }
    return res;
  };
  let res = await settle(
    await post(formAction(loginHtml, p.authorizationUrl), new URLSearchParams({ username: p.username, password: p.password, credentialId: "" })),
  );

  let consentShown = false;
  let done = redirectedWithCode(res);
  if (!done) {
    const html = await res.text();
    if (res.status !== 200 || !/consent|grant/i.test(html)) throw new Error(`login failed (status ${res.status}): ${html.slice(0, 400)}`);
    consentShown = true;
    const form = new URLSearchParams({ accept: "Yes" });
    for (const tag of hiddenInputs(html)) form.set(attr(tag, "name")!, attr(tag, "value") ?? "");
    res = await settle(await post(formAction(html, p.authorizationUrl), form));
    done = redirectedWithCode(res);
    if (!done) throw new Error(`consent not accepted (status ${res.status})`);
  }
  return { callback: done, consentShown };
}

export async function loginWithPkce(p: LoginParams) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authUrl = new URL(p.authorizationEndpoint);
  authUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: p.scope,
    state: "xyz",
    ...(p.pkce === false ? {} : { code_challenge: challenge, code_challenge_method: "S256" }),
    ...p.authParams,
  }).toString();
  const { callback: done, consentShown } = await authorizeInBrowser({ authorizationUrl: authUrl.toString(), redirectUri: p.redirectUri, username: p.username, password: p.password });

  const code = done.searchParams.get("code");
  if (!code) throw new Error(`no code in redirect: ${done}`);
  const tokenRes = await fetch(p.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(p.browserOrigin ? { origin: p.browserOrigin } : {}) },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: p.redirectUri,
      client_id: p.clientId,
      ...(p.pkce === false ? {} : { code_verifier: verifier }),
    }),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed: ${await tokenRes.text()}`);
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token?: string; id_token?: string; scope: string };
  const tokenCorsOrigin = tokenRes.headers.get("access-control-allow-origin");
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token, grantedScope: tokens.scope, consentShown, tokenCorsOrigin };
}

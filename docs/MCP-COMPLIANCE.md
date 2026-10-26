# MCP specification compliance report

**Subject:** `ecommerce-mcp-server` (shop MCP server + session-manager) as deployed on the `mcp-ecosystem-infra`
platform (agentgateway, Keycloak realm `mcp`). Proof of concept: a demo shop on a local lab.

**Assessed:** 2026-10-12.

**Revisions:**
- **2025-11-25** is what the server implements. MCP TypeScript SDK 1.32.1 supports up to it, and today's clients use it (MCP Inspector included).
- **2026-07-28** is the current revision; readiness for it is assessed in [§8](#8-readiness-for-revision-2026-07-28).

**Method:** every requirement below was checked by one or more of:
- **probe:** `scripts/mcp-compliance-probe.sh` against the live gateway, anonymous (ids `L*`, `T*`, `X*`, `A*`, `S*`);
- **lab:** the attack lab, `npm run test:attack` (ids `A1`–`H2`, see [ATTACK-RESULTS.md](ATTACK-RESULTS.md));
- **unit:** `npm test` (182 tests);
- **server-alone:** the shop app started in-process without the gateway, to separate shop behaviour from gateway behaviour;
- **config:** reading the deployed configuration or the identity provider's metadata.

**Legend:** ✅ compliant · ⚠️ partial or deviation · ❌ not compliant · N/A not applicable (feature not offered,
capability not declared, or the requirement targets clients). Levels as in the spec: MUST, SHOULD, MAY.

---

## 1. Summary

| Area | MUST | SHOULD / recommended | Notes |
|---|---|---|---|
| Base protocol and lifecycle | ✅ all | ✅ | version negotiation, ping, capabilities |
| Streamable HTTP transport | ✅ all at the deployed edge | ⚠️ 1 | the shop alone accepts JSON-RPC batches; the gateway refuses them |
| Session management | ✅ all | ✅ | sessions bound to their customer |
| Tools | ✅ all | ⚠️ 3 | unknown-tool error class, no-arg schemas, `listChanged` claim |
| Authorization (resource server) | ✅ all | ✅ | audience via a resource scope (Keycloak has no RFC 8707) |
| Authorization (authorization server, platform) | ⚠️ 2 (lab: HTTPS, exact redirect URIs for the test client) | ⚠️ 2 (CIMD, `plain` PKCE advertised) | platform items |
| Security best practices | ✅ all applicable | ✅ / ⚠️ 1 | approval cookies lack `__Host-`/`Secure` (HTTP lab) |
| Gateway (as the deployed edge) | ⚠️ 1 | | unknown method → `-32603`/HTTP 500 instead of `-32601` |
| Revision 2026-07-28 | not yet | | stateless model, header↔body validation, MRTR |

Open items with an owner and a fix: [§9](#9-deviations-and-remediation).

---

## 2. Base protocol and lifecycle (2025-11-25)

| # | Requirement | Level | Status | Evidence |
|---|---|---|---|---|
| 2.1 | JSON-RPC 2.0 messages, UTF-8 | MUST | ✅ | SDK; all probes |
| 2.2 | `initialize` result includes `protocolVersion`, `capabilities`, `serverInfo` | MUST | ✅ | probe L1 (`serverInfo` `ecommerce-mcp-server` 0.2.0, `instructions` present) |
| 2.3 | Supported client version → same version; otherwise a version the server supports (the latest) | MUST / SHOULD | ✅ | probe L2 (`1999-01-01` → `2025-11-25`) |
| 2.4 | Server sends no requests other than ping/logging before `initialized` | SHOULD NOT | ✅ | the server never sends requests |
| 2.5 | `ping` answered | MUST | ✅ | probe L3 |
| 2.6 | Unknown method → `-32601 Method not found` | JSON-RPC | ✅ shop / ⚠️ gateway | server-alone: `-32601`; through the gateway: HTTP 500 `-32603 unsupported method` (probe T9) |
| 2.7 | Only negotiated capabilities used | MUST | ✅ | declares only `tools`; uses no client capabilities |
| 2.8 | Timeouts for requests | SHOULD | ✅ | HTTP header/request/keep-alive timeouts; the server issues no outbound MCP requests |

## 3. Streamable HTTP transport (2025-11-25)

| # | Requirement | Level | Status | Evidence |
|---|---|---|---|---|
| 3.1 | One MCP endpoint supporting POST (and GET) | MUST | ✅ | `/mcp` |
| 3.2 | Validate `Origin` on all connections; invalid → 403 | MUST | ✅ | probe T8; lab A6 (gateway refuses unknown `Host`, shop refuses unknown `Origin`); unit |
| 3.3 | Bind to localhost when running locally | SHOULD | ✅ / N/A | the server runs in a pod; only the gateway reaches it (namespace baseline); the gateway is published on the host |
| 3.4 | Authentication for all connections | SHOULD | ⚠️ by design | anonymous browsing and carts are intentional (public catalogue); purchasing, orders and account data require OAuth; anonymous use is bounded by rate limits, session caps, Origin checks and session binding |
| 3.5 | Body is a single JSON-RPC message (batching removed since 2025-06-18) | MUST (client) | ✅ edge / ⚠️ shop | through the gateway a batch → 400 (probe T4); **the shop alone accepts a batch** even with `MCP-Protocol-Version: 2025-11-25` (server-alone check; SDK keeps batching for older versions) |
| 3.6 | Notification or response accepted → 202, no body | MUST | ✅ | probe T2 |
| 3.7 | Request → `application/json` or `text/event-stream` | MUST | ✅ | JSON responses (`enableJsonResponse`) |
| 3.8 | GET → SSE stream or 405 | MUST | ✅ | probe T3 (405) |
| 3.9 | `Accept` must list both types | MUST (client) | ✅ enforced | probe T6 (406) |
| 3.10 | Unsupported or invalid `MCP-Protocol-Version` → 400 | MUST | ✅ | probe T5 |
| 3.11 | Missing `MCP-Protocol-Version` → assume `2025-03-26` | SHOULD | ✅ | SDK behaviour (not probed separately) |
| 3.12 | SSE resumability, event ids | MAY | N/A | no SSE streams |

## 4. Session management (2025-11-25)

| # | Requirement | Level | Status | Evidence |
|---|---|---|---|---|
| 4.1 | Session id assigned at initialization in `MCP-Session-Id` | MAY | ✅ | probe L1/T1; the shop issues a UUID, the gateway pairs it with its own client-facing id |
| 4.2 | Globally unique, cryptographically secure | SHOULD | ✅ | `randomUUID` (shop); 196-character gateway id (probe T1) |
| 4.3 | Visible ASCII only (0x21–0x7E) | MUST | ✅ | probe T1 |
| 4.4 | Requests without a session (other than initialize) → 400, for servers that require sessions | SHOULD | ✅ | probe T7 (gateway) |
| 4.5 | Terminated or unknown session → 404 | MUST | ✅ | probe S1; lab A1; unit |
| 4.6 | DELETE terminates the session, or 405 | MAY | ✅ | probe S1 (202, then 404) |
| 4.7 | Verify all inbound requests; sessions are not authentication | MUST | ✅ | every request re-validates its token; unit |
| 4.8 | Secure, non-deterministic session ids | SHOULD | ✅ | 4.2 |
| 4.9 | Bind sessions to user-specific information | SHOULD | ✅ | lab A7; unit (a session is bound to its first customer; any other principal → 404) |

## 5. Server features

### 5.1 Tools (2025-11-25)

| # | Requirement | Level | Status | Evidence |
|---|---|---|---|---|
| 5.1.1 | Declare the `tools` capability | MUST | ✅ | probe X1 |
| 5.1.2 | `listChanged` reflects whether the server emits list-changed notifications | (semantics) | ⚠️ | declared `true` (SDK default), but the tool list never changes and no notification is sent |
| 5.1.3 | Tool names 1–128 chars from `[A-Za-z0-9_.-]`, unique | SHOULD | ✅ | probe X2 (`product_search`, `add_to_cart`, `view_cart`, `remove_from_cart`, `one_step_checkout`, `list_orders`) |
| 5.1.4 | `title`, `description` | optional | ✅ | all six tools |
| 5.1.5 | `inputSchema` is a valid JSON Schema object | MUST | ✅ | probe X3 (draft-07, declared via `$schema`) |
| 5.1.6 | No-argument tools: `{"type":"object","additionalProperties":false}` | recommended | ⚠️ | probe X4: `view_cart`, `one_step_checkout` emit `{"type":"object","properties":{}}` |
| 5.1.7 | `outputSchema`; if present, results conform | optional / MUST if present | N/A | not provided; `structuredContent` is returned without a schema |
| 5.1.8 | Structured content also serialised in a TextContent block | SHOULD | ✅ | probe X7 |
| 5.1.9 | Annotations (hints) | optional | ✅ / ⚠️ | read-only, destructive, idempotent and open-world hints on five tools; `add_to_cart` has none |
| 5.1.10 | Unknown tool → protocol error (`-32602`) | spec error class | ⚠️ | probe X5: returned as a tool result with `isError: true` and text `MCP error -32602` (SDK behaviour) |
| 5.1.11 | Input validation errors → tool execution error (`isError`) | 2025-11-25 | ✅ | probe X6 |
| 5.1.12 | Business errors → `isError` with actionable text | SHOULD | ✅ | unit (empty cart, limits, declined, cooling-off) |
| 5.1.13 | Validate all tool inputs | MUST | ✅ | zod schemas (lengths, ranges); domain checks; unit |
| 5.1.14 | Proper access controls | MUST | ✅ | scopes per tool; human approval for purchases; customer-scoped carts and orders; unit and lab C1–C3 |
| 5.1.15 | Rate limit tool invocations | MUST | ✅ | gateway and server rate limits per client address; lab G1 |
| 5.1.16 | Sanitise tool outputs | MUST | ✅ | third-party text normalised and stripped of invisible/control/bidi characters, length-capped, marked `contentTrust: third-party`; unit |
| 5.1.17 | Human in the loop able to deny tool invocations | SHOULD (applications) | ✅ exceeded | independent of the client: purchases need the customer's approval on the shop's page |
| 5.1.18 | Pagination of `tools/list` | MAY | N/A | six tools |

### 5.2 Other server features

| Feature | Status |
|---|---|
| Resources, prompts, completions, logging, tasks | N/A: not offered, not declared |
| Elicitation, sampling, roots (server → client) | N/A: not used; the approval link is returned in the tool result (see 8.4) |

## 6. Authorization (2025-11-25 and current)

### 6.1 MCP server as OAuth resource server

| # | Requirement | Level | Status | Evidence |
|---|---|---|---|---|
| 6.1.1 | Protected Resource Metadata (RFC 9728) with `authorization_servers` | MUST | ✅ | probe A1 |
| 6.1.2 | 401 with `WWW-Authenticate` carrying `resource_metadata` | MUST | ✅ | probe A3 |
| 6.1.3 | `scope` in the challenge (least privilege) | SHOULD | ✅ | probe A3 (`shop:api ecommerce:checkout` for checkout) |
| 6.1.4 | Validate access tokens (OAuth 2.1 §5.2): signature, issuer, expiry | MUST | ✅ | unit; lab A5 |
| 6.1.5 | Token issued specifically for this server (audience) | MUST | ✅ | `aud` must equal the resource URL; Keycloak lacks RFC 8707, so the audience comes from the `shop:api` scope; lab C4 |
| 6.1.6 | Invalid or expired token → 401 | MUST | ✅ | probe A4 |
| 6.1.7 | Insufficient scope → 403 `insufficient_scope` with the needed scopes | SHOULD | ✅ | unit |
| 6.1.8 | Accept only own tokens; never pass tokens through | MUST / MUST NOT | ✅ | audience check; the server calls no upstream API with client tokens |
| 6.1.9 | Tokens only in the `Authorization` header, not the query string | MUST | ✅ | probe A5 |
| 6.1.10 | `scopes_supported` minimal (scope minimisation) | SHOULD | ⚠️ deliberate deviation | Sign-in first (default since 2026-10-26) advertises `["shop:api","ecommerce:checkout"]` so clients sign in and consent once; few clients do step-up and Keycloak refuses step-up to a scope not registered ([report](CLIENT-COMPATIBILITY-REPORT.md), SECURITY-POSTURE S25). `REQUIRE_SIGN_IN=false` restores `["shop:api"]` + step-up. Probe A2 checks whichever mode is deployed |
| 6.1.11 | No `offline_access` in `scopes_supported` or challenges | SHOULD NOT | ✅ | probe A2, A3 |
| 6.1.12 | Account for scope hierarchies | MUST | N/A | flat scopes |
| 6.1.13 | Sender-constrained tokens (DPoP, RFC 9449) | beyond spec | ✅ supported | bound tokens require a proof; Bearer downgrade refused; unit |

### 6.2 Authorization server (platform: Keycloak 26.8, realm `mcp`)

| # | Requirement | Level | Status | Evidence |
|---|---|---|---|---|
| 6.2.1 | OAuth 2.1 for public and confidential clients | MUST | ✅ | PKCE required for public clients; implicit and password grants refused (lab D2, D5) |
| 6.2.2 | Metadata discovery (RFC 8414 or OIDC) with `code_challenge_methods_supported` | MUST | ✅ / ⚠️ | OIDC discovery; methods `["plain","S256"]`: `plain` is still advertised (refused for public clients by policy) |
| 6.2.3 | Client ID Metadata Documents | SHOULD | ❌ | not supported by the platform's Keycloak; dynamic registration (MAY, deprecated in 2026-07-28) is used |
| 6.2.4 | Short-lived access tokens; rotate refresh tokens for public clients | SHOULD / MUST | ✅ | 5-minute access tokens; rotation with reuse refused (lab H1) |
| 6.2.5 | All authorization-server endpoints over HTTPS | MUST | ❌ lab | HTTP on `localhost:8000` via the gateway (lab only) |
| 6.2.6 | Redirect URIs are localhost or HTTPS | MUST | ✅ | |
| 6.2.7 | Exact redirect-URI matching | MUST | ⚠️ | dynamically registered clients: exact; the platform's test client uses `http://localhost:*` and `http://127.0.0.1:*` wildcards |
| 6.2.8 | `iss` in authorization responses (RFC 9207), advertised | SHOULD | ✅ | `authorization_response_iss_parameter_supported: true` |
| 6.2.9 | Display the redirect-URI hostname; warn on localhost-only clients | MUST / SHOULD (CIMD) | N/A | no CIMD |

## 7. Security best practices

| # | Topic | Status | Notes |
|---|---|---|---|
| 7.1 | Confused deputy (proxy servers with static client ids) | N/A | not a proxy to third-party APIs |
| 7.2 | Token passthrough | ✅ | 6.1.8 |
| 7.3 | SSRF | N/A | the server fetches no client-supplied URLs; the platform does not fetch client metadata (no CIMD) |
| 7.4 | Session / state-handle hijacking | ✅ | 4.7–4.9 |
| 7.5 | Local MCP server compromise | N/A | remote server |
| 7.6 | Scope minimisation | ⚠️ | 6.1.10: deliberate deviation in sign-in-first mode; step-up remains as a second line for tokens without the checkout scope |
| 7.7 | Server-owned consent page: identify the client, CSRF protection, anti-framing, state single-use ≤ 10 min, exact redirect | ✅ | the purchase-approval page (lab E1, E2; unit). Guidance written for proxy consent pages, applied by analogy |
| 7.8 | Consent cookies: `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite` | ⚠️ | `HttpOnly`; `SameSite=Strict`/`Lax`; `Secure` only when the public URL is HTTPS (lab is HTTP); no `__Host-` prefix (cookies are scoped to `Path=/approve`) |
| 7.9 | Authorization-URL validation, mix-up attacks | N/A (client side) | the platform emits RFC 9207 `iss` (6.2.8) |

## 8. Readiness for revision 2026-07-28

| # | Change in 2026-07-28 | Status | Work needed |
|---|---|---|---|
| 8.1 | Stateless protocol: no `initialize`, no `Mcp-Session-Id`; version and client info in each request's `_meta` | ❌ | SDK upgrade; anonymous carts move from the session id to an explicit cart handle (tool argument) bound to the caller |
| 8.2 | State handles never treated as authentication; bound to the authenticated user | ✅ design | customer state is keyed by the token's `sub` already; carry the session binding over to cart handles |
| 8.3 | `Mcp-Method` / `Mcp-Name` headers must match the body (`400`, `-32020 HeaderMismatch`) | ❌ | validate in the server (the gateway already sends these headers upstream) |
| 8.4 | Server → client interactions via MRTR (`InputRequiredResult`) | ❌ | return the approval link as a URL-mode elicitation input request instead of tool-result text |
| 8.5 | GET and DELETE on the MCP endpoint → 405 | ⚠️ | GET already 405; DELETE terminates sessions today |
| 8.6 | Unsupported version → 400 with `UnsupportedProtocolVersionError` listing supported versions | ❌ | SDK upgrade |
| 8.7 | CIMD preferred; dynamic registration deprecated | ❌ platform | 6.2.3 |
| 8.8 | RFC 9207 `iss` validation by clients; authorization servers emit `iss` | ✅ platform | 6.2.8 |

## 9. Deviations and remediation

| Priority | Finding | Requirement | Owner | Fix |
|---|---|---|---|---|
| 1 | The shop alone accepts JSON-RPC batches under 2025-11-25 | 3.5 | shop | refuse arrays when `MCP-Protocol-Version` ≥ `2025-06-18` (400, no `id`); the gateway already refuses |
| 2 | Authorization server over HTTP | 6.2.5 | platform | TLS for Keycloak and the gateway (cert-manager) |
| 3 | Test client redirect URIs use wildcards | 6.2.7 | platform | exact URIs for the clients that use it (e.g. `http://localhost:53682/callback`, `http://localhost:6274/oauth/callback`) |
| 4 | Unknown tool reported as a tool result, not a protocol error | 5.1.10 | shop (SDK behaviour) | answer unknown tool names with a JSON-RPC `-32602` error before handing the call to the SDK |
| 5 | Gateway answers unknown methods with HTTP 500 / `-32603` | 2.6 | platform (agentgateway) | report upstream; the shop itself answers `-32601` |
| 6 | No-argument tools omit `additionalProperties: false` | 5.1.6 | shop | strict empty input schemas for `view_cart`, `one_step_checkout` |
| 7 | `tools.listChanged: true` without notifications | 5.1.2 | shop | declare `listChanged: false` |
| 8 | `add_to_cart` has no annotations; no `outputSchema` anywhere | 5.1.7, 5.1.9 | shop | add hints; publish output schemas for the structured results |
| 9 | `plain` PKCE advertised; no CIMD | 6.2.2, 6.2.3 | platform | drop `plain`; CIMD via the identity provider or a front-end |
| 10 | Approval cookies without `__Host-`/`Secure` | 7.8 | shop | `__Host-` prefix with `Path=/` and `Secure`, once served over HTTPS |
| 11 | Revision 2026-07-28 | §8 | shop + platform | migrate when the SDK and clients support it |

Deliberate deviation: anonymous access to browsing and carts (3.4) is part of the product, not a gap. It is bounded
and cannot reach money or account data.

## 10. Reproduce

```bash
scripts/mcp-compliance-probe.sh                         # protocol, transport, tools, authorization probes (live gateway)
npm test                                                # unit and in-process tests, incl. attack cases
TEST_USER_PASSWORD=… npm run test:attack                # live attack lab (A6 Origin, A7 session binding, C4 audience, …)
curl -s localhost:8000/realms/mcp/.well-known/openid-configuration | python3 -m json.tool   # 6.2.2, 6.2.8
```

Last probe run: 22 pass, 3 findings (T9 gateway, X4, X5). Server-alone batch check: accepted (finding 1).

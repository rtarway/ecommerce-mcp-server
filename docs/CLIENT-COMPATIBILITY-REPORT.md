# MCP client compatibility report: shop MCP server

*2026-10-22 · POC, local lab (Rancher Desktop) · evidence: [HARNESSES.md](HARNESSES.md) (runbook, catalogue CC-1 to CC-11)*

## Summary

We tested real MCP clients against a deliberately "anonymous first" shop: anyone can browse and fill a cart without
signing in; signing in is needed only to buy or see orders, and every purchase is approved by the customer on a web
page.

Today's agent clients browse anonymously and buy once the customer is signed in, but none moves cleanly from anonymous
browsing to a signed-in purchase in one conversation. The evidence supports the opposite design: **require sign-in
when an agent first connects, with every scope at once.**
- Every agent client tested can sign in that way.
- It removes mid-session sign-in, step-up and lost carts.
- It costs anonymous discovery.
- Antigravity and claude.ai additionally need fixes to the identity provider's registration rules.

## Implementation results (2026-10-26)

R1–R7 are implemented and running (plan: [plans/SIGN-IN-ON-CONNECT.md](plans/SIGN-IN-ON-CONNECT.md)).
`REQUIRE_SIGN_IN=false` restores the anonymous-first design (verified).

| Client | One sign-in, then browse, cart, approval, order | After its client is retired | Next day (sign-in session ended) |
|---|---|---|---|
| Claude Code 2.1.308 | ✅ prompts the customer itself (`/mcp`) | "Needs authentication"; tells the customer how; `/mcp` recovers | ✅ offline token, no sign-in |
| Codex 0.163.0 | ✅ after `codex mcp login shop` (does not start it on the 401) | Shop silently unavailable; `codex mcp login shop` recovers | ✅ offline token, no sign-in |
| OpenClaw 2026.10.3 | ✅ after `openclaw mcp login shop`; first full OpenClaw purchase | Status still "authorized", agent guesses; `openclaw mcp login shop` recovers | ❌ no offline token: sign in again |
| MCP Inspector | ✅ | — | — |
| Hermes | not run (needs a model provider key) | — | — |

- **Several agents, one cart:** Codex and Claude Code filled one customer cart. OpenClaw checked it out with one
  approval, and the approval page named the app behind each line.
- **Codex registration:** with internal scopes no longer advertised, Codex registers without any scope
  configuration (F5 fixed for that client).
- **Security:** the attack lab holds 29 of 30 scenarios (D4 as before). Three new findings:
  - one flaw fixed: the session-manager trusted the client's `X-Forwarded-For`;
  - one risk accepted and recorded: a client that refreshes twice in parallel signs its customer out everywhere;
  - one residual: a retired client's last access token works for up to 5 minutes.

## 1. The shop MCP server in brief

| Area | Design |
|---|---|
| **Tools** | `product_search`, `add_to_cart`, `view_cart`, `remove_from_cart` (anonymous); `one_step_checkout`, `list_orders` (need sign-in with scope `ecommerce:checkout`) |
| **Protocol** | MCP 2025-11-25, Streamable HTTP, stateful sessions; Origin allow-list and host-name checks (DNS rebinding); sessions bound to the first customer that uses them |
| **Sign-in** | OAuth 2.1 with PKCE through Keycloak. Clients discover it from the shop's protected-resource metadata (RFC 9728) and register themselves (dynamic client registration, loopback redirect addresses only). The shop advertises only `shop:api`; checkout asks for `ecommerce:checkout` with a `403 insufficient_scope` challenge (step-up). Tokens are checked at the gateway and again in the shop |
| **Purchases** | Every checkout returns an approval link. The customer signs in again on that page (`prompt=login`), sees the exact cart and approves; the order is placed then. A per-customer spending mandate (default $0) can let small purchases skip approval. Limits: $500 per order, $1,000 per day |
| **Carts** | Anonymous cart kept per MCP session; moved into the customer's cart when the customer's token arrives on that same session |
| **Theft response** | A session-manager behind the gateway tracks each linked app (customer, client, Keycloak session); refresh-token reuse ends all the customer's sessions and requires a new sign-in |
| **Platform** | Shared agentgateway (one origin, `localhost:8000`, for MCP and sign-in), Istio mesh with STRICT mTLS and identity-based authorisation, default-deny network policy, Keycloak realm with a security baseline, SPIRE installed. App teams onboard by declaring needs in a tenant file |

Details: [GUIDE.md](GUIDE.md) (architecture and decisions), [SECURITY-POSTURE.md](SECURITY-POSTURE.md),
[MCP-COMPLIANCE.md](MCP-COMPLIANCE.md).

## 2. What was tested

Each client was run on the Mac against the live stack and verified from the server side (gateway log, shop audit log,
session-manager, Keycloak events). The core test, run from a clean state:

1. Connect without signing in; search, add to cart, view cart.
2. Check out. The shop answers `401` with an OAuth challenge.
3. Sign in by whatever means the client offers; check out again.
4. Approve on the web page; list orders.

## 3. Results by client

| Client (version) | Browse + cart anonymously | Reaction to checkout's `401` | Sign in mid-session | Step-up (`403`) | Cart survives sign-in | Purchase completed |
|---|---|---|---|---|---|---|
| **MCP Inspector** (reference client) | ✅ | starts sign-in itself | ✅ automatic | not needed | ✅ | ✅ |
| **Claude Code** 2.1.308 | ✅ | agent tells the customer "run /mcp and sign in" | ✅ customer runs `/mcp` → Authenticate | ✅ attempted correctly; refused by Keycloak, second sign-in needed | ❌ (agent re-added the item) | ✅ after **two** sign-ins |
| **Codex CLI** 0.163.0 | ✅ | "Authentication required"; agent asks the customer to sign in, without saying how | ✅ customer runs `/mcp login shop` (scopes must be configured) | not exercised | ❌ cart empty after sign-in | ✅ (sign-in first, or after `/mcp login` with the cart rebuilt) |
| **OpenClaw** 2026.10.3 | ✅ only without OAuth configured | error; agent offered to edit its config or take a pasted token | ❌ | ❌ asks for a new login | n/a | ✅ only when signed in before the session |
| **Hermes Agent** 0.21.7 | ✅ only without OAuth configured | error | ❌ (signs in only if *connecting* returns `401`) | not reached | n/a | ❌ with this shop's design |

Researched, not yet run:

| Client | Expected behaviour (from source or docs) |
|---|---|
| **Gemini CLI** 0.65.0 | Like Codex: anonymous browsing works; sign-in only via `/mcp auth`; a tool-call `401` or `403` becomes a tool error |
| **Google Antigravity** | Registration likely refused: it registers a hosted callback (`https://antigravity.google/oauth-callback`), and the realm only accepts loopback redirects |
| **claude.ai / Claude Desktop connectors** | Run from Anthropic's cloud: cannot reach a local server; need a public HTTPS endpoint and a hosted callback (`https://claude.ai/api/mcp/auth_callback`) |

## 4. Findings

**F1. No agent client signs in on its own when a tool call returns `401`.** Only MCP Inspector does. Claude Code and
Codex let the customer start a sign-in inside the session; OpenClaw and Hermes cannot sign in mid-session at all.
Anonymous browsing followed by an automatic sign-in at checkout does not exist in today's agent clients.
*(CC-1, CC-7, CC-8)*

**F2. The anonymous cart is lost at sign-in.** Clients open new MCP sessions after signing in, and the shop keeps
anonymous carts per session. Seen with Codex and Claude Code. The next MCP revision (2026-07-28) removes protocol
sessions entirely, so session-bound state will not survive it either. *(CC-10)*

**F3. Two sign-ins for one purchase.** The shop advertises only `shop:api` (scope minimisation), so clients sign in for
browsing scope first. At checkout, Claude Code's correct step-up was refused because Keycloak locks a self-registered
client to the scopes it registered with; the client had to register again. *(CC-11)*

**F4. The error text decides what the customer does next.** Claude Code told the customer exactly what to do; Codex
said only "Authentication required"; OpenClaw's agent offered to edit its own configuration or accept a pasted
token, which teaches customers to paste secrets into chats. *(CC-2, CC-7)*

**F5. Registration rules exclude some clients.**
- Codex, without configured scopes, requests every scope Keycloak advertises, including internal ones that
  registration refuses *(CC-9)*.
- Hosted-callback clients (Antigravity, claude.ai) cannot register under a loopback-only policy *(CC-5, CC-6)*.

**F6. Sign-in must live on the MCP server's origin.** OpenClaw refuses OAuth requests to a different private
address. Fixed during testing by publishing Keycloak through the shared gateway (decision D21). *(CC-4)*

**F7. Shared credentials.** OpenClaw by default uses one signed-in account for everyone who can message the bot.
Purchases still need the account owner's approval, but orders and carts are shared. *(Q5)*

**What held up:**
- PKCE, consent and the approval page behaved as designed with every client.
- No client could buy without the customer's own approval.
- Spec-level controls passed throughout (22 of 25 checks).

## 5. Evaluation: sign in on first connect

The hypothesis holds: every agent client tested completed a purchase whenever the customer signed in before shopping,
and a connect-time `401` is the one sign-in trigger all of them handle. To reach every client it needs both scopes
up front and the registration fixes, and it gives up anonymous discovery.

| Client | How it signs in before use | Evidence | With sign-in first and both scopes |
|---|---|---|---|
| MCP Inspector | Automatically on `401` | Tested | Works |
| Claude Code | `/mcp` → Authenticate; reconnects with the token | Tested: browse, cart and checkout all signed in, cart kept across reconnects; step-up only because one scope was advertised | Works, one sign-in |
| Codex | `codex mcp login`, or `/mcp login` in the session | Tested: signed in first, two orders placed | Works; needs scopes in its config until registration is fixed |
| OpenClaw | Operator runs `openclaw mcp login`, or a per-sender chat link | Sign-in and signed-in connection tested; full purchase not run (model billing) | Works; one shared account by default |
| Hermes | Only on a `401` when connecting (its single trigger) | Source code; not yet run | Should work: this is the trigger it needs |
| Gemini CLI | `/mcp auth` after a connect-time `401` | Source code | Should work |
| Antigravity, claude.ai | — | Registration refused (hosted callbacks) | Still blocked until the registration fix |

**What it fixes:**
- **F1, mid-session sign-in:** never needed.
- **F2, lost carts:** a signed-in cart belongs to the customer, not the MCP session, so reconnects keep it (verified
  with Claude Code).
- **F3, step-up:** with both scopes granted at connect, checkout never asks for more.
- **Mandates:** every agent carries a token, so purchases within the customer's mandate need no approval page.
- **Behaviour signal:** every request is tied to a customer and an app from the first call, which also strengthens
  theft detection.

**What it costs, and what stays open:**
- **No anonymous discovery.** An agent comparing shops must sign in to each before it sees a product. Mitigation: an
  optional read-only catalog endpoint.
- **Every token can buy from the first minute.** With a mandate above $0, a stolen token can spend up to the mandate
  without approval, so keep mandates small. Above the mandate the approval page still protects the customer.
- **Browsing becomes personal data.** State it in the consent text, set a retention limit, and use it for service and
  security.
- **More registrations.** Every install registers a client and signs in. Production needs Client ID Metadata Documents
  or allow-listed vendors anyway.
- **Spec position.** Requiring authorization for every request is allowed. Advertising both scopes departs from the
  scope-minimisation SHOULD and should be recorded as deliberate.
- **Not yet verified.** Hermes, Codex and Gemini CLI against a connect-time `401` (the shop never sends one today),
  and a full OpenClaw purchase. One run each after the change confirms it.

## 6. Proposed flow, evaluated

The proposed flow is sound and mostly built already. Four corrections:
- the `401` points to metadata rather than registration URLs;
- an agent is identified by customer, client and sign-in session together, not by client ID;
- returning without a sign-in needs an offline token;
- 30-day expiry of consent and clients needs a scheduled job, because Keycloak has neither.

| Step | Proposed | Evaluation |
|---|---|---|
| 1. Connect | Harness calls the shop; the shop answers `401` with `WWW-Authenticate` | Correct with R1. The header carries the protected-resource metadata link and the scopes; the client follows it to the authorization server's metadata, which names the registration endpoint (and would say whether CIMD is accepted). `403` is only for a valid token missing a scope, which cannot happen once both scopes are granted at sign-in |
| 2. Register | DCR or CIMD gives the harness a client ID | DCR only for now: our Keycloak 26.8 does not offer Client ID Metadata Documents (CIMD). A DCR client ID is one per install; a CIMD client ID is the vendor's URL, shared by every install of that harness. DCR client names are self-declared, so a look-alike app can register (attack D4) |
| 3. Sign in and consent | PKCE flow; the customer signs in and consents in a browser | Built and verified with every client. Works on the same machine, and remotely through OpenClaw's per-sender links. Sign-in without a browser (device code) is blocked by the realm's PKCE rule today |
| 4. Tokens | Access and refresh token | Access tokens last 5 minutes. A normal refresh token dies with the sign-in session (30 minutes idle, 10 hours at most); only an **offline** token (scope `offline_access`) survives to the next day. Codex and Claude Code asked for one; each harness must be checked |
| 5. Bind | Shop creates a session and binds the customer to the client ID, the agent's ID | Built: each MCP session is bound to its first customer, and the session-manager records every linked app as customer + client ID + Keycloak session. Use that triple as the agent ID: client ID alone is not unique under CIMD or after re-registration. MCP sessions disappear in the 2026-07-28 revision, so bindings should rest on token claims |
| 6. Return | Same path; the stored client ID and refresh token avoid a new sign-in | Works within the offline-token lifetime; every refresh returns a new refresh token and retires the old one |

### Token and client lifecycle

| Control | Proposed | In the lab today | Still needed |
|---|---|---|---|
| Single-use refresh tokens | Yes | Built: rotation on, no reuse allowed. A reused token ends all of the customer's sessions within 60 seconds (verified, attack H1) | Watch clients that refresh in parallel: a race looks like theft and signs the customer out everywhere. Codex and OpenClaw serialise refreshes; Claude Code ran 8 refreshes in 2 seconds without error. Test under load |
| Session lifetime | 30 days | Built: offline sessions end after 30 days, or 7 days unused | Decide whether the 7-day idle limit stays (a weekly shopper would sign in again) |
| Consent expiry | 30 days | Not available: Keycloak keeps consent until revoked, so a sign-in after 30 days skips the consent screen | Scheduled job (session-manager, admin API) revoking consents older than 30 days; revoking also ends that client's offline tokens |
| Client retirement | 30 days | Not available: Keycloak clients never expire; the realm baseline has a manual prune only | Scheduled job deleting self-registered clients 30 days after registration; deleting a client ends its tokens and consent in one step. CIMD client IDs belong to the vendor and cannot be retired: expire consent and sessions instead |
| Recovery after retirement | Harness starts over | Observed: Codex kept refreshing a deleted client (`client_not_found`) instead of registering again | Test each harness. Where it does not recover by itself the customer must sign out and in again, and the error text must say so |

One 30-day clock is enough: the offline session, the consent and the client all end 30 days after sign-in or
registration, whichever comes first.

### Several agents for one customer

There is nothing to merge: a signed-in cart already belongs to the customer, so every agent of that customer reads and
writes the same cart.
- **One cart, whole-cart checkout.** Checkout buys the whole customer cart, whichever agent asks. Two agents checking
  out the same cart buy it once (idempotent by cart contents).
- **Mandate.** One budget per customer per window, checked atomically against the whole cart plus that window's
  spending. It is set to $0, so every purchase needs approval.
- **Risk: one agent buys another agent's items.** Tag each cart line with the agent that added it, and show it in
  `view_cart` and on the approval page, so the customer can remove what they did not ask for before approving.
- **Identity per agent.** Different harnesses get different client IDs; two installs of one harness are told apart by
  their Keycloak session.

## 7. Recommendations

Adopt sign-in on first connect with both scopes (R1, R2), which is a small server change. Add the registration fixes
(R3) to reach hosted clients.

| # | Change | Why |
|---|---|---|
| R1 | **Require sign-in on connect.** `initialize` without a valid token returns `401` with the resource-metadata link and scope `shop:api ecommerce:checkout` | The one trigger every client handles (Hermes relies on it); carts, mandates and browsing follow the customer from the first call |
| R2 | **Advertise both scopes** in the protected-resource metadata and in every challenge | One sign-in and one consent; no step-up, which only Claude Code attempts and Keycloak refuses |
| R3 | **Platform: fix registration rules.** Stop advertising internal scopes; let registered clients request any allowed scope later; offer CIMD when the identity provider supports it, or pre-register hosted-callback clients; public HTTPS origin in production | Codex without scope config; Antigravity; claude.ai |
| R4 | **Make the connect-time error say how to connect** ("sign in to the shop in your app's MCP settings"), including after a retired client; no text ever asks for a password or token | Codex shows only "Authentication required"; OpenClaw's agent asked for a pasted token |
| R5 | **Browsing-data policy:** named in the consent text, retention limit, used for service and security | Behaviour tracked per customer is personal data |
| R6 | **One 30-day clock.** Scheduled job: revoke consents and delete self-registered clients 30 days after sign-in or registration; offline sessions already end at 30 days | Keycloak has no consent or client expiry; forces a periodic fresh start, as proposed |
| R7 | **Attribute cart lines to agents.** Record which agent added each line; show it in `view_cart` and on the approval page | With one shared cart per customer, the customer must see what each agent added before approving |
| R8 | *Optional:* an anonymous **read-only catalog endpoint** (`product_search` only, no carts) | Keeps agent discovery and price comparison without sign-in |

Keep the approval page above the mandate, small mandates and the theft response. With sign-in first every token can
buy, so these remain the money controls.

**Alternative, only if anonymous shopping is a business requirement:**
- identify the customer on the approval page for anonymous checkout (D-e);
- give carts a handle that survives sign-in (D-f).

Both are written up in [HARNESSES.md](HARNESSES.md). They reach the same clients with more server work.

### Expected result

| Client | Today | With R1–R4 |
|---|---|---|
| MCP Inspector | Works | Works |
| Claude Code | Two sign-ins; cart lost | One sign-in at connect; cart kept |
| Codex | Sign in first, or cart lost | One sign-in (`/mcp login`) |
| Gemini CLI | Predicted like Codex | One sign-in (`/mcp auth`) |
| OpenClaw | Only if signed in before the session | Operator or chat-link sign-in; works (shared account by default) |
| Hermes | Fails | Signs in on connect; works (to verify) |
| Antigravity, claude.ai (public deployment) | Registration fails | Works after R3 |

*Next steps:*
- Implement R1 and R2.
- Re-run every client from a clean state.
- Confirm that Hermes, Codex and Gemini CLI react to the connect-time `401` as their source code suggests.
- Test parallel refreshes, and each harness's recovery from a retired client.

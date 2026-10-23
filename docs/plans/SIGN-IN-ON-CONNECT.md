# Plan: sign in on first connect

*Approved 2026-10-23 (Q1–Q5: recommendations accepted) · implements recommendations R1–R7 of [CLIENT-COMPATIBILITY-REPORT.md](../CLIENT-COMPATIBILITY-REPORT.md)*

**Goal:** every MCP client signs the customer in when it first connects, with both scopes and one consent; after that,
browsing, cart and checkout work without another sign-in. One cart per customer is shared by all of their agents and
shows which agent added each line. Consent and self-registered clients expire after 30 days. Every purchase needs
approval (mandate $0).

**Done when:**
- the automated suites pass (unit, e2e, attack lab, compliance probe);
- each harness completes the journey from a clean state;
- the report and runbook are updated with the re-test results.

Sizes: S ≈ half a day, M ≈ 1–2 days, L ≈ 3+ days (POC pace). Repos: **app** = ecommerce-mcp-server,
**infra** = mcp-ecosystem-infra.

## Decisions (approved: the recommendation column)

| # | Question | My recommendation |
|---|---|---|
| Q1 | Keep a config switch `REQUIRE_SIGN_IN` (default on), so the anonymous mode can be turned back on for comparison until the re-test is done? | Yes; remove the anonymous path in S5 after the re-test |
| Q2 | Keep the 7-day idle limit on offline sessions? (A weekly shopper signs in again) | Keep 7 days for the POC; revisit with production data |
| Q3 | Where does the 30-day expiry job run? | Platform (infra): self-registered clients and consents are realm-wide, not owned by the shop |
| Q4 | Build the anonymous catalog endpoint (R8) now? | No; backlog |
| Q5 | Agent name shown on cart lines: the client's self-declared MCP name plus its client ID? | Yes; labelled "as the app calls itself" (not verified) |

## Prerequisite

Returning to today's behaviour at any time: set `REQUIRE_SIGN_IN=false` (S1), or check out the tag
`pre-sign-in-on-connect` in both repositories (the state after S0).

**S0. Commit the pending gateway sign-in changes** (D21: Keycloak on the gateway origin) · app + infra · S
- [ ] app: commit deploy config, tests, scripts and docs changed for D21
- [ ] infra: commit `modules/auth-route`, Keycloak hostname/proxy changes, realm-baseline trusted-hosts change, docs
- [ ] push both (on a branch, or `main` if you prefer)

## Milestone 1: sign in on connect (validates the design early)

**S1. Require a valid token to connect (R1)** · app · M
- [ ] `config/shop.ts`: `REQUIRE_SIGN_IN` (boolean, default `true`)
- [ ] `http/app.ts`: any MCP request without a valid token → `401` with `WWW-Authenticate: Bearer resource_metadata=…, scope="shop:api ecommerce:checkout"`, before a session is created; invalid or revoked token → `401 invalid_token` (unchanged). Protected-resource metadata and `/approve` stay public
- [ ] keep the gateway policy *Permissive* (the shop, not the gateway, must send the challenge clients understand)
- [ ] unit tests: no token → 401 + header; valid token → session created; switch off → today's behaviour

*Accepted when:* `initialize` without a token returns 401 with both scopes, and a signed-in client connects and browses.

**S2. Advertise both scopes (R2)** · app · S
- [ ] protected-resource metadata `scopes_supported: ["shop:api", "ecommerce:checkout"]`; every challenge names both
- [ ] keep the `403 insufficient_scope` check on `one_step_checkout` / `list_orders` as a second line (tokens from old sign-ins)
- [ ] unit tests updated

*Accepted when:* a fresh client signs in once and can check out with no step-up.

**S3. Error text that tells the customer what to do (R4)** · app · S
- [ ] `error_description` for "not signed in": "Connect your shop account: sign in to the shop in your app's MCP settings."
- [ ] for an ended, revoked or retired sign-in: "Your shop sign-in has ended. Sign out of the shop in your app, then sign in again."
- [ ] server instructions and tool texts: never ask the customer for a password or token (review all strings)
- [ ] unit tests on the texts

**S10a. Core test updates** · app · M
- [ ] e2e: sign in first, then search, cart, checkout, approve, list orders (replaces the anonymous step-up test)
- [ ] attack lab: scenarios that connected anonymously now expect 401 at connect (A1, A2, A6, A7, G1 …); B-series sign in first
- [ ] compliance probe: new check "connect without token → 401 + challenge"; session-level checks obtain a token first
- [ ] `scripts/inspector-smoke.sh` adjusted

**S11a. Early harness check** · you run, I verify · M
- [ ] Hermes with `auth: oauth`: does the connect-time 401 start its sign-in? (the open question behind the design)
- [ ] Codex and Claude Code: one sign-in, then browse → cart → checkout → approve
- [ ] record results in HARNESSES.md

**Gate:** if Hermes or Codex do not sign in on a connect-time 401, stop and revisit before Milestone 2.

## Milestone 2: several agents, one cart

**S4. Attribute cart lines to agents (R7)** · app · M
- [ ] `domain/cart.ts`: each line records who added it (client ID + the app's self-declared MCP name from `initialize`); the same product added by two agents keeps both names
- [ ] `view_cart` shows "added by" per line; the approval page lists it per line
- [ ] the approval hash covers products and quantities only, so attribution alone never invalidates an approval
- [ ] unit tests (cart, approval page)

*Accepted when:* two harnesses add to one customer's cart and the approval page shows which added what.

**S6. Browsing record and consent text (R5)** · app (+ tenant file) · S
- [ ] audit event `browse` (customer, client ID, linked app, tool, search text, time) for `product_search`, `add_to_cart`, `remove_from_cart`
- [ ] consent text of `shop:api` in `platform/tenant.yaml` says browsing is recorded for service and security
- [ ] document the retention rule (POC: in memory; production: a fixed limit, e.g. 90 days)

## Milestone 3: platform lifecycle

**S7. Registration rules (R3)** · infra · M
- [ ] hide internal scopes from the authorization-server metadata (client-scope setting "include in OpenID provider metadata" off for `service_account`, `microprofile-jwt`, `address`, `phone`, `organization` …)
- [ ] verify Codex registers with no `scopes` in its config
- [ ] spike (time-boxed, S): can Keycloak 26.8 let a self-registered client request an allowed scope it did not name at registration? Write up the result
- [ ] spike (time-boxed, S): Client ID Metadata Document support in Keycloak 26.x. Write up; no build
- [ ] document the production path for hosted callbacks (pre-registered clients via tenant file); not built locally

**S8. 30-day expiry job (R6)** · infra · M
- [ ] platform CronJob (daily) with its own Keycloak service account (view-users, manage-users, manage-clients, view-events); not available to tenants
- [ ] revoke consents older than N days (consent records carry dates)
- [ ] delete self-registered clients older than N days. Keycloak stores no creation date, so the job stamps a first-seen attribute on each new client and ages from that. Clients owned by tenants and built-in clients are never touched
- [ ] dry-run mode, one audit line per action, N configurable (minutes in the lab for testing)
- [ ] test with N = 10 minutes: consent gone, client gone, the client's tokens refused

**S9. Token settings review** · infra · S
- [ ] confirm `offline_access` stays allowed for self-registered clients; apply the Q2 decision
- [ ] document the lifetimes: access 5 min; sign-in session 30 min idle / 10 h; offline 7 days idle / 30 days

## Milestone 4: re-test, clean up, document

**S10b. New attack-lab scenarios** · app · M
- [ ] parallel refresh: two refreshes with one refresh token at once. Expect the theft response; record how a real client would trigger it
- [ ] retired client: sign in, run the expiry job, then call again. Expect 401 with the re-sign-in text
- [ ] cart attribution: a second app's line is visible on the approval page

**S11b. Full harness re-test** · you run, I verify · L
- [ ] every client from a clean state: Inspector, Claude Code, Codex, Gemini CLI, OpenClaw (full purchase), Hermes
- [ ] per client: offline token issued? resume after the sign-in session has ended without a new sign-in? recovery after its client is retired?
- [ ] two harnesses at once on one cart (attribution, one approval for the whole cart)
- [ ] HARNESSES.md rows and the report's results updated

**S5. Remove the anonymous path** · app · S (after S11b)
- [ ] remove session-keyed carts and the claim-on-sign-in logic, the `REQUIRE_SIGN_IN` switch (Q1), and the session-manager's anonymous tier
- [ ] tests and attack lab updated

**S12. Documentation** · app + infra · S
- [ ] GUIDE: decision D22 (sign in on connect, both scopes), D23 (shared cart with attribution); S23 marked superseded
- [ ] SECURITY-POSTURE: new decisions for lifecycle and browsing data; attack vectors updated (anonymous traffic now stops at 401)
- [ ] MCP-COMPLIANCE: scope minimisation recorded as a deliberate deviation
- [ ] README quick start: sign in first; infra docs for the expiry job

## Not in this plan

- Anonymous catalog endpoint (R8)
- Public HTTPS deployment
- CIMD implementation (spike only)
- Device-code sign-in
- Moving to the 2026-07-28 MCP revision

## Risks

| Risk | Mitigation |
|---|---|
| Hermes does not react to the connect-time 401 as its source suggests | Milestone 1 gate tests it first |
| Clients refreshing in parallel trip theft detection and sign the customer out | S10b measures it; options are a short reuse grace in Keycloak or client guidance |
| Harnesses do not recover when their client is retired (Codex kept retrying) | S3 error text; S11b tests each; the job can run at a quiet hour |
| Keycloak keeps no client creation date | First-seen stamp in S8 |

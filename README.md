# ecommerce-mcp-server

Demo e-commerce MCP server (TypeScript / Node, official `@modelcontextprotocol/sdk`). A **proof of concept** for
letting AI agents shop for customers safely: the shop is a demo, and the platform it runs on
([`mcp-ecosystem-infra`](../mcp-ecosystem-infra)) is a local Rancher Desktop lab.

This repo is an **application team's** repo on that platform: it contains the MCP server, its Kubernetes and gateway
manifests, and [`platform/tenant.yaml`](platform/tenant.yaml), which declares what the server needs from the
platform (namespace, gateway paths, identity-provider scopes and clients). The platform team registers that file and
the platform creates everything with its own credentials; this repo holds none.

**Sign in on first connect** (default, `REQUIRE_SIGN_IN=true`): an agent's first request gets `401` with both scopes
(`shop:api ecommerce:checkout`); the customer signs in and consents once in their app, and every tool then works with
no further sign-in. All of a customer's agents share one cart, and each line names the app that added it.
`REQUIRE_SIGN_IN=false` restores the earlier anonymous-first design (browse without a token, step-up for checkout).
Why: [docs/CLIENT-COMPATIBILITY-REPORT.md](docs/CLIENT-COMPATIBILITY-REPORT.md).

| Tool | Auth | Behaviour |
|---|---|---|
| `product_search` | signed in (none if `REQUIRE_SIGN_IN=false`) | Search the catalog by words, category, max price |
| `add_to_cart` | signed in (none if `REQUIRE_SIGN_IN=false`) | Adds to the customer's shared cart, recording which app added the line |
| `view_cart` | signed in (none if `REQUIRE_SIGN_IN=false`) | Shows the cart with who added each line; exactly what checkout would buy |
| `remove_from_cart` | signed in (none if `REQUIRE_SIGN_IN=false`) | Removes a line or reduces its quantity (e.g. something the customer did not ask for) |
| `one_step_checkout` | customer login + consent, **and the customer's approval of each purchase** | Orders the cart with the address and card saved on the customer's profile |
| `list_orders` | customer login | The customer's recent orders (or one by id): order id, status, total, items |

**How buying works.** `one_step_checkout` without a token gets `401` + `WWW-Authenticate` (scopes
`shop:api ecommerce:checkout`); the client runs Authorization Code + PKCE against Keycloak; consent is asked once
per app. With the token, checkout returns an **approval link** instead of charging: the customer signs in again on
the shop's own page, sees exactly what is bought, and clicks **Approve and pay**, which places the order and shows
its id. The agent confirms with `list_orders` (or `one_step_checkout` again, which returns the same order). Orders are idempotent and
capped. A stolen token or an injected prompt can fill a cart but cannot spend money. A **spending mandate** on the
customer's account (an amount per 24 h, shared by all their clients and devices; 0 today) lets small purchases skip
approval; see [GUIDE.md](docs/GUIDE.md#3-design-decisions-and-why) (D12) and [how to change it](docs/GUIDE.md#46-change-the-spending-mandate).

Also in this repo: the **session-manager** (gateway extAuth: tracks each app installation, ends every session of a
customer when a stolen refresh token is replayed) and the **attack lab** (`test/attack/`), which plays each kind of
MCP client against the live stack.

Docs: [GUIDE.md](docs/GUIDE.md) (setup, architecture, Inspector walkthrough, troubleshooting),
[SECURITY-POSTURE.md](docs/SECURITY-POSTURE.md) (attack vectors and mitigations),
[MCP-COMPLIANCE.md](docs/MCP-COMPLIANCE.md) (compliance with the MCP specification),
[ATTACK-RESULTS.md](docs/ATTACK-RESULTS.md) (latest lab run). The original review is in [docs/archive](docs/archive).

## Develop

```bash
npm ci
npm run check          # typecheck + lint (Biome) + 182 unit/in-process tests; what CI runs, plus the build
npm run test:coverage
npm run dev            # needs ISSUER, JWKS_URL, RESOURCE_URL, PUBLIC_BASE_URL (or REQUIRE_APPROVAL=false); see src/config/shop.ts
npm run build          # dist/bin/shop.js, dist/bin/session-manager.js
```

### Project structure

```
src/                      production code only (compiled to dist/)
  bin/                    process entry points: shop.ts, session-manager.ts (wiring only)
  config/                 environment schemas: shop.ts, session-manager.ts
  domain/                 catalog, cart, checkout (caps, idempotency, mandate), seed data, shop composition
  mcp/                    MCP tools (server.ts)
  http/                   HTTP gate: Origin, rate limits, sessions, tokens, DPoP, step-up; transport
  approval/               purchase approval: service, OIDC login, web pages, placing approved orders
  auth/                   JWT verification, DPoP, OAuth challenges
  security/               rate limiter, untrusted-text sanitiser, audit log
  session/                MCP session registry (server-issued, bound to their customer)
  session-manager/        theft detection: installation engine, Keycloak admin/events, extAuth HTTP app
  shared/                 small generic helpers
test/
  unit/                   unit + in-process tests, mirroring src/ (vitest.config.ts)
  e2e/                    full journey against the live stack (vitest.e2e.config.ts)
  attack/                 attack lab against the live stack (npm run test:attack)
  support/                test doubles and fixtures (test IdP, DPoP client, fakes)
scripts/                  smoke test, token helper
deploy/k8s/               shop + session-manager manifests, gateway route and edge policy
platform/tenant.yaml      what this server needs from the MCP platform
docs/                     guide, security posture, MCP compliance, attack results, harness runbook
```

Conventions: ES modules with explicit `.js` import suffixes (NodeNext), strict TypeScript, configuration validated
with zod at start-up (fail fast, secure defaults), no `!` non-null assertions in production code, one test file per
source module.

## Deploy (on the mcp-ecosystem-infra platform)

```bash
# once, platform team: tenants = { ecommerce = "../../ecommerce-mcp-server/platform/tenant.yaml" } in the platform's
# tfvars, then terraform apply there. It creates the shop's scopes, clients and Secret mcp-servers/shop-secrets.
docker build -t ecommerce-mcp-server:dev .
kubectl apply -k deploy/k8s                                          # shop, session-manager, route, edge policy
```

## Test against the live stack

```bash
TEST_USER_PASSWORD=… scripts/inspector-smoke.sh                                       # MCP Inspector CLI, 14 checks
MCP_URL=http://localhost:8000/mcp TEST_USER_PASSWORD=… npm run test:e2e              # full journey incl. approval
TEST_USER_PASSWORD=… npx tsx test/attack/lab.ts --report=docs/ATTACK-RESULTS.md       # attack lab
```

## Notes learned integrating agentgateway

- The gateway terminates the client's MCP session and opens its own upstream session; the server's
  `Mcp-Session-Id` (issued at `initialize`) is what the upstream sees.
- It sends no client address upstream; the edge policy stamps `x-forwarded-for` (and removes client-supplied trust
  headers).
- Under STRICT mTLS, select MCP backends by label (`selector`), not a `static` host (static is plaintext).
- Edge JWT validation must be `Permissive` with `preserveToken: true`: otherwise expired tokens get a challenge-less
  401 the client cannot recover from, and the server never sees the token.

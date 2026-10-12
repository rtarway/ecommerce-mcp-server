# ecommerce-mcp-server

Demo e-commerce MCP server (TypeScript / Node, official `@modelcontextprotocol/sdk`). A **proof of concept** for
letting AI agents shop for customers safely: the shop is a demo, and the platform it runs on
([`mcp-ecosystem-infra`](../mcp-ecosystem-infra)) is a local Rancher Desktop lab.

This repo is an **application team's** repo on that platform: it contains the MCP server, its Kubernetes and gateway
manifests, and [`platform/tenant.yaml`](platform/tenant.yaml), which declares what the server needs from the
platform (namespace, gateway paths, identity-provider scopes and clients). The platform team registers that file and
the platform creates everything with its own credentials; this repo holds none.

| Tool | Auth | Behaviour |
|---|---|---|
| `product_search` | none | Search the catalog by words, category, max price |
| `add_to_cart` | none (session cart) | Adds to the visitor's cart, keyed by the server-issued `Mcp-Session-Id` |
| `view_cart` | none | Shows the cart; for a signed-in customer, exactly what checkout would buy |
| `remove_from_cart` | none | Removes a line or reduces its quantity (e.g. something the customer did not ask for) |
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
[ATTACK-RESULTS.md](docs/ATTACK-RESULTS.md) (latest lab run). The original review is in [docs/archive](docs/archive).

## Develop

```bash
npm ci
npm test               # 173 unit + in-process HTTP/MCP tests (no network, no Keycloak)
npm run test:coverage
npm run typecheck
npm run dev            # needs ISSUER, JWKS_URL, RESOURCE_URL, PUBLIC_BASE_URL (or REQUIRE_APPROVAL=false); see src/config.ts
```

Layout: `src/domain` (catalog, cart, checkout with caps and idempotency) → `src/mcp` (tools) → `src/http` (gate:
sessions, rate limits, tokens, DPoP, step-up; transport) · `src/approval` (approval service, OIDC login, pages) ·
`src/auth` (JWT, DPoP, challenges) · `src/security` (rate limiter, sanitiser, audit) · `src/session` (session
registry) · `src/session-manager` + `src/sm-main.ts` (session-manager service).

## Deploy (on the mcp-ecosystem-infra platform)

```bash
# once, platform team: tenants = { ecommerce = "../../ecommerce-mcp-server/platform/tenant.yaml" } in the platform's
# tfvars, then terraform apply there. It creates the shop's scopes, clients and Secret mcp-servers/shop-secrets.
kubectl port-forward -n keycloak svc/keycloak-service 8080:8080
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

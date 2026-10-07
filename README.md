# ecommerce-mcp-server

Demo e-commerce MCP server (TypeScript / Node, official `@modelcontextprotocol/sdk`).

| Tool | Auth | Behaviour |
|---|---|---|
| `product_search` | none | Search the catalog by words, category, max price |
| `add_to_cart` | none (session cart) | Adds to the visitor's cart, keyed by `Mcp-Session-Id` |
| `one_step_checkout` | customer login + consent | Orders the cart using the shipping address and card saved on the customer's profile |

**Step-up auth (MCP spec):** `one_step_checkout` without a valid token gets `401` +
`WWW-Authenticate: Bearer resource_metadata=…, scope="ecommerce:checkout"`. The client runs
Authorization Code + PKCE against Keycloak; Keycloak shows the consent screen the first time only
(consent is stored per user+client). The anonymous session cart is claimed into the customer's cart.

State (carts, orders) is in memory — single replica, POC. Customer profiles are seed data (`src/seed.ts`).

#See [docs/GUIDE.md](docs/GUIDE.md) for the architecture, infra setup, and MCP Inspector test guide.

## Develop

```bash
npm ci
npm test               # unit + in-process HTTP/MCP tests (no network, no Keycloak)
npm run test:coverage
npm run typecheck
npm run dev            # needs ISSUER, JWKS_URL, RESOURCE_URL (see src/config.ts)
```

Layering (each unit is test-driven in isolation): `src/domain` (catalog, cart, checkout) →
`src/mcp` (tool wiring) → `src/http` (401/403 gate + transport) ; `src/auth` (JWT + challenge).

## Deploy (Rancher Desktop + the mcp-ecosystem-infra platform)

```bash
docker build -t ecommerce-mcp-server:dev .          # Rancher's Docker shares images with k8s
KC_ADMIN_PASSWORD=… scripts/keycloak-setup.sh        # audience / groups / ecommerce:checkout scopes (idempotent)
kubectl apply -k deploy/k8s                          # Deployment, Service, AgentgatewayBackend, HTTPRoute
# the gateway is published by Rancher Desktop on localhost:8000 (no port-forward needed)
kubectl port-forward -n keycloak svc/keycloak-service 8080:8080
```

## End-to-end test (real gateway + Keycloak)

```bash
MCP_URL=http://localhost:8000/mcp TEST_USER_PASSWORD=… KC_ADMIN_PASSWORD=… npm run test:e2e
```

Runs the real journey: anonymous browse/cart → 401 challenge → discovery → PKCE login + consent →
checkout → fresh login with no consent screen. `LOCAL_SESSIONS=1` is not needed any more
(the server issues `Mcp-Session-Id`). Run it against a bare local process by starting the server on
`:8000` with the env from `deploy/k8s/shop-mcp.yaml`.

## Notes learned integrating agentgateway

- The gateway terminates the client's MCP session and opens its own upstream session; the server's
  `Mcp-Session-Id` (issued at `initialize`) is what the upstream sees. Client `Authorization` and the
  `401 WWW-Authenticate` challenge pass through unchanged.
- `mcp.sessionId` / client `Mcp-Session-Id` are not available to upstream request transformations.

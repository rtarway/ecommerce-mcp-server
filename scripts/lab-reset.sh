#!/usr/bin/env bash
# Lab reset for harness testing: a clean shop and identity provider, as if no agent had ever connected.
#   scripts/lab-reset.sh            # everything below
#   scripts/lab-reset.sh --shop     # only restart the shop and session-manager (carts, sessions, orders)
# Keycloak part (needs the platform admin password from the infra Terraform state and the admin port-forward
# `kubectl port-forward -n keycloak svc/keycloak-service 8080:8080`):
#   - deletes every self-registered client (what MCP clients created by dynamic registration);
#   - revokes testuser's consents and ends all testuser sessions (also offline ones).
# Harness-side tokens are not touched: sign the harness out too (see docs/HARNESSES.md, "Reset after a harness").
set -euo pipefail
cd "$(dirname "$0")/.."
INFRA=${INFRA:-../mcp-ecosystem-infra/terraform}

if [ "${1:-}" != "--shop" ]; then
  KC_PW=$(terraform -chdir="$INFRA" output -raw keycloak_admin_password) KC_URL=${KC_URL:-http://localhost:8080} python3 - <<'EOF'
import json, os, re, urllib.parse, urllib.request
KC = os.environ["KC_URL"]
body = urllib.parse.urlencode({"client_id": "admin-cli", "username": "admin", "password": os.environ["KC_PW"], "grant_type": "password"}).encode()
token = json.load(urllib.request.urlopen(f"{KC}/realms/master/protocol/openid-connect/token", body))["access_token"]
def api(method, path):
    req = urllib.request.Request(f"{KC}/admin/realms/mcp{path}", method=method, headers={"Authorization": f"Bearer {token}"})
    raw = urllib.request.urlopen(req).read()
    return json.loads(raw) if raw else None
generated = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
deleted = 0
for c in api("GET", "/clients?max=5000"):
    if c["clientId"] == c["id"] and generated.match(c["clientId"]) and "mcp.platform/tenant" not in (c.get("attributes") or {}):
        api("DELETE", f"/clients/{c['id']}")
        deleted += 1
user = api("GET", "/users?username=testuser&exact=true")[0]["id"]
consents = api("GET", f"/users/{user}/consents")
for c in consents:
    api("DELETE", f"/users/{user}/consents/{urllib.parse.quote(c['clientId'], safe='')}")
api("POST", f"/users/{user}/logout")
print(f"keycloak: {deleted} self-registered clients deleted, {len(consents)} consents revoked, testuser signed out")
EOF
fi

kubectl -n mcp-servers rollout restart deploy/ecommerce-mcp-server deploy/session-manager >/dev/null
kubectl -n mcp-servers rollout status deploy/ecommerce-mcp-server --timeout=180s >/dev/null
kubectl -n mcp-servers rollout status deploy/session-manager --timeout=180s >/dev/null
echo "shop and session-manager restarted: carts, MCP sessions, orders, linked apps cleared"

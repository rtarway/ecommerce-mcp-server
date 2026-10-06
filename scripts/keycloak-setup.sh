#!/usr/bin/env bash
# Idempotently configures the Keycloak `mcp` realm for this app. The infra repo only provides a
# generic realm/client; everything specific to the shop MCP server lives here:
#   - `mcp-audience`  : puts this server's resource URL into the token `aud` (Keycloak has no RFC 8707)
#   - `mcp-groups`    : `groups` claim (used by gateway authorization rules)
#   - `ecommerce:checkout` : consent scope (step-up). Optional, so only requested at checkout.
# Both default scopes are also made realm defaults so dynamically registered clients get them.
# Usage: KC_ADMIN_PASSWORD=... [KC_URL=http://localhost:8080] [RESOURCE_URL=http://localhost:8000/mcp] scripts/keycloak-setup.sh
set -euo pipefail

KC_URL="${KC_URL:-http://localhost:8080}"
REALM="${REALM:-mcp}"
CLIENT_ID="${CLIENT_ID:-mcp-test-client}"
RESOURCE_URL="${RESOURCE_URL:-http://localhost:8000/mcp}"
: "${KC_ADMIN_PASSWORD:?set KC_ADMIN_PASSWORD}"

json() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }

TOKEN=$(curl -sf -d client_id=admin-cli -d username=admin --data-urlencode "password=$KC_ADMIN_PASSWORD" \
  -d grant_type=password "$KC_URL/realms/master/protocol/openid-connect/token" | json "print(d['access_token'])")
api() { local m=$1 p=$2; shift 2; curl -sf -X "$m" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$KC_URL/admin/realms/$REALM$p" "$@"; }

scope_id() { api GET "/client-scopes" | json "print(next((s['id'] for s in d if s['name']=='$1'),''))"; }

# ensure_scope <name> <json body>; echoes the scope id
ensure_scope() {
  local id; id=$(scope_id "$1")
  if [ -z "$id" ]; then api POST "/client-scopes" -d "$2" >/dev/null; id=$(scope_id "$1"); echo "created client scope $1" >&2; fi
  echo "$id"
}

AUD_ID=$(ensure_scope mcp-audience "$(cat <<J
{"name":"mcp-audience","protocol":"openid-connect",
 "attributes":{"include.in.token.scope":"false","display.on.consent.screen":"false"},
 "protocolMappers":[{"name":"mcp-audience","protocol":"openid-connect","protocolMapper":"oidc-audience-mapper",
   "config":{"included.custom.audience":"$RESOURCE_URL","access.token.claim":"true","id.token.claim":"false"}}]}
J
)")
GROUPS_ID=$(ensure_scope mcp-groups '{"name":"mcp-groups","protocol":"openid-connect",
 "attributes":{"include.in.token.scope":"false","display.on.consent.screen":"false"},
 "protocolMappers":[{"name":"groups","protocol":"openid-connect","protocolMapper":"oidc-group-membership-mapper",
   "config":{"claim.name":"groups","full.path":"false","access.token.claim":"true","id.token.claim":"true","userinfo.token.claim":"true"}}]}')
CHECKOUT_ID=$(ensure_scope "ecommerce:checkout" '{"name":"ecommerce:checkout","protocol":"openid-connect",
 "attributes":{"display.on.consent.screen":"true","include.in.token.scope":"true",
  "consent.screen.text":"Let this app place orders for you, charging your saved payment method and shipping to your saved address"}}')

REALM_DEFAULTS=$(api GET "/default-default-client-scopes" | json "print(' '.join(s['id'] for s in d))")
for id in "$AUD_ID" "$GROUPS_ID"; do
  case " $REALM_DEFAULTS " in *" $id "*) ;; *) api PUT "/default-default-client-scopes/$id" >/dev/null ;; esac
done

CID=$(api GET "/clients?clientId=$CLIENT_ID" | json "print(d[0]['id'])")
for id in "$AUD_ID" "$GROUPS_ID"; do api PUT "/clients/$CID/default-client-scopes/$id" >/dev/null; done
api PUT "/clients/$CID/optional-client-scopes/$CHECKOUT_ID" >/dev/null
CLIENT_JSON=$(api GET "/clients/$CID" | json "d['consentRequired']=True;print(json.dumps(d))")
api PUT "/clients/$CID" -d "$CLIENT_JSON" >/dev/null
echo "client $CLIENT_ID: consentRequired, default scopes + audience=$RESOURCE_URL, optional scope ecommerce:checkout"

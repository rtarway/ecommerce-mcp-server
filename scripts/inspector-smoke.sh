#!/usr/bin/env bash
# Smoke test of the deployed stack using the MCP Inspector CLI.
#   TEST_USER_PASSWORD=… scripts/inspector-smoke.sh
# Needs: gateway on localhost:8000 (Rancher publishes it; sign-in endpoints are on it too).
set -uo pipefail
cd "$(dirname "$0")/.."

# Inspector stores OAuth tokens from earlier (e.g. web UI) sign-ins under ~/.mcp-inspector and the CLI reuses them,
# which would turn the checks without a token into signed-in ones. Run with an empty HOME (keeping the npm cache).
ANON_HOME=$(mktemp -d); trap 'rm -rf "$ANON_HOME"' EXIT
INSPECT=(env HOME="$ANON_HOME" npm_config_cache="$HOME/.npm" npx -y @modelcontextprotocol/inspector@latest --cli --config inspector/mcp.config.json --server ecommerce)
pass=0; fail=0
check() { # check <name> <expected-regex> <output>
  if grep -Eq "$2" <<<"$3"; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; echo "      expected /$2/, got: ${3:0:300}"; fail=$((fail+1)); fi
}

# Sign-in-first deployments advertise the checkout scope up front and refuse every request without a token.
SIGNIN_FIRST=$(curl -s http://localhost:8000/.well-known/oauth-protected-resource/mcp | grep -q 'ecommerce:checkout' && echo yes || echo no)

catalog_checks() { # catalog_checks <label> [inspector args...]: browsing and cart tools on one client
  local label=$1; shift
  out=$("${INSPECT[@]}" "$@" --method tools/list 2>&1)
  tools=$(tr -d '\n' <<<"$out")
  check "tools/list ($label) exposes the 6 shopping tools" 'product_search' "$tools"
  for t in add_to_cart view_cart remove_from_cart one_step_checkout list_orders; do check "  ... including $t" "\"$t\"" "$tools"; done
  out=$("${INSPECT[@]}" "$@" --method tools/call --tool-name product_search --tool-arg query="running shoes" 2>&1)
  check "product_search ($label) finds running shoes" 'Trail Running Shoes' "$out"
  out=$("${INSPECT[@]}" "$@" --method tools/call --tool-name remove_from_cart --tool-arg productId=not-a-product 2>&1)
  check "remove_from_cart of something not in the cart is a clear tool error" 'Not in your cart' "$out"
}

if [ "$SIGNIN_FIRST" = yes ]; then
  # Inspector sees the connect-time 401 + WWW-Authenticate and wants to start OAuth; --stored-auth-only stops it
  # from opening a browser, so a non-interactive run reports auth_required instead.
  out=$("${INSPECT[@]}" --stored-auth-only --method tools/list 2>&1)
  check "connecting without login triggers the OAuth challenge (sign in on first connect)" 'auth_required|401' "$out"
else
  catalog_checks anonymous
  out=$("${INSPECT[@]}" --method tools/call --tool-name add_to_cart --tool-arg productId=bottle-001 --tool-arg quantity=2 2>&1)
  check "add_to_cart (anonymous) returns a cart" '"total": 49.98' "$out"
  out=$("${INSPECT[@]}" --method tools/call --tool-name view_cart 2>&1)
  check "view_cart (anonymous, fresh session) is empty" 'empty' "$out"
  out=$("${INSPECT[@]}" --stored-auth-only --method tools/call --tool-name one_step_checkout 2>&1)
  check "one_step_checkout without login triggers the OAuth challenge" 'auth_required|401' "$out"
fi

if [ -n "${TEST_USER_PASSWORD:-}" ]; then
  token=$(npx -y tsx scripts/get-token.ts) || { echo "FAIL  could not obtain a customer token"; exit 1; }
  AUTH=(--header "Authorization: Bearer $token")
  [ "$SIGNIN_FIRST" = yes ] && catalog_checks "signed in" "${AUTH[@]}"
  out=$("${INSPECT[@]}" "${AUTH[@]}" --method tools/call --tool-name add_to_cart --tool-arg productId=shoe-trail-001 --tool-arg quantity=1 2>&1)
  check "add_to_cart as customer goes to the customer cart" '"total": [0-9]' "$out"
  # A token alone never buys: checkout answers with a link the customer must open, sign in to and approve.
  # (The full approve-and-order journey is covered by test/attack/lab.ts B1 and npm run test:e2e.)
  out=$("${INSPECT[@]}" "${AUTH[@]}" --method tools/call --tool-name one_step_checkout 2>&1)
  check "one_step_checkout with token asks for the customer's approval" 'approval_required' "$out"
  check "approval link points at the shop's approval page" 'localhost:8000/approve/' "$out"
else
  echo "SKIP  authenticated checks (set TEST_USER_PASSWORD)"
fi

echo "---- $pass passed, $fail failed"
[ "$fail" -eq 0 ]

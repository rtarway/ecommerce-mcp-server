#!/usr/bin/env bash
# Smoke test of the deployed stack using the MCP Inspector CLI.
#   TEST_USER_PASSWORD=… scripts/inspector-smoke.sh
# Needs: gateway on localhost:8000 (Rancher publishes it) and Keycloak port-forwarded on :8080.
set -uo pipefail
cd "$(dirname "$0")/.."

INSPECT=(npx -y @modelcontextprotocol/inspector@latest --cli --config inspector/mcp.config.json --server ecommerce)
pass=0; fail=0
check() { # check <name> <expected-regex> <output>
  if grep -Eq "$2" <<<"$3"; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; echo "      expected /$2/, got: ${3:0:300}"; fail=$((fail+1)); fi
}

out=$("${INSPECT[@]}" --method tools/list 2>&1)
check "tools/list exposes the 3 tools" 'product_search.*add_to_cart.*one_step_checkout|one_step_checkout.*add_to_cart.*product_search' "$(tr -d '\n' <<<"$out")"

out=$("${INSPECT[@]}" --method tools/call --tool-name product_search --tool-arg query="running shoes" 2>&1)
check "product_search (anonymous) finds running shoes" 'Trail Running Shoes' "$out"

out=$("${INSPECT[@]}" --method tools/call --tool-name add_to_cart --tool-arg productId=bottle-001 --tool-arg quantity=2 2>&1)
check "add_to_cart (anonymous) returns a cart" '"total": 49.98' "$out"

# Inspector sees the 401 + WWW-Authenticate challenge and wants to start OAuth; --stored-auth-only
# stops it from opening a browser, so a non-interactive run reports auth_required instead.
out=$("${INSPECT[@]}" --stored-auth-only --method tools/call --tool-name one_step_checkout 2>&1)
check "one_step_checkout without login triggers the OAuth challenge" 'auth_required|401' "$out"

if [ -n "${TEST_USER_PASSWORD:-}" ]; then
  token=$(npx -y tsx scripts/get-token.ts) || { echo "FAIL  could not obtain a customer token"; exit 1; }
  AUTH=(--header "Authorization: Bearer $token")
  out=$("${INSPECT[@]}" "${AUTH[@]}" --method tools/call --tool-name add_to_cart --tool-arg productId=shoe-trail-001 --tool-arg quantity=1 2>&1)
  check "add_to_cart as customer goes to the customer cart" '"total": 89.99' "$out"
  out=$("${INSPECT[@]}" "${AUTH[@]}" --method tools/call --tool-name one_step_checkout 2>&1)
  check "one_step_checkout with token places an order" 'ord_[0-9a-f]+' "$out"
  check "order uses the saved card on file" '4242' "$out"
else
  echo "SKIP  authenticated checks (set TEST_USER_PASSWORD)"
fi

echo "---- $pass passed, $fail failed"
[ "$fail" -eq 0 ]

#!/usr/bin/env bash
# Probes the deployed shop through the gateway for MCP protocol/transport requirements (revision 2025-11-25).
# Evidence for docs/MCP-COMPLIANCE.md. Anonymous only: no credentials needed.
#   scripts/mcp-compliance-probe.sh [MCP_URL]        (default http://localhost:8000/mcp)
set -uo pipefail
U="${1:-http://localhost:8000/mcp}"
PRM="$(python3 -c "import sys;from urllib.parse import urlsplit as u;p=u(sys.argv[1]);print(f'{p.scheme}://{p.netloc}/.well-known/oauth-protected-resource{p.path}')" "$U")"
H=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')
pass=0; finding=0
check() { # check <id> <requirement> <actual> <expected-regex>
  if grep -Eq "$4" <<<"$3"; then echo "PASS     $1  $2"; pass=$((pass+1)); else echo "FINDING  $1  $2"; echo "         got: ${3:0:200}"; finding=$((finding+1)); fi
}
data() { sed -n 's/^data: //p' | head -1; }
init() { curl -si -X POST "$U" "${H[@]}" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"$1\",\"capabilities\":{},\"clientInfo\":{\"name\":\"probe\",\"version\":\"1\"}}}"; }

R=$(init 2025-11-25)
SID=$(awk -F': ' 'tolower($1)=="mcp-session-id"{print $2}' <<<"$R" | tr -d '\r')
S=(-H "Mcp-Session-Id: $SID" -H "MCP-Protocol-Version: 2025-11-25")
INIT=$(data <<<"$R")
check L1 "initialize returns protocolVersion, capabilities, serverInfo (MUST)" "$INIT" '"protocolVersion":"2025-11-25".*"capabilities".*"serverInfo"'
check L2 "unsupported client version -> server answers with a version it supports (MUST)" "$(init 1999-01-01 | data)" '"protocolVersion":"20[0-9]{2}-[0-9]{2}-[0-9]{2}"'
check L3 "ping answered with an empty result (MUST)" "$(curl -s -X POST "$U" "${H[@]}" "${S[@]}" -d '{"jsonrpc":"2.0","id":3,"method":"ping"}' | data)" '"result":\{\}'
check T1 "session id: visible ASCII only (MUST), long random value (SHOULD)" "$(python3 -c "import sys;s=sys.argv[1];print('ok' if s and all(0x21<=ord(c)<=0x7e for c in s) and len(s)>=32 else 'bad')" "$SID")" '^ok$'
check T2 "notification -> 202 Accepted, no body (MUST)" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$U" "${H[@]}" "${S[@]}" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}')" '^202$'
check T3 "GET without SSE support -> 405 (MUST: SSE or 405)" "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$U" -H 'Accept: text/event-stream' "${S[@]}")" '^405$'
check T4 "JSON-RPC batch refused (2025-06-18+: one message per POST)" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$U" "${H[@]}" "${S[@]}" -d '[{"jsonrpc":"2.0","id":4,"method":"ping"},{"jsonrpc":"2.0","id":5,"method":"ping"}]')" '^4[0-9][0-9]$'
check T5 "unsupported MCP-Protocol-Version -> 400 (MUST)" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$U" "${H[@]}" -H "Mcp-Session-Id: $SID" -H 'MCP-Protocol-Version: 1999-01-01' -d '{"jsonrpc":"2.0","id":6,"method":"tools/list"}')" '^400$'
check T6 "Accept without text/event-stream refused" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$U" -H 'Content-Type: application/json' -H 'Accept: application/json' "${S[@]}" -d '{"jsonrpc":"2.0","id":7,"method":"ping"}')" '^406$'
check T7 "request without a session (non-initialize) -> 400 (SHOULD, servers requiring sessions)" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$U" "${H[@]}" -d '{"jsonrpc":"2.0","id":8,"method":"tools/list"}')" '^400$'
IREQ='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
check T8 "hostile Origin -> 403 (MUST, DNS rebinding)" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$U" "${H[@]}" -H 'Origin: http://evil.example' -d "$IREQ")" '^403$'
check T9 "unknown method -> JSON-RPC -32601 Method not found" "$(curl -s -X POST "$U" "${H[@]}" "${S[@]}" -d '{"jsonrpc":"2.0","id":10,"method":"nope/nope"}' | tr -d '\n')" '"code":-32601'
TOOLS=$(curl -s -X POST "$U" "${H[@]}" "${S[@]}" -d '{"jsonrpc":"2.0","id":11,"method":"tools/list"}' | data)
check X1 "tools capability declared (MUST)" "$INIT" '"capabilities":\{"tools"'
check X2 "tool names match [A-Za-z0-9_.-]{1,128} and are unique (SHOULD)" "$(python3 -c "import sys,json,re;t=[x['name'] for x in json.loads(sys.argv[1])['result']['tools']];print('ok' if len(t)==len(set(t)) and all(re.fullmatch(r'[A-Za-z0-9_.-]{1,128}',n) for n in t) else 'bad')" "$TOOLS")" '^ok$'
check X3 "every inputSchema is a JSON Schema object (MUST)" "$(python3 -c "import sys,json;print('ok' if all(isinstance(x.get('inputSchema'),dict) and x['inputSchema'].get('type')=='object' for x in json.loads(sys.argv[1])['result']['tools']) else 'bad')" "$TOOLS")" '^ok$'
check X4 "no-argument tools use additionalProperties:false (recommended)" "$(python3 -c "import sys,json;print('ok' if all(x['inputSchema'].get('additionalProperties') is False for x in json.loads(sys.argv[1])['result']['tools'] if not x['inputSchema'].get('properties')) else 'bad')" "$TOOLS")" '^ok$'
check X5 "unknown tool -> protocol error -32602 (not a tool result)" "$(curl -s -X POST "$U" "${H[@]}" "${S[@]}" -d '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"nope","arguments":{}}}' | data)" '"error":\{"code":-32602'
check X6 "invalid arguments -> tool execution error (isError) (2025-11-25)" "$(curl -s -X POST "$U" "${H[@]}" "${S[@]}" -d '{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"add_to_cart","arguments":{"productId":"bottle-001","quantity":99}}}' | data)" '"isError":true'
check X7 "structured results also serialised as text (SHOULD)" "$(curl -s -X POST "$U" "${H[@]}" "${S[@]}" -d '{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"product_search","arguments":{"limit":1}}}' | data)" '"structuredContent".*|"text":".*products'
check A1 "protected-resource metadata: resource + authorization_servers (MUST)" "$(curl -s "$PRM")" '"resource":".*"authorization_servers":\['
check A2 "scopes_supported minimal, no offline_access (SHOULD / SHOULD NOT)" "$(curl -s "$PRM")" '"scopes_supported":\["shop:api"\]'
check A3 "protected tool without token -> 401 + WWW-Authenticate resource_metadata + scope (MUST/SHOULD)" "$(curl -si -X POST "$U" "${H[@]}" "${S[@]}" -d '{"jsonrpc":"2.0","id":15,"method":"tools/call","params":{"name":"one_step_checkout","arguments":{}}}' | tr -d '\r' | grep -iE '^HTTP|^www-authenticate' | tr '\n' ' ')" '401.*resource_metadata=.*scope='
check A4 "invalid token -> 401 invalid_token (MUST)" "$(curl -si -X POST "$U" "${H[@]}" -H 'Authorization: Bearer garbage' -d "$IREQ" | tr -d '\r' | grep -iE '^HTTP|^www-authenticate' | tr '\n' ' ')" '401.*invalid_token'
check A5 "access token in the query string not accepted (MUST)" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$U?access_token=x" "${H[@]}" "${S[@]}" -d '{"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"list_orders","arguments":{}}}')" '^401$'
check S1 "DELETE ends the session; reuse -> 404 (MUST)" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$U" "${S[@]}") $(curl -s -o /dev/null -w '%{http_code}' -X POST "$U" "${H[@]}" "${S[@]}" -d '{"jsonrpc":"2.0","id":18,"method":"ping"}')" '^20[24] 404$'
echo "---- $pass pass, $finding finding(s)"

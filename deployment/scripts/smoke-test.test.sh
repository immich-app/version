#!/usr/bin/env bash
#
# Regression tests for smoke-test.sh, the gate that decides whether prod
# deploys. A stub curl on PATH answers each path with a chosen status and body,
# or fails outright, so no deployed worker is needed.
#
# Run locally: ./deployment/scripts/smoke-test.test.sh
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/smoke-test.sh"
stub=$(mktemp -d)
trap 'rm -rf "$stub"' EXIT

cat >"$stub/curl" <<'EOF'
#!/usr/bin/env bash
# Writes the configured body to the -o file and prints the configured status for
# the requested path. A status of "fail" makes curl itself fail, as on a
# connection error after its retries.
out=/dev/null
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [ "${args[$i]}" = -o ]; then out="${args[$((i + 1))]}"; fi
done
case "${args[-1]}" in
  */health) status="$STUB_HEALTH" body="$STUB_HEALTH_BODY" ;;
  */version) status="$STUB_VERSION" body="$STUB_VERSION_BODY" ;;
  *) status=000 body= ;;
esac
if [ "$status" = fail ]; then
  echo "curl: (7) Failed to connect" >&2
  exit 7
fi
printf '%s' "$body" >"$out"
printf '%s' "$status"
EOF
chmod +x "$stub/curl"

OK='{"status":"ok"}'
LATEST='{"version":"v1.0.0","published_at":"2025-01-01T00:00:00Z"}'
EMPTY='{"error":"No releases found"}'
MISSING='{"error":"Not Found","path":"/version"}'

failures=0
# expect <pass|fail> <health status> <health body> <version status> <version body>
expect() {
  local want="$1" code=0
  STUB_HEALTH="$2" STUB_HEALTH_BODY="$3" STUB_VERSION="$4" STUB_VERSION_BODY="$5" PATH="$stub:$PATH" \
    "$script" https://worker.test >/dev/null 2>&1 || code=$?
  if { [ "$want" = pass ] && [ "$code" -ne 0 ]; } || { [ "$want" = fail ] && [ "$code" -eq 0 ]; }; then
    echo "FAIL: /health=$2 $3, /version=$4 $5 should $want, exited $code"
    failures=$((failures + 1))
  else
    echo "ok: /health=$2, /version=$4 $5 -> $want"
  fi
}

expect pass 200 "$OK" 200 "$LATEST"
expect pass 200 "$OK" 404 "$EMPTY"   # an empty releases table is fine
expect fail 200 "$OK" 404 "$MISSING" # a missing /version route is not
expect fail 200 '<html>' 200 "$LATEST" # some other host answering /health
expect fail 204 '' 200 "$LATEST"     # /health must be exactly 200
expect fail 301 '' 200 "$LATEST"
expect fail 500 "$OK" 200 "$LATEST"
expect fail 200 "$OK" 500 '{}' # code that can't use the D1 schema
expect fail 200 "$OK" 502 ''
expect fail 200 "$OK" 301 ''
expect fail fail '' 200 "$LATEST"
expect fail 200 "$OK" fail ''

if [ "$failures" -gt 0 ]; then
  echo "${failures} smoke-test case(s) failed"
  exit 1
fi

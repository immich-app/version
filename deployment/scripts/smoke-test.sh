#!/usr/bin/env bash
#
# Checks a deployed worker actually serves, after a clean apply. /health must be
# exactly 200 with {"status":"ok"}. /version reads D1, so code that can't use the
# schema shows up as a 5xx; an empty releases table is a 404 saying "No releases
# found", which is fine. Any other 404 (a missing route, the wrong host) fails.
#
# Transient failures (connection errors, 408/429/5xx) are retried for up to 3
# minutes, and each request is capped at 30s, so a hung endpoint fails the gate
# instead of holding the job.
#
# Usage: ./deployment/scripts/smoke-test.sh https://version.example.com
set -euo pipefail

url="${1:?usage: smoke-test.sh <base url>}"
body=$(mktemp)
trap 'rm -f "$body"' EXIT

# Prints the status code and leaves the response body in $body.
request() {
  curl -sS -o "$body" -w '%{http_code}' \
    --connect-timeout 10 --max-time 30 \
    --retry 5 --retry-delay 10 --retry-max-time 180 --retry-all-errors \
    "$1"
}

health=$(request "${url}/health")
if [ "$health" != 200 ] || ! grep -q '"status":"ok"' "$body"; then
  echo "::error::GET ${url}/health returned ${health}, expected 200 with {\"status\":\"ok\"}"
  exit 1
fi
echo "GET /health: ${health}"

version=$(request "${url}/version")
case "$version" in
  200) echo "GET /version: ${version}" ;;
  404)
    if ! grep -q '"error":"No releases found"' "$body"; then
      echo "::error::GET ${url}/version returned a 404 that isn't the empty-table one: $(head -c 200 "$body")"
      exit 1
    fi
    echo "GET /version: ${version} (no releases stored yet)"
    ;;
  *)
    echo "::error::GET ${url}/version returned ${version}"
    exit 1
    ;;
esac

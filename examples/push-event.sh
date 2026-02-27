#!/usr/bin/env bash

set -euo pipefail

PORTAL_URL="${PORTAL_URL:-http://localhost:4040}"
PORTAL_API_TOKEN="${PORTAL_API_TOKEN:-}"

AUTH_HEADER=()
if [[ -n "${PORTAL_API_TOKEN}" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${PORTAL_API_TOKEN}")
fi

curl -sS -X POST "${PORTAL_URL}/api/events" \
  -H 'Content-Type: application/json' \
  "${AUTH_HEADER[@]}" \
  -d '{
    "type": "heartbeat",
    "agentId": "coder-2",
    "model": "gpt-4.1-mini",
    "host": "mac-mini",
    "status": "busy",
    "jobId": "job-1002",
    "jobStatus": "running",
    "sessionId": "sess-9010",
    "sessionStatus": "active",
    "usage": { "inputTokens": 120, "outputTokens": 64, "cachedTokens": 20 }
  }' | python3 -m json.tool

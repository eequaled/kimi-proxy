#!/bin/bash
# test-main.sh
# Tests the endpoints of main.js (OpenAI-compatible API)

PORT=18793
PROXY_KEY="mewmew"
BASE_URL="http://127.0.0.1:${PORT}"

echo "=== 1. Testing /healthz ==="
curl -s "${BASE_URL}/healthz" | json_pp 2>/dev/null || curl -s "${BASE_URL}/healthz"
echo -e "\n\n"

echo "=== 2. Testing /v1/models ==="
curl -s -H "Authorization: Bearer ${PROXY_KEY}" "${BASE_URL}/v1/models" | json_pp 2>/dev/null || curl -s -H "Authorization: Bearer ${PROXY_KEY}" "${BASE_URL}/v1/models"
echo -e "\n\n"

echo "=== 3. Testing /v1/chat/completions (Non-streaming) ==="
curl -s -X POST "${BASE_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${PROXY_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "k2d6",
    "messages": [{"role": "user", "content": "What is 2+2?"}],
    "stream": false
  }' | json_pp 2>/dev/null || curl -s -X POST "${BASE_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${PROXY_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "k2d6",
    "messages": [{"role": "user", "content": "What is 2+2?"}],
    "stream": false
  }'
echo -e "\n\n"

echo "=== 4. Testing /v1/chat/completions (Streaming) ==="
curl -X POST "${BASE_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${PROXY_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "k2d6-thinking",
    "messages": [{"role": "user", "content": "Count from 1 to 5"}],
    "stream": true
  }'
echo -e "\n"

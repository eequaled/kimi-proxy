#!/bin/bash
# test-anthropic.sh
# Tests the endpoints of anthropic.js (Anthropic-compatible API)

PORT=18792
PROXY_KEY="mewmew"
BASE_URL="http://127.0.0.1:${PORT}"

echo "=== 1. Testing /healthz ==="
curl -s "${BASE_URL}/healthz" | json_pp 2>/dev/null || curl -s "${BASE_URL}/healthz"
echo -e "\n\n"

echo "=== 2. Testing /v1/models ==="
curl -s -H "x-api-key: ${PROXY_KEY}" "${BASE_URL}/v1/models" | json_pp 2>/dev/null || curl -s -H "x-api-key: ${PROXY_KEY}" "${BASE_URL}/v1/models"
echo -e "\n\n"

echo "=== 3. Testing /v1/messages (Non-streaming) ==="
curl -s -X POST "${BASE_URL}/v1/messages" \
  -H "x-api-key: ${PROXY_KEY}" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-haiku-20240307",
    "messages": [{"role": "user", "content": "What is 3+3?"}],
    "system": "You are a math bot.",
    "max_tokens": 1024,
    "stream": false
  }' | json_pp 2>/dev/null || curl -s -X POST "${BASE_URL}/v1/messages" \
  -H "x-api-key: ${PROXY_KEY}" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-haiku-20240307",
    "messages": [{"role": "user", "content": "What is 3+3?"}],
    "system": "You are a math bot.",
    "max_tokens": 1024,
    "stream": false
  }'
echo -e "\n\n"

echo "=== 4. Testing /v1/messages (Streaming) ==="
curl -X POST "${BASE_URL}/v1/messages" \
  -H "x-api-key: ${PROXY_KEY}" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [{"role": "user", "content": "Count from 1 to 5"}],
    "max_tokens": 1024,
    "stream": true
  }'
echo -e "\n"

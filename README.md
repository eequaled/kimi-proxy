# Kimi Gateway

A local reverse proxy that exposes the Kimi desktop app's internal LLM API as standard OpenAI and Anthropic compatible endpoints. It reads your Kimi desktop app auth token automatically.

## Requirements
- Windows OS
- Kimi Desktop App installed and logged in (so the token is on disk)
- Node.js

## Usage (Unified Server — Recommended)

One process, one port (default 18793). Serves both the OpenAI Chat Completions API and the Anthropic Messages API.

```bash
cd kimi-gateway
node server.js
```

- **OpenAI endpoint:** `http://127.0.0.1:18793/v1/chat/completions`
- **Anthropic endpoint:** `http://127.0.0.1:18793/v1/messages`
- **API Key:** `mewmew` (or whatever you set in `PROXY_KEY` env var)
- Auth is accepted via either `Authorization: Bearer <key>` (OpenAI style) or `x-api-key: <key>` (Anthropic style)

### Trae / OpenCode / OpenAI SDKs
1. Go to Settings -> LLM Providers
2. Add Custom OpenAI Provider
3. Base URL: `http://127.0.0.1:18793/v1`
4. API Key: `mewmew`
5. Type in model name: `k2d6-thinking`

### Claude Code CLI
```bash
export ANTHROPIC_API_KEY="mewmew"
export ANTHROPIC_BASE_URL="http://127.0.0.1:18793"
claude
```

## Legacy: Separate Proxies

The original two-file setup still works if you prefer running them independently:

- **OpenAI proxy (port 18793):** `node main.js`
- **Anthropic proxy (port 18792):** `node anthropic.js`

## Available Models

| Model ID | Display Name | Internal Scenario | Notes |
|----------|--------------|-------------------|-------|
| `k2d6` | K2.6 Instant | `SCENARIO_K2D5` | Fast chat |
| `k2d6-thinking` | K2.6 Thinking | `SCENARIO_K2D5` | Enabled thinking/reasoning |
| `k2d6-agent` | K2.6 Agent | `SCENARIO_OK_COMPUTER` | Research, sites, docs (Normal) — **Rate-limited for free users** |
| `k2d6-agent-ultra` | K2.6 Agent Swarm | `SCENARIO_OK_COMPUTER` | Large scale tasks (Ultra) — **Rate-limited for free users** |

*Note: For the Anthropic API, Anthropic model names are automatically mapped (e.g. `sonnet` -> `thinking`, `opus` -> `agent-ultra`, `haiku` -> `instant`).*

## How it works
The Kimi desktop app uses a proprietary Connect-JSON protocol with operational transforms for streaming. This proxy translates standard JSON formats to Connect-JSON, frames them with the correct headers (reading your auth token directly from `%APPDATA%\kimi-desktop\bridge-store\token-store.json`), and streams the Kimi response back in standard SSE chunks.

## Development
- `kimi-protocol.js` — shared Connect-JSON framing, token reading, request building
- `server.js` — unified single-port proxy (OpenAI + Anthropic)
- `main.js` / `anthropic.js` — legacy separate proxies
- `test-protocol.js` — protocol unit tests
- `test-upstream.js` — upstream capture/debug tooling

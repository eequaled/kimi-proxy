# Kimi Gateway

A local reverse proxy that exposes the Kimi desktop app's internal LLM API as standard OpenAI and Anthropic compatible endpoints. It reads your Kimi desktop app auth token automatically.

## Requirements
- Windows OS
- Kimi Desktop App installed and logged in (so the token is on disk)
- Node.js

## Usage

### 1. OpenAI-Compatible Proxy (Port 18793)
This proxy speaks the standard OpenAI Chat Completions API format and is ideal for tools like Trae, OpenCode, Cursor, and any OpenAI SDK.

```bash
cd kimi-gateway
node main.js
```
- **Endpoint:** `http://127.0.0.1:18793/v1/chat/completions`
- **API Key:** `mewmew` (or whatever you set in `PROXY_KEY` env var)

### 2. Anthropic-Compatible Proxy (Port 18792)
This proxy speaks the standard Anthropic Messages API format and is ideal for Claude Code CLI and Anthropic SDKs.

```bash
cd kimi-gateway
node anthropic.js
```
- **Endpoint:** `http://127.0.0.1:18792/v1/messages`
- **API Key:** `mewmew` (or whatever you set in `PROXY_KEY` env var)

## Available Models

| Model ID | Display Name | Internal Scenario | Notes |
|----------|--------------|-------------------|-------|
| `k2d6` | K2.6 Instant | `SCENARIO_K2D5` | Fast chat |
| `k2d6-thinking` | K2.6 Thinking | `SCENARIO_K2D5` | Enabled thinking/reasoning |
| `k2d6-agent` | K2.6 Agent | `SCENARIO_OK_COMPUTER` | Research, sites, docs (Normal) — **Rate-limited for free users** |
| `k2d6-agent-ultra` | K2.6 Agent Swarm | `SCENARIO_OK_COMPUTER` | Large scale tasks (Ultra) — **Rate-limited for free users** |

*Note: For the Anthropic proxy, Anthropic model names are automatically mapped (e.g. `sonnet` -> `thinking`, `opus` -> `agent-ultra`, `haiku` -> `instant`).*

## Integration Examples

### Trae / OpenCode
1. Go to Settings -> LLM Providers
2. Add Custom OpenAI Provider
3. Base URL: `http://127.0.0.1:18793/v1`
4. API Key: `mewmew`
5. Type in model name: `k2d6-thinking`

### Claude Code CLI
```bash
export ANTHROPIC_API_KEY="mewmew"
export ANTHROPIC_BASE_URL="http://127.0.0.1:18792"
claude
```

## How it works
The Kimi desktop app uses a proprietary Connect-JSON protocol with operational transforms for streaming. This proxy translates standard JSON formats to Connect-JSON, frames them with the correct headers (reading your auth token directly from `%APPDATA%\kimi-desktop\bridge-store\token-store.json`), and streams the Kimi response back in standard SSE chunks.

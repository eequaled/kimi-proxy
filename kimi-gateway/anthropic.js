/**
 * anthropic.js
 * 
 * Anthropic-compatible HTTP proxy for Kimi Desktop app.
 * Speaks Anthropic Messages API on the frontend (port 18792), 
 * translates to Kimi's Connect-JSON format on the backend.
 * 
 * Usage:
 *   node anthropic.js
 *   PORT=3002 node anthropic.js
 */

import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  readToken,
  buildHeaders,
  mapModel,
  buildRequestBody,
  frameConnectJson,
  parseConnectStream
} from "./kimi-protocol.js";

// ─── Configuration ────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "18792", 10);
const PROXY_KEY = process.env.PROXY_KEY || "mewmew";
const UPSTREAM_URL = "https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat";
const LOG_FILE = path.join(import.meta.dirname, "proxy_requests.json");
const MAX_LOGS = 50;
const TOKEN_TTL_MS = 5 * 60 * 1000;

// ─── Token Cache ──────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiresAt = 0;

function getToken() {
  const now = Date.now();
  if (!cachedToken || now > tokenExpiresAt) {
    cachedToken = readToken();
    tokenExpiresAt = now + TOKEN_TTL_MS;
    console.log("[Auth] Token refreshed from disk.");
  }
  return cachedToken;
}

function invalidateToken() {
  cachedToken = null;
  tokenExpiresAt = 0;
  console.log("[Auth] Token invalidated.");
}

// ─── Request Logging ──────────────────────────────────────────────────────
function logRequest(summary) {
  let logs = [];
  try {
    if (fs.existsSync(LOG_FILE)) {
      logs = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
    }
  } catch (e) {
    // ignore
  }
  logs.unshift({ timestamp: new Date().toISOString(), ...summary });
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
  } catch (e) {
    console.error("Failed to write log:", e.message);
  }
}

// ─── HTTP Server & Routing ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key, anthropic-version");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "live" }));
    return;
  }

  const reqKey = req.headers["x-api-key"] || "";
  if (reqKey !== PROXY_KEY) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "Invalid x-api-key" } }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    const models = [
      { id: "k2d6", name: "K2.6 Instant" },
      { id: "k2d6-thinking", name: "K2.6 Thinking" },
      { id: "k2d6-agent", name: "K2.6 Agent", warning: "Rate-limited for free users. Use sonnet (maps to thinking) instead." },
      { id: "k2d6-agent-ultra", name: "K2.6 Agent Swarm", warning: "Rate-limited for free users. Use sonnet (maps to thinking) instead." }
    ];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: models, type: "list" }));
    return;
  }

  // Claude Code counts tokens to manage context window
  if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ input_tokens: 42 }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/messages") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body);
        await handleMessages(req, res, payload);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: err.message } }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "Endpoint not found" } }));
});

// ─── Messages API Handler ────────────────────────────────────────────────
async function handleMessages(req, res, payload) {
  const modelId = payload.model || "claude-3-5-sonnet-20241022";
  const messages = payload.messages || [];
  const system = payload.system || "";
  const stream = !!payload.stream;
  const requestId = "msg_" + crypto.randomBytes(12).toString("hex");

  // Format system prompt into user's first message if present
  let mappedMessages = [...messages];
  if (system && mappedMessages.length > 0) {
    let sysText = "";
    if (typeof system === "string") sysText = system;
    else if (Array.isArray(system)) sysText = system.map(s => s.text).join("\n");
    
    const firstUserMsg = mappedMessages[0];
    if (typeof firstUserMsg.content === "string") {
      firstUserMsg.content = `[System Instructions]\n${sysText}\n\n[User]\n${firstUserMsg.content}`;
    } else if (Array.isArray(firstUserMsg.content)) {
      firstUserMsg.content.unshift({ type: "text", text: `[System Instructions]\n${sysText}\n\n[User]\n` });
    }
  }

  // Convert Anthropic formatting to expected format for buildRequestBody
  const openAiMessages = mappedMessages.map(m => {
    let content = "";
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content.map(c => c.text || JSON.stringify(c)).join("\n");
    }
    return { role: m.role, content };
  });

  const modelParams = mapModel(modelId);
  const kimiBody = buildRequestBody(modelParams, openAiMessages);
  const bodyBuf = frameConnectJson(kimiBody);

  let token;
  try {
    token = getToken();
  } catch (err) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Token error: " + err.message } }));
    return;
  }

  const upUrl = new URL(UPSTREAM_URL);
  const headers = buildHeaders(token);
  headers["Content-Length"] = bodyBuf.length;

  const options = {
    method: "POST",
    hostname: upUrl.hostname,
    path: upUrl.pathname,
    headers: headers
  };

  logRequest({ endpoint: "/v1/messages", model: modelId, stream, messages_count: messages.length });

  const upReq = https.request(options, (upRes) => {
    if (upRes.statusCode === 401) {
      invalidateToken();
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "Upstream token expired." } }));
      return;
    }

    if (upRes.statusCode !== 200) {
      let errBody = "";
      upRes.on("data", c => errBody += c);
      upRes.on("end", () => {
        res.writeHead(upRes.statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `Upstream error: ${errBody.toString("utf8")}` } }));
      });
      return;
    }

    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });
      processStreamResponse(upRes, res, requestId, modelId);
    } else {
      processBufferResponse(upRes, res, requestId, modelId);
    }
  });

  upReq.on("error", (err) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Network error: " + err.message } }));
  });

  upReq.write(bodyBuf);
  upReq.end();
}

// ─── Anthropic Response Processors ───────────────────────────────────────

async function processStreamResponse(upRes, clientRes, requestId, model) {
  const sendEvent = (event, data) => {
    clientRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent("message_start", {
    type: "message_start",
    message: { id: requestId, type: "message", role: "assistant", model: model, content: [] }
  });

  let blockStarted = false;

  try {
    for await (const frame of parseConnectStream(upRes)) {
      if (frame.flag === 0x02 && frame.parsed?.error) {
        if (!blockStarted) {
          sendEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
          blockStarted = true;
        }
        sendEvent("content_block_delta", {
          type: "content_block_delta", index: 0,
          delta: { type: "text_delta", text: `\n\n[Upstream Error: ${frame.parsed.error.code}]` }
        });
        continue;
      }
      
      const payload = frame.parsed;
      if (!payload) continue;

      if (!blockStarted) {
        sendEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        blockStarted = true;
      }

      let contentDelta = null;
      if (payload.op === "append" && payload.mask === "block.text.content" && payload.block?.text?.content) {
        contentDelta = payload.block.text.content;
      } else if (payload.op === "append" && payload.mask === "block.think.content" && payload.block?.think?.content) {
        contentDelta = payload.block.think.content;
      }

      if (contentDelta) {
        sendEvent("content_block_delta", {
          type: "content_block_delta", index: 0,
          delta: { type: "text_delta", text: contentDelta }
        });
      }
    }
  } catch (err) {
    console.error("Stream processing error:", err);
  }

  if (blockStarted) {
    sendEvent("content_block_stop", { type: "content_block_stop", index: 0 });
  }

  sendEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 42 } });
  sendEvent("message_stop", { type: "message_stop" });
  clientRes.end();
}

async function processBufferResponse(upRes, clientRes, requestId, model) {
  let textContent = "";

  try {
    for await (const frame of parseConnectStream(upRes)) {
      if (frame.flag === 0x02 && frame.parsed?.error) {
        textContent += `\n\n[Upstream Error: ${frame.parsed.error.code}]`;
        continue;
      }

      const payload = frame.parsed;
      if (!payload) continue;

      if (payload.op === "append" && payload.mask === "block.text.content" && payload.block?.text?.content) {
        textContent += payload.block.text.content;
      } else if (payload.op === "append" && payload.mask === "block.think.content" && payload.block?.think?.content) {
        textContent += payload.block.think.content;
      }
    }

    const responseObj = {
      id: requestId,
      type: "message",
      role: "assistant",
      model: model,
      content: [{ type: "text", text: textContent }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    };

    clientRes.writeHead(200, { "Content-Type": "application/json" });
    clientRes.end(JSON.stringify(responseObj));
  } catch (err) {
    clientRes.writeHead(500, { "Content-Type": "application/json" });
    clientRes.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Processing error: " + err.message } }));
  }
}

// ─── Start Server ────────────────────────────────────────────────────────
const MODELS = ["k2d6", "k2d6-thinking", "k2d6-agent", "k2d6-agent-ultra"];

server.listen(PORT, () => {
  console.log(`
  🛸  Kimi Gateway (Anthropic)  v1.0.0
  ──────────────────────────────────
  Port     : ${PORT}
  Upstream : ${UPSTREAM_URL}
  Token    : read from %APPDATA%\\kimi-desktop\\bridge-store\\token-store.json
  Auth key : ${PROXY_KEY}
  Models   : ${MODELS.join(", ")}
  ──────────────────────────────────
  Claude Code CLI config:
    export ANTHROPIC_BASE_URL=http://localhost:${PORT}
    export ANTHROPIC_API_KEY=${PROXY_KEY}
  `);

  try {
    getToken();
    console.log("  ✅  Token loaded — ready\n");
  } catch (e) {
    console.warn(`  ⚠️   ${e.message}\n`);
  }
});

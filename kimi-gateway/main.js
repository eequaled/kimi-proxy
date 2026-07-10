/**
 * main.js
 * 
 * OpenAI-compatible HTTP proxy for Kimi Desktop app.
 * Speaks OpenAI Chat Completions on the frontend (port 18791), 
 * translates to Kimi's Connect-JSON format on the backend.
 * 
 * Usage:
 *   node main.js
 *   PORT=3001 node main.js
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
  extractChatId,
  frameConnectJson,
  parseConnectStream
} from "./kimi-protocol.js";

// ─── Configuration ────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "18793", 10); // Changed from 18791 to avoid AutoClaw collision
const PROXY_KEY = process.env.PROXY_KEY || "mewmew";
const UPSTREAM_URL = "https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat";
const LOG_FILE = path.join(import.meta.dirname, "proxy_requests.json");
const MAX_LOGS = 50;
const TOKEN_TTL_MS = 5 * 60 * 1000;

// ─── Token Cache ──────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiresAt = 0;

// ─── Conversation Stickiness ───────────────────────────────────────────────
let currentChatId = null;

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

// ─── Request Logging (Ring Buffer) ───────────────────────────────────────
function logRequest(summary) {
  let logs = [];
  try {
    if (fs.existsSync(LOG_FILE)) {
      logs = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
    }
  } catch (e) {
    // Ignore read errors
  }
  logs.unshift({ timestamp: new Date().toISOString(), ...summary });
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
  } catch (e) {
    console.error("Failed to write to log file:", e.message);
  }
}

// ─── HTTP Server & Routing ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // Endpoint: Health check
  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "live" }));
    return;
  }

  // Auth validation for protected endpoints
  const authHeader = req.headers.authorization || "";
  const reqKey = authHeader.replace(/^Bearer\s+/i, "");
  if (reqKey !== PROXY_KEY) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid PROXY_KEY", type: "invalid_request_error" } }));
    return;
  }

  // Endpoint: Models
  if (req.method === "GET" && url.pathname === "/v1/models") {
    const models = [
      { id: "k2d6", name: "K2.6 Instant" },
      { id: "k2d6-thinking", name: "K2.6 Thinking" },
      { id: "k2d6-agent", name: "K2.6 Agent", warning: "Rate-limited for free users. Use k2d6-thinking instead." },
      { id: "k2d6-agent-ultra", name: "K2.6 Agent Swarm", warning: "Rate-limited for free users. Use k2d6-thinking instead." }
    ];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: models.map(m => ({
        id: m.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "kimi",
        ...(m.warning ? { warning: m.warning } : {})
      }))
    }));
    return;
  }

  // Endpoint: Chat Completions
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body);
        await handleChatCompletion(req, res, payload);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message, type: "invalid_request_error" } }));
      }
    });
    return;
  }

  // 404 Not Found
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Endpoint not found" } }));
});

// ─── Chat Completion Handler ─────────────────────────────────────────────
async function handleChatCompletion(req, res, payload) {
  const modelId = payload.model || "k2d6";
  const messages = payload.messages || [];
  const stream = !!payload.stream;
  const requestId = "chatcmpl-" + crypto.randomBytes(16).toString("hex");
  const created = Math.floor(Date.now() / 1000);

  // Reset heuristic: short message array (system + 1 user) means new conversation
  if (messages.length <= 2) {
    if (currentChatId) {
      console.log(`[Stickiness] Reset — new conversation (messages.length=${messages.length})`);
    }
    currentChatId = null;
  }

  // Build Kimi Request
  const modelParams = mapModel(modelId);
  const kimiBody = buildRequestBody(modelParams, messages, currentChatId);
  const bodyBuf = frameConnectJson(kimiBody);

  // Prepare Upstream Request
  let token;
  try {
    token = getToken();
  } catch (err) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Token error. Ensure Kimi is logged in. " + err.message } }));
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

  logRequest({ 
    endpoint: "/v1/chat/completions", 
    model: modelId, 
    stream,
    messages_count: messages.length 
  });

  const upReq = https.request(options, (upRes) => {
    // Handle Token Expiry
    if (upRes.statusCode === 401) {
      invalidateToken();
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Upstream token expired, please retry." } }));
      return;
    }

    if (upRes.statusCode !== 200) {
      if (currentChatId) {
        console.log(`[Stickiness] Cleared — upstream returned ${upRes.statusCode}`);
        currentChatId = null;
      }
      let errBody = "";
      upRes.on("data", c => errBody += c);
      upRes.on("end", () => {
        res.writeHead(upRes.statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Upstream error: ${errBody.toString("utf8")}` } }));
      });
      return;
    }

    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });
      processStreamResponse(upRes, res, requestId, created, modelId);
    } else {
      processBufferResponse(upRes, res, requestId, created, modelId);
    }
  });

  upReq.on("error", (err) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Network error: " + err.message } }));
  });

  upReq.write(bodyBuf);
  upReq.end();
}

// ─── Response Processors ─────────────────────────────────────────────────

async function processStreamResponse(upRes, clientRes, requestId, created, model) {
  let hasSentRole = false;
  
  const sendEvent = (dataObj) => {
    clientRes.write(`data: ${JSON.stringify(dataObj)}\n\n`);
  };

  try {
    for await (const frame of parseConnectStream(upRes)) {
      if (frame.flag === 0x02 && frame.parsed?.error) {
        sendEvent({
          id: requestId, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: { content: `\n\n[Upstream Error: ${frame.parsed.error.code}]` } }]
        });
        continue;
      }
      
      const payload = frame.parsed;
      if (!payload) continue;

      // Extract chatId for stickiness
      const chatId = extractChatId(payload);
      if (chatId && chatId !== currentChatId) {
        currentChatId = chatId;
        console.log(`[Stickiness] Captured chatId: ${currentChatId}`);
      }

      if (!hasSentRole) {
        sendEvent({
          id: requestId, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: { role: "assistant" } }]
        });
        hasSentRole = true;
      }

      // Kimi Operational Transforms -> OpenAI Deltas
      if (payload.op === "append" && payload.mask === "block.text.content" && payload.block?.text?.content) {
        sendEvent({
          id: requestId, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: { content: payload.block.text.content } }]
        });
      } else if (payload.op === "append" && payload.mask === "block.think.content" && payload.block?.think?.content) {
        // OpenAI doesn't natively have a reasoning field in standard completion delta (some use reasoning_content).
        // Let's emit it as reasoning_content for Claude/Trae, or just prefix it if needed.
        // We will use the common `reasoning_content` convention for OpenAI-compat thinking models.
        sendEvent({
          id: requestId, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: { reasoning_content: payload.block.think.content } }]
        });
      }

      if (payload.done) {
        // End of stream signal
        break;
      }
    }
  } catch (err) {
    console.error("Stream processing error:", err);
  }

  // Send finish reason
  sendEvent({
    id: requestId, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
  });
  clientRes.write("data: [DONE]\n\n");
  clientRes.end();
}

async function processBufferResponse(upRes, clientRes, requestId, created, model) {
  let textContent = "";
  let thinkContent = "";

  try {
    for await (const frame of parseConnectStream(upRes)) {
      if (frame.flag === 0x02 && frame.parsed?.error) {
        textContent += `\n\n[Upstream Error: ${frame.parsed.error.code}]`;
        continue;
      }

      const payload = frame.parsed;
      if (!payload) continue;

      // Extract chatId for stickiness
      const chatId = extractChatId(payload);
      if (chatId && chatId !== currentChatId) {
        currentChatId = chatId;
        console.log(`[Stickiness] Captured chatId: ${currentChatId}`);
      }

      if (payload.op === "append" && payload.mask === "block.text.content" && payload.block?.text?.content) {
        textContent += payload.block.text.content;
      } else if (payload.op === "append" && payload.mask === "block.think.content" && payload.block?.think?.content) {
        thinkContent += payload.block.think.content;
      }
    }

    const responseObj = {
      id: requestId,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: textContent,
            ...(thinkContent ? { reasoning_content: thinkContent } : {})
          },
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    };

    clientRes.writeHead(200, { "Content-Type": "application/json" });
    clientRes.end(JSON.stringify(responseObj));
  } catch (err) {
    clientRes.writeHead(500, { "Content-Type": "application/json" });
    clientRes.end(JSON.stringify({ error: { message: "Processing error: " + err.message } }));
  }
}

// ─── Start Server ────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
  *** Kimi Gateway (OpenAI)  v1.0.0 ***
  -------------------------------------------------
  Port     : ${PORT}
  Upstream : ${UPSTREAM_URL}
  Token    : read from %APPDATA%\\kimi-desktop\\bridge-store\\token-store.json
  Auth key : ${PROXY_KEY}
  Conv.    : Sticky (resets on restart / new conversation)
  -------------------------------------------------
  Models:
  +--------------------+------------------------------+----------+
  | Model ID           | App Variant                  | Source   |
  +--------------------+------------------------------+----------+
  | k2d6               | K2.6 Instant (fast reply)   | Chat     |
  | k2d6-thinking      | K2.6 Thinking (deep reason) | Chat     |
  | k2d6-agent          | K2.6 Agent (research/docs)  | Work     |
  | k2d6-agent-ultra   | K2.6 Agent Swarm (batches)  | Work     |
  +--------------------+------------------------------+----------+
  [!] Work-panel models (agent, agent-ultra) are rate-limited
     for free users. Use the Chat models instead.
  -------------------------------------------------
  Trae / OpenCode / OpenAI-SDK config:
    baseURL -> http://localhost:${PORT}/v1
    apiKey  -> ${PROXY_KEY}
  `);

  try {
    getToken();
    console.log("  [OK] Token loaded -- ready\n");
  } catch (e) {
    console.warn(`  ⚠️   ${e.message}\n`);
  }
});

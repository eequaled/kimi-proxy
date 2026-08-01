/**
 * server.js
 *
 * Unified single-port proxy for the Kimi Desktop app.
 * Serves BOTH the OpenAI Chat Completions API and the Anthropic Messages API
 * on one port (default 18793):
 *
 *   POST /v1/chat/completions   -> OpenAI format  (Trae, Cursor, OpenAI SDKs)
 *   POST /v1/messages           -> Anthropic format (Claude Code, Anthropic SDKs)
 *
 * Auth is accepted via either `Authorization: Bearer <key>` or `x-api-key: <key>`.
 *
 * Usage:
 *   node server.js
 *   PORT=3001 node server.js
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
  parseToolCalls,
  frameConnectJson,
  parseConnectStream
} from "./kimi-protocol.js";

// ─── Configuration ────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "18793", 10);
const PROXY_KEY = process.env.PROXY_KEY || "mewmew";
const UPSTREAM_URL = "https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat";
const LOG_FILE = path.join(import.meta.dirname, "proxy_requests.json");
const MAX_LOGS = 50;
const TOKEN_TTL_MS = 5 * 60 * 1000;
const TOOL_START = "<tool_call>";
const TOOL_END = "</tool_call>";

// ─── Shared State ─────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiresAt = 0;

// Shared across both protocols: the same upstream chat can be continued
// from either frontend format.
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

// ─── Upstream Request ─────────────────────────────────────────────────────
function upstreamRequest(bodyBuf, token) {
  return new Promise((resolve, reject) => {
    const upUrl = new URL(UPSTREAM_URL);
    const headers = buildHeaders(token);
    headers["Content-Length"] = bodyBuf.length;

    const upReq = https.request({
      method: "POST",
      hostname: upUrl.hostname,
      path: upUrl.pathname,
      headers: headers
    }, (upRes) => resolve(upRes));

    upReq.on("error", reject);
    upReq.write(bodyBuf);
    upReq.end();
  });
}

// ─── Shared Connect-JSON Consumers ────────────────────────────────────────

/**
 * Pump the upstream Connect-JSON stream, normalizing it into protocol-neutral
 * callbacks. Handles chatId stickiness, upstream error frames, and the
 * <tool_call> state machine (only active when hasTools is true).
 */
async function pumpUpstream(upRes, hasTools, emit) {
  let buffer = "";
  let inToolCall = false;

  const processBuffer = () => {
    while (buffer) {
      if (inToolCall) {
        const endIdx = buffer.indexOf(TOOL_END);
        if (endIdx !== -1) {
          const jsonStr = buffer.slice(0, endIdx).trim();
          try {
            const call = JSON.parse(jsonStr);
            if (call.name) emit.onToolCall(call);
            else emit.onText(TOOL_START + buffer.slice(0, endIdx + TOOL_END.length));
          } catch (e) {
            emit.onText(TOOL_START + buffer.slice(0, endIdx + TOOL_END.length));
          }
          buffer = buffer.slice(endIdx + TOOL_END.length);
          inToolCall = false;
        } else {
          break; // Wait for more data
        }
      } else {
        const startIdx = buffer.indexOf(TOOL_START);
        if (startIdx !== -1) {
          emit.onText(buffer.slice(0, startIdx));
          buffer = buffer.slice(startIdx + TOOL_START.length);
          inToolCall = true;
        } else if (hasTools) {
          // Stream safe portion (avoid partial tag)
          const safeLen = Math.max(0, buffer.length - TOOL_START.length);
          if (safeLen > 0) {
            emit.onText(buffer.slice(0, safeLen));
            buffer = buffer.slice(safeLen);
          }
          break;
        } else {
          emit.onText(buffer);
          buffer = "";
          break;
        }
      }
    }
  };

  for await (const frame of parseConnectStream(upRes)) {
    if (frame.flag === 0x02 && frame.parsed?.error) {
      emit.onError(frame.parsed.error.code);
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
      if (hasTools) {
        buffer += payload.block.text.content;
        processBuffer();
      } else {
        emit.onText(payload.block.text.content);
      }
    } else if (payload.op === "append" && payload.mask === "block.think.content" && payload.block?.think?.content) {
      emit.onThink(payload.block.think.content);
    }

    if (payload.done) break;
  }

  // Flush remaining buffer
  if (buffer) emit.onText(inToolCall ? TOOL_START + buffer : buffer);
}

/**
 * Accumulate a non-stream upstream response into plain text.
 * When foldThink is true, thinking text is folded into the main text
 * (Anthropic style); otherwise it is returned separately (OpenAI style).
 */
async function accumulateUpstream(upRes, { foldThink = false } = {}) {
  let text = "";
  let think = "";

  for await (const frame of parseConnectStream(upRes)) {
    if (frame.flag === 0x02 && frame.parsed?.error) {
      text += `\n\n[Upstream Error: ${frame.parsed.error.code}]`;
      continue;
    }

    const payload = frame.parsed;
    if (!payload) continue;

    const chatId = extractChatId(payload);
    if (chatId && chatId !== currentChatId) {
      currentChatId = chatId;
      console.log(`[Stickiness] Captured chatId: ${currentChatId}`);
    }

    if (payload.op === "append" && payload.mask === "block.text.content" && payload.block?.text?.content) {
      text += payload.block.text.content;
    } else if (payload.op === "append" && payload.mask === "block.think.content" && payload.block?.think?.content) {
      if (foldThink) text += payload.block.think.content;
      else think += payload.block.think.content;
    }
  }

  return { text, think };
}

// ─── HTTP Server & Routing ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, anthropic-version, X-Requested-With");

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

  // Auth: accept either OpenAI-style Bearer token or Anthropic-style x-api-key
  const authHeader = req.headers.authorization || "";
  const reqKey = authHeader.replace(/^Bearer\s+/i, "") || req.headers["x-api-key"] || "";
  if (reqKey !== PROXY_KEY) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      type: "error",
      error: { type: "authentication_error", message: "Invalid API key" }
    }));
    return;
  }

  // Endpoint: Models (format depends on which client is talking to us)
  if (req.method === "GET" && url.pathname === "/v1/models") {
    const models = [
      { id: "k2d6", name: "K2.6 Instant" },
      { id: "k2d6-thinking", name: "K2.6 Thinking" },
      { id: "k2d6-agent", name: "K2.6 Agent", warning: "Rate-limited for free users. Use k2d6-thinking instead." },
      { id: "k2d6-agent-ultra", name: "K2.6 Agent Swarm", warning: "Rate-limited for free users. Use k2d6-thinking instead." }
    ];

    if (req.headers["x-api-key"]) {
      // Anthropic-style response
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: models, type: "list" }));
    } else {
      // OpenAI-style response
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
    }
    return;
  }

  // Endpoint: Claude Code token counting
  if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ input_tokens: 42 }));
    return;
  }

  // Endpoint: OpenAI Chat Completions
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body);
        await handleOpenAIChat(res, payload);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message, type: "invalid_request_error" } }));
      }
    });
    return;
  }

  // Endpoint: Anthropic Messages
  if (req.method === "POST" && url.pathname === "/v1/messages") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body);
        await handleAnthropicMessages(res, payload);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: err.message } }));
      }
    });
    return;
  }

  // 404 Not Found
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "Endpoint not found" } }));
});

// ─── OpenAI Handler ───────────────────────────────────────────────────────
async function handleOpenAIChat(res, payload) {
  const modelId = payload.model || "k2d6";
  const messages = payload.messages || [];
  const stream = !!payload.stream;
  const tools = payload.tools || null;
  const hasTools = !!(tools && tools.length > 0);
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
  const kimiBody = buildRequestBody(modelParams, messages, currentChatId, tools);
  const bodyBuf = frameConnectJson(kimiBody);

  let token;
  try {
    token = getToken();
  } catch (err) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Token error. Ensure Kimi is logged in. " + err.message } }));
    return;
  }

  logRequest({
    endpoint: "/v1/chat/completions",
    model: modelId,
    stream,
    messages_count: messages.length
  });

  let upRes;
  try {
    upRes = await upstreamRequest(bodyBuf, token);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Network error: " + err.message } }));
    return;
  }

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
    openaiStreamHandler(upRes, res, requestId, created, modelId, hasTools);
  } else {
    openaiBufferHandler(upRes, res, requestId, created, modelId, hasTools);
  }
}

// ─── Anthropic Handler ────────────────────────────────────────────────────
async function handleAnthropicMessages(res, payload) {
  const modelId = payload.model || "claude-3-5-sonnet-20241022";
  const messages = payload.messages || [];
  const system = payload.system || "";
  const stream = !!payload.stream;
  const tools = payload.tools || null;
  const hasTools = !!(tools && tools.length > 0);
  const requestId = "msg_" + crypto.randomBytes(12).toString("hex");

  // Convert Anthropic tools to OpenAI format
  const openAiTools = tools ? tools.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema
    }
  })) : null;

  // Convert Anthropic messages to OpenAI format (preserving tool calls/results)
  const openAiMessages = [];

  // System prompt as first message
  if (system) {
    let sysText = "";
    if (typeof system === "string") sysText = system;
    else if (Array.isArray(system)) sysText = system.map(s => s.text).join("\n");
    if (sysText) openAiMessages.push({ role: "system", content: sysText });
  }

  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const textParts = m.content.filter(c => c.type === "text").map(c => c.text);
      const toolUses = m.content.filter(c => c.type === "tool_use");
      const msg = {
        role: "assistant",
        content: textParts.join("\n") || null,
      };
      if (toolUses.length > 0) {
        msg.tool_calls = toolUses.map(tu => ({
          id: tu.id,
          type: "function",
          function: { name: tu.name, arguments: JSON.stringify(tu.input) }
        }));
      }
      openAiMessages.push(msg);
    } else if (m.role === "user" && Array.isArray(m.content)) {
      const toolResults = m.content.filter(c => c.type === "tool_result");
      const textParts = m.content.filter(c => c.type === "text").map(c => c.text);
      if (textParts.length > 0) {
        openAiMessages.push({ role: "user", content: textParts.join("\n") });
      }
      for (const tr of toolResults) {
        const content = typeof tr.content === "string" ? tr.content :
          Array.isArray(tr.content) ? tr.content.map(c => c.text || "").join("\n") :
          JSON.stringify(tr.content);
        openAiMessages.push({ role: "tool", tool_call_id: tr.tool_use_id, content });
      }
    } else {
      openAiMessages.push({ role: m.role, content: typeof m.content === "string" ? m.content : "" });
    }
  }

  // Reset heuristic: short message array means new conversation
  if (openAiMessages.length <= 2) {
    if (currentChatId) {
      console.log(`[Stickiness] Reset — new conversation (messages.length=${openAiMessages.length})`);
    }
    currentChatId = null;
  }

  const modelParams = mapModel(modelId);
  const kimiBody = buildRequestBody(modelParams, openAiMessages, currentChatId, openAiTools);
  const bodyBuf = frameConnectJson(kimiBody);

  let token;
  try {
    token = getToken();
  } catch (err) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Token error: " + err.message } }));
    return;
  }

  logRequest({ endpoint: "/v1/messages", model: modelId, stream, messages_count: messages.length });

  let upRes;
  try {
    upRes = await upstreamRequest(bodyBuf, token);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Network error: " + err.message } }));
    return;
  }

  if (upRes.statusCode === 401) {
    invalidateToken();
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "Upstream token expired." } }));
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
    anthropicStreamHandler(upRes, res, requestId, modelId, hasTools);
  } else {
    anthropicBufferHandler(upRes, res, requestId, modelId, hasTools);
  }
}

// ─── OpenAI Response Processors ──────────────────────────────────────────
function openaiStreamHandler(upRes, clientRes, requestId, created, model, hasTools) {
  let hasSentRole = false;
  let toolCallIndex = 0;
  let madeToolCalls = false;

  const sendEvent = (dataObj) => {
    clientRes.write(`data: ${JSON.stringify(dataObj)}\n\n`);
  };

  const ensureRole = () => {
    if (!hasSentRole) {
      sendEvent({
        id: requestId, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: { role: "assistant" } }]
      });
      hasSentRole = true;
    }
  };

  const streamContent = (text) => {
    if (!text) return;
    ensureRole();
    sendEvent({
      id: requestId, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { content: text } }]
    });
  };

  const streamThink = (text) => {
    if (!text) return;
    ensureRole();
    sendEvent({
      id: requestId, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { reasoning_content: text } }]
    });
  };

  const emitToolCall = (call) => {
    ensureRole();
    const callId = `call_${crypto.randomBytes(8).toString("hex")}`;
    sendEvent({
      id: requestId, object: "chat.completion.chunk", created, model,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: toolCallIndex++,
            id: callId,
            type: "function",
            function: {
              name: call.name,
              arguments: typeof call.arguments === "string"
                ? call.arguments
                : JSON.stringify(call.arguments)
            }
          }]
        }
      }]
    });
    madeToolCalls = true;
  };

  pumpUpstream(upRes, hasTools, {
    onText: streamContent,
    onThink: streamThink,
    onToolCall: emitToolCall,
    onError: (code) => streamContent(`\n\n[Upstream Error: ${code}]`)
  }).catch((err) => {
    console.error("Stream processing error:", err);
  }).then(() => {
    // Send finish reason
    sendEvent({
      id: requestId, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: {}, finish_reason: madeToolCalls ? "tool_calls" : "stop" }]
    });
    clientRes.write("data: [DONE]\n\n");
    clientRes.end();
  });
}

async function openaiBufferHandler(upRes, clientRes, requestId, created, model, hasTools) {
  try {
    const { text, think } = await accumulateUpstream(upRes, { foldThink: false });

    // Check for tool calls if tools were provided
    if (hasTools && text) {
      const { cleanText, calls } = parseToolCalls(text);
      if (calls.length > 0) {
        const toolCalls = calls.map((call) => ({
          id: `call_${crypto.randomBytes(8).toString("hex")}`,
          type: "function",
          function: {
            name: call.name,
            arguments: typeof call.arguments === "string"
              ? call.arguments
              : JSON.stringify(call.arguments)
          }
        }));

        const responseObj = {
          id: requestId,
          object: "chat.completion",
          created,
          model,
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: cleanText || null,
              ...(think ? { reasoning_content: think } : {}),
              tool_calls: toolCalls
            },
            finish_reason: "tool_calls"
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        };

        clientRes.writeHead(200, { "Content-Type": "application/json" });
        clientRes.end(JSON.stringify(responseObj));
        return;
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
            content: text,
            ...(think ? { reasoning_content: think } : {})
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

// ─── Anthropic Response Processors ───────────────────────────────────────
function anthropicStreamHandler(upRes, clientRes, requestId, model, hasTools) {
  const sendEvent = (event, data) => {
    clientRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent("message_start", {
    type: "message_start",
    message: { id: requestId, type: "message", role: "assistant", model, content: [] }
  });

  let blockIndex = 0;
  let textBlockOpen = false;
  let madeToolCalls = false;

  const openTextBlock = () => {
    sendEvent("content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } });
    textBlockOpen = true;
  };

  const closeTextBlock = () => {
    if (textBlockOpen) {
      sendEvent("content_block_stop", { type: "content_block_stop", index: blockIndex });
      blockIndex++;
      textBlockOpen = false;
    }
  };

  const streamText = (text) => {
    if (!text) return;
    if (!textBlockOpen) openTextBlock();
    sendEvent("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text } });
  };

  const emitToolCall = (call) => {
    closeTextBlock();
    const toolUseId = "toolu_" + crypto.randomBytes(12).toString("hex");
    sendEvent("content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id: toolUseId, name: call.name, input: {} } });
    const argsStr = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments);
    sendEvent("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: argsStr } });
    sendEvent("content_block_stop", { type: "content_block_stop", index: blockIndex });
    blockIndex++;
    madeToolCalls = true;
  };

  pumpUpstream(upRes, hasTools, {
    onText: streamText,
    onThink: streamText,
    onToolCall: emitToolCall,
    onError: (code) => streamText(`\n\n[Upstream Error: ${code}]`)
  }).catch((err) => {
    console.error("Stream processing error:", err);
  }).then(() => {
    closeTextBlock();

    sendEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: madeToolCalls ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 42 }
    });
    sendEvent("message_stop", { type: "message_stop" });
    clientRes.end();
  });
}

async function anthropicBufferHandler(upRes, clientRes, requestId, model, hasTools) {
  try {
    // Anthropic folds thinking into the single text block
    const { text } = await accumulateUpstream(upRes, { foldThink: true });

    // Check for tool calls if tools were provided
    if (hasTools && text) {
      const { cleanText, calls } = parseToolCalls(text);
      if (calls.length > 0) {
        const content = [];
        if (cleanText) content.push({ type: "text", text: cleanText });
        for (const call of calls) {
          content.push({
            type: "tool_use",
            id: "toolu_" + crypto.randomBytes(12).toString("hex"),
            name: call.name,
            input: typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments
          });
        }

        const responseObj = {
          id: requestId,
          type: "message",
          role: "assistant",
          model,
          content,
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        };

        clientRes.writeHead(200, { "Content-Type": "application/json" });
        clientRes.end(JSON.stringify(responseObj));
        return;
      }
    }

    const responseObj = {
      id: requestId,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
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
server.listen(PORT, () => {
  console.log(`
  *** Kimi Gateway (Unified)  v1.0.0 ***
  -------------------------------------------------
  Port     : ${PORT}
  Upstream : ${UPSTREAM_URL}
  Token    : read from %APPDATA%\\kimi-desktop\\bridge-store\\token-store.json
  Auth key : ${PROXY_KEY}
  Conv.    : Sticky (resets on restart / new conversation)
  -------------------------------------------------
  OpenAI (port ${PORT}):
    baseURL -> http://localhost:${PORT}/v1
    apiKey  -> ${PROXY_KEY}
    models  -> k2d6, k2d6-thinking, k2d6-agent, k2d6-agent-ultra
  -------------------------------------------------
  Anthropic (port ${PORT}):
    export ANTHROPIC_BASE_URL=http://localhost:${PORT}
    export ANTHROPIC_API_KEY=${PROXY_KEY}
    models  -> haiku (instant), sonnet (thinking), opus (agent-ultra)
  -------------------------------------------------
  [!] Work-panel models (agent, agent-ultra) are rate-limited
     for free users. Use the Chat models instead.
  -------------------------------------------------
  `);

  try {
    getToken();
    console.log("  [OK] Token loaded -- ready\n");
  } catch (e) {
    console.warn(`  ⚠️   ${e.message}\n`);
  }
});

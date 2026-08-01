/**
 * kimi-protocol.js
 * 
 * Shared library for translating between standard AI formats (OpenAI/Anthropic)
 * and Kimi's proprietary Connect-JSON protocol.
 */

import fs from "fs";
import path from "path";
import os from "os";

// ─── Token & Auth Management ─────────────────────────────────────────────

/**
 * Get the path to the Kimi token store.
 */
export function getTokenPath() {
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "kimi-desktop",
    "bridge-store",
    "token-store.json"
  );
}

/**
 * Read and extract the access token from Kimi's config file.
 */
export function readToken(tokenPath = getTokenPath()) {
  try {
    const raw = fs.readFileSync(tokenPath, "utf8");
    const data = JSON.parse(raw);
    const token = data.tokens?.access_token;
    if (!token) throw new Error("No access_token found in JSON");
    return token;
  } catch (err) {
    throw new Error(`Failed to read Kimi token: ${err.message}`);
  }
}

/**
 * Decode a JWT without verification to extract payload fields.
 */
export function decodeJwt(jwt) {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");
  const payloadStr = Buffer.from(parts[1], "base64url").toString("utf8");
  return JSON.parse(payloadStr);
}

/**
 * Build the required HTTP headers for the Kimi ChatService endpoint.
 */
export function buildHeaders(token) {
  const jwt = decodeJwt(token);
  return {
    "Content-Type": "application/connect+json",
    "connect-protocol-version": "1",
    "Authorization": `Bearer ${token}`,
    "x-msh-session-id": jwt.ssid || "",
    "x-msh-platform": "windows",
    "x-msh-device-id": jwt.device_id || "",
    "x-msh-version": "3.0.26",
    "x-traffic-id": jwt.sub || "",
    "x-language": "en-US",
    "r-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) kimi-desktop/3.0.26 Chrome/146.0.7680.216 Electron/41.7.2 Safari/537.36 KimiDesktop/3.0.26 Electron/41.7.2 (win32; x64)",
    "Origin": "https://www.kimi.com",
    "Referer": "https://www.kimi.com/?chat_enter_method=new_chat",
  };
}

// ─── Request Conversion (OpenAI -> Kimi) ─────────────────────────────────

/**
 * Map standard model names to Kimi parameters.
 */
export function mapModel(modelId) {
  const id = modelId.toLowerCase();
  
  // Anthropic aliases
  if (id.includes("opus")) return { scenario: "SCENARIO_OK_COMPUTER", thinking: false, agentMode: "TYPE_ULTRA", kimiplusId: "ok-computer" };
  if (id.includes("sonnet")) return { scenario: "SCENARIO_K2D5", thinking: true };
  if (id.includes("haiku")) return { scenario: "SCENARIO_K2D5", thinking: false };
  
  // Explicit mapping
  if (id === "k2d6-agent-ultra") return { scenario: "SCENARIO_OK_COMPUTER", thinking: false, agentMode: "TYPE_ULTRA", kimiplusId: "ok-computer" };
  if (id === "k2d6-agent") return { scenario: "SCENARIO_OK_COMPUTER", thinking: false, agentMode: "TYPE_NORMAL", kimiplusId: "ok-computer" };
  if (id === "k2d6-thinking") return { scenario: "SCENARIO_K2D5", thinking: true };
  
  // Default to fast chat
  return { scenario: "SCENARIO_K2D5", thinking: false };
}

/**
 * Generate tool instructions text from tool definitions.
 * Supports both OpenAI ({type:"function",function:{...}}) and Anthropic ({name,input_schema,...}) formats.
 */
function buildToolPrompt(tools) {
  let text = "You are a tool-calling assistant. You have access to the following tools.\n\n";
  text += "To call a tool, output EXACTLY this format (no markdown, no backticks):\n";
  text += '<tool_call>{"name":"tool_name","arguments":{"param":"value"}}</tool_call>\n\n';
  text += "You can include explanatory text before tool calls. ";
  text += "Tool results will be provided as [Tool Result]. ";
  text += "After receiving a tool result, continue based on the result.\n\n";
  text += "Available tools:\n\n";

  for (const tool of tools) {
    const fn = tool.function || tool;
    const schema = fn.parameters || fn.input_schema;
    text += `${fn.name}: ${fn.description || ""}\n`;
    if (schema && schema.properties) {
      const required = schema.required || [];
      text += "  Parameters:\n";
      for (const [key, prop] of Object.entries(schema.properties)) {
        const req = required.includes(key) ? "required" : "optional";
        text += `    - ${key} (${prop.type || "any"}, ${req})${prop.description ? ": " + prop.description : ""}\n`;
      }
    }
    text += "\n";
  }

  return text.trim();
}

/**
 * Convert OpenAI messages format to Kimi Connect-JSON request payload.
 * Now supports tool definitions, tool_calls in assistant messages, and tool results.
 */
export function buildRequestBody(modelParams, messages, chatId = null, tools = null) {
  let prompt = "";

  // Prepend tool instructions if tools are provided
  if (tools && tools.length > 0) {
    prompt += buildToolPrompt(tools) + "\n\n---\n\n";
  }

  // Flatten messages, handling tool calls and results
  for (const msg of messages) {
    // Tool results (OpenAI format: role "tool")
    if (msg.role === "tool") {
      prompt += `[Tool Result]: ${msg.content}\n`;
      continue;
    }

    // Assistant messages with tool_calls
    if (msg.role === "assistant" && msg.tool_calls) {
      if (msg.content) prompt += msg.content + "\n";
      for (const tc of msg.tool_calls) {
        const fn = tc.function || tc;
        const args = typeof fn.arguments === "string"
          ? fn.arguments
          : JSON.stringify(fn.arguments || fn.input || {});
        prompt += `<tool_call>{"name":"${fn.name}","arguments":${args}}</tool_call>\n`;
      }
      continue;
    }

    // Regular messages (text or array content)
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text") prompt += part.text + "\n";
      }
    } else if (msg.content) {
      prompt += msg.content + "\n";
    }
  }
  prompt = prompt.trim();

  const isAgent = modelParams.scenario === "SCENARIO_OK_COMPUTER";

  const req = {
    scenario: modelParams.scenario,
    tools: isAgent ? [] : [
      { type: "TOOL_TYPE_SEARCH", search: {} },
      { type: "TOOL_TYPE_CRON_JOB" }
    ],
    message: {
      role: "user",
      blocks: [{ message_id: "", text: { content: prompt } }],
      scenario: modelParams.scenario,
      is_goal: false,
    },
    options: { 
      thinking: !!modelParams.thinking, 
      enable_plugin: true 
    },
  };

  if (chatId) {
    req.chatId = chatId;
  }

  if (isAgent) {
    req.kimiplus_id = modelParams.kimiplusId;
    req.agentMode = modelParams.agentMode;
  }

  return req;
}

/**
 * Parse tool calls from Kimi's text response.
 * Looks for <tool_call>{"name":"...","arguments":{...}}</tool_call> blocks.
 * Returns { cleanText, calls } where cleanText has tool call markers removed.
 */
export function parseToolCalls(text) {
  const calls = [];
  const regex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let match;
  let lastIndex = 0;
  let cleanText = "";

  while ((match = regex.exec(text)) !== null) {
    cleanText += text.slice(lastIndex, match.index);
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.name) {
        calls.push({
          name: parsed.name,
          arguments: parsed.arguments || parsed.input || {}
        });
      }
    } catch (e) {
      // JSON parse failed — include the raw text
      cleanText += match[0];
    }
    lastIndex = regex.lastIndex;
  }
  cleanText += text.slice(lastIndex);

  return { cleanText: cleanText.trim(), calls };
}

/**
 * Extract chat ID from a parsed Connect-JSON response frame.
 * Looks for {"op":"set","chat":{"id":"..."}} frames.
 */
export function extractChatId(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.op === "set" && parsed.chat && parsed.chat.id) {
    return parsed.chat.id;
  }
  return null;
}

// ─── Connect-JSON Protocol Framing ───────────────────────────────────────

/**
 * Wrap a JSON object into a Connect-JSON payload.
 * Format: [1-byte flag] [4-byte big-endian length] [JSON bytes]
 * flag: 0x00 for data
 */
export function frameConnectJson(jsonObj) {
  const jsonBytes = Buffer.from(JSON.stringify(jsonObj), "utf8");
  const prefix = Buffer.alloc(5);
  prefix[0] = 0x00;
  prefix.writeUInt32BE(jsonBytes.length, 1);
  return Buffer.concat([prefix, jsonBytes]);
}

/**
 * Generator that yields decoded JSON objects from a stream of Connect-JSON chunks.
 * Handles partial frames and chunk boundaries correctly.
 */
export async function* parseConnectStream(responseStream) {
  let buffer = Buffer.alloc(0);

  for await (const chunk of responseStream) {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 5) {
      const flag = buffer[0];
      const length = buffer.readUInt32BE(1);
      
      const frameSize = 5 + length;
      if (buffer.length < frameSize) {
        // Not enough data for the full frame yet, wait for next chunk
        break;
      }

      const frameData = buffer.subarray(5, frameSize);
      buffer = buffer.subarray(frameSize);

      if (length > 0) {
        const jsonStr = frameData.toString("utf8");
        try {
          const parsed = JSON.parse(jsonStr);
          yield { flag, parsed };
        } catch (err) {
          // Sometimes chunks might have bad JSON formatting or we caught a trailer
          console.error("Connect-JSON parse error:", err.message, "Raw:", jsonStr);
        }
      } else {
        yield { flag, parsed: null };
      }
    }
  }
}

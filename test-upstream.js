/**
 * if something goes wrong youre here test-upstream.js discovery script
 *
 * Reads the Kimi token, builds a minimal Connect-JSON request, POSTs to the
 * ChatService/Chat endpoint, and dumps the raw streaming response (headers +
 * body bytes) to upstream-response-raw.txt so we can learn the format.
 *
 * Usage:
 *   node test-upstream.js                # default: thinking=true, prompt "hi"
 *   node test-upstream.js no-thinking    # thinking=false
 *   node test-upstream.js agent          # SCENARIO_OK_COMPUTER (agent)
 *   node test-upstream.js "your prompt"  # custom prompt with thinking
 */

import https from "https";
import fs from "fs";
import path from "path";
import os from "os";

// ─── Config ────────────────────────────────────────────────────────────────
const TOKEN_FILE = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "kimi-desktop", "bridge-store", "token-store.json"
);
const UPSTREAM_URL =
  "https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat";
const OUTPUT_FILE = path.join(import.meta.dirname, "upstream-response-raw.txt");
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) kimi-desktop/3.0.26 Chrome/146.0.7680.216 Electron/41.7.2 Safari/537.36 KimiDesktop/3.0.26 Electron/41.7.2 (win32; x64)";

// ─── Token reader ──────────────────────────────────────────────────────────
function readToken() {
  const raw = fs.readFileSync(TOKEN_FILE, "utf8");
  const data = JSON.parse(raw);
  const access = data.tokens?.access_token;
  if (!access) throw new Error("No access_token in token-store.json");
  return access; // raw JWT
}

// ─── JWT decoder ───────────────────────────────────────────────────────────
function decodeJwt(jwt) {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");
  const payload = Buffer.from(parts[1], "base64url").toString("utf8");
  return JSON.parse(payload);
}

// ─── Build request body ────────────────────────────────────────────────────
function buildRequestBody(mode, prompt) {
  if (mode === "agent") {
    return {
      scenario: "SCENARIO_OK_COMPUTER",
      tools: [],
      message: {
        role: "user",
        blocks: [{ message_id: "", text: { content: prompt } }],
        scenario: "SCENARIO_OK_COMPUTER",
        is_goal: false,
      },
      options: { thinking: false, enable_plugin: true },
      kimiplus_id: "ok-computer",
      agentMode: "TYPE_NORMAL",
    };
  }
  const thinking = mode !== "no-thinking";
  return {
    scenario: "SCENARIO_K2D5",
    tools: [
      { type: "TOOL_TYPE_SEARCH", search: {} },
      { type: "TOOL_TYPE_CRON_JOB" },
    ],
    message: {
      role: "user",
      blocks: [{ message_id: "", text: { content: prompt } }],
      scenario: "SCENARIO_K2D5",
      is_goal: false,
    },
    options: { thinking, enable_plugin: true },
  };
}

// ─── Connect-JSON framing ──────────────────────────────────────────────────
// Connect-JSON unary requests use a 5-byte prefix:
//   bytes 0-3: big-endian uint32 length of the JSON payload
//   byte 4:    flags (0x00 for unary JSON, 0x02 for streaming)
// followed by the JSON bytes.
function frameConnectJson(jsonStr) {
  const jsonBytes = Buffer.from(jsonStr, "utf8");
  const prefix = Buffer.alloc(5);
  prefix[0] = 0x00; // flag: 0x00 = data
  prefix.writeUInt32BE(jsonBytes.length, 1); // length in bytes 1-4
  return Buffer.concat([prefix, jsonBytes]);
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const arg = process.argv[2] || "";
  let mode = "thinking";
  let prompt = "hi";
  if (arg === "no-thinking") {
    mode = "no-thinking";
  } else if (arg === "agent") {
    mode = "agent";
    prompt = "What is 2+2?";
  } else if (arg && !arg.includes("thinking")) {
    prompt = arg;
  }

  console.log(`[test-upstream] mode=${mode} prompt=${JSON.stringify(prompt)}`);

  const token = readToken();
  console.log(`[test-upstream] token read OK (len=${token.length})`);
  const jwt = decodeJwt(token);
  console.log(
    `[test-upstream] JWT decoded: sub=${jwt.sub} ssid=${jwt.ssid} device=${jwt.device_id} region=${jwt.region}`
  );

  const bodyJson = buildRequestBody(mode, prompt);
  const bodyBuf = frameConnectJson(JSON.stringify(bodyJson));
  console.log(
    `[test-upstream] request body: ${bodyBuf.length} bytes (5-byte prefix + JSON)`
  );

  const url = new URL(UPSTREAM_URL);
  const headers = {
    "Content-Type": "application/connect+json",
    "connect-protocol-version": "1",
    Authorization: `Bearer ${token}`,
    "x-msh-session-id": jwt.ssid,
    "x-msh-platform": "windows",
    "x-msh-device-id": jwt.device_id,
    "x-msh-version": "3.0.26",
    "x-traffic-id": jwt.sub,
    "x-language": "en-US",
    "r-timezone": "Africa/Algiers",
    "User-Agent": USER_AGENT,
    Accept: "*/*",
    Origin: "https://www.kimi.com",
    Referer: "https://www.kimi.com/?chat_enter_method=new_chat",
  };

  const options = {
    method: "POST",
    hostname: url.hostname,
    path: url.pathname,
    headers: { ...headers, "Content-Length": bodyBuf.length },
  };

  console.log(`[test-upstream] POST ${UPSTREAM_URL}`);
  console.log("[test-upstream] streaming response to", OUTPUT_FILE);

  const out = fs.createWriteStream(OUTPUT_FILE);
  out.write(`=== Kimi Upstream Discovery ===\n`);
  out.write(`Timestamp: ${new Date().toISOString()}\n`);
  out.write(`Mode: ${mode}\n`);
  out.write(`Prompt: ${prompt}\n`);
  out.write(`Request URL: ${UPSTREAM_URL}\n`);
  out.write(`\n--- Request Headers ---\n`);
  for (const [k, v] of Object.entries(headers)) {
    out.write(`${k}: ${v}\n`);
  }
  out.write(`\n--- Request Body (JSON) ---\n`);
  out.write(JSON.stringify(bodyJson, null, 2) + "\n");
  out.write(`\n--- Request Body (raw hex, first 20 bytes) ---\n`);
  out.write(bodyBuf.subarray(0, 20).toString("hex") + "\n");

  await new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      console.log(`[test-upstream] response status: ${res.statusCode}`);
      out.write(`\n--- Response Status: ${res.statusCode} ---\n`);
      out.write(`\n--- Response Headers ---\n`);
      for (const [k, v] of Object.entries(res.headers)) {
        out.write(`${k}: ${v}\n`);
      }
      out.write(`\n--- Response Body (raw bytes) ---\n`);

      const chunks = [];
      let byteCount = 0;

      res.on("data", (chunk) => {
        byteCount += chunk.length;
        chunks.push(chunk);
        // Write hex + ascii preview for each chunk
        out.write(
          `\n[chunk ${chunks.length}] ${chunk.length} bytes (total ${byteCount})\n`
        );
        out.write("hex: " + chunk.toString("hex") + "\n");
        // Attempt printable preview
        const printable = chunk
          .toString("latin1")
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ".");
        out.write("ascii: " + printable + "\n");
        // Try to extract JSON objects from the chunk
        const jsonStr = chunk.toString("utf8");
        const jsonMatches = jsonStr.match(/\{[^{}]*\}/g);
        if (jsonMatches) {
          out.write("json segments:\n");
          for (const m of jsonMatches) {
            try {
              out.write("  " + JSON.stringify(JSON.parse(m)) + "\n");
            } catch {
              out.write("  (raw) " + m + "\n");
            }
          }
        }
      });

      res.on("end", () => {
        out.write(`\n--- End of response (${byteCount} bytes total) ---\n`);
        const full = Buffer.concat(chunks);
        // Also save the raw binary for binary analysis
        const rawFile = path.join(
          import.meta.dirname,
          "upstream-response-raw.bin"
        );
        fs.writeFileSync(rawFile, full);
        out.write(`Raw binary saved to: ${rawFile}\n`);

        // Print first 500 chars to console for quick preview
        console.log("\n[test-upstream] First 500 chars of response body:");
        console.log(full.subarray(0, 500).toString("utf8"));
        console.log(`\n[test-upstream] Total response: ${byteCount} bytes`);
        console.log(`[test-upstream] Full output: ${OUTPUT_FILE}`);
        resolve();
      });

      res.on("error", (err) => {
        out.write(`\n--- Response stream error: ${err.message} ---\n`);
        reject(err);
      });
    });

    req.on("error", (err) => {
      console.error("[test-upstream] request error:", err.message);
      out.write(`\n--- Request error: ${err.message} ---\n`);
      out.end();
      reject(err);
    });

    req.write(bodyBuf);
    req.end();
  });

  out.end();
}

main().catch((err) => {
  console.error("[test-upstream] FATAL:", err.message);
  process.exit(1);
});

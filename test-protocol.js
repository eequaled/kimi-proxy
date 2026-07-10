/**
 * test-protocol.js
 * 
 * Verifies the functions in kimi-protocol.js
 */

import {
  getTokenPath,
  readToken,
  decodeJwt,
  buildHeaders,
  mapModel,
  buildRequestBody,
  frameConnectJson,
  parseConnectStream
} from "./kimi-protocol.js";

async function main() {
  console.log("=== Testing kimi-protocol.js ===\n");

  // 1. Token Path & Reading
  const path = getTokenPath();
  console.log(`[x] Token path resolved: ${path}`);
  
  let token;
  try {
    token = readToken();
    console.log(`[x] Token read successfully (length: ${token.length})`);
  } catch (err) {
    console.warn(`[!] Skipping token test (file might not exist): ${err.message}`);
  }

  // 2. JWT Decoding & Headers
  if (token) {
    const jwt = decodeJwt(token);
    console.log(`[x] JWT decoded: sub=${jwt.sub}, ssid=${jwt.ssid}`);
    
    const headers = buildHeaders(token);
    console.log(`[x] Headers built successfully. Content-Type=${headers["Content-Type"]}`);
  }

  // 3. Model Mapping
  const modelsToTest = ["k2d6", "k2d6-thinking", "k2d6-agent", "claude-3-5-sonnet-20241022", "gpt-4o"];
  console.log("\n[x] Model Mapping Tests:");
  for (const m of modelsToTest) {
    console.log(`    ${m} ->`, mapModel(m));
  }

  // 4. Request Builder
  const messages = [
    { role: "user", content: "Hello world" },
    { role: "assistant", content: "Hi" },
    { role: "user", content: "How are you?" }
  ];
  const req = buildRequestBody(mapModel("k2d6-thinking"), messages);
  console.log("\n[x] Request Builder Test:");
  console.log(JSON.stringify(req, null, 2));

  // 5. Connect-JSON Framing
  const framed = frameConnectJson(req);
  console.log(`\n[x] Connect-JSON framing: Buffer size = ${framed.length} bytes (Expected: ${JSON.stringify(req).length + 5})`);

  // 6. Connect-JSON Stream Parser
  console.log("\n[x] Connect-JSON Stream Parser Test:");
  
  // Mock response stream (Readable stream)
  const { Readable } = await import("stream");
  const mockStream = new Readable({
    read() {}
  });

  // Push some frames
  // Frame 1: data
  mockStream.push(frameConnectJson({ op: "append", text: "chunk1" }));
  // Frame 2: data
  mockStream.push(frameConnectJson({ op: "append", text: "chunk2" }));
  // Frame 3: trailer/end
  const trailer = Buffer.alloc(5);
  trailer[0] = 0x02; // end flag
  trailer.writeUInt32BE(2, 1); // length 2
  const trailerData = Buffer.from("{}", "utf8");
  mockStream.push(Buffer.concat([trailer, trailerData]));
  
  mockStream.push(null); // EOF

  const parser = parseConnectStream(mockStream);
  let count = 0;
  for await (const frame of parser) {
    console.log(`    Parsed frame ${++count}: flag=${frame.flag}, data=`, frame.parsed);
  }

  console.log("\n=== All protocol tests passed ===");
}

main().catch(console.error);

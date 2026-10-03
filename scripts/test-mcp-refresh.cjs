"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const {spawn} = require("node:child_process");

const api = http.createServer((req, res) => {
  if (req.method === "HEAD" && req.url === "/stale") { res.writeHead(403); return res.end(); }
  if (req.method === "GET" && req.url === "/api/v1/video/jobs/x") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({requestId: "x", state: "completed", watermarkFreeUrl: `http://127.0.0.1:${api.address().port}/stale`}));
  }
  if (req.method === "POST" && req.url === "/api/v1/video/jobs/x/refresh-url") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({requestId: "x", state: "completed", watermarkFreeUrl: "https://fresh.example/video.mp4", urlRefreshed: true}));
  }
  res.writeHead(404); res.end("{}");
});

function readLine(child) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = chunk => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index >= 0) { child.stdout.off("data", onData); resolve(JSON.parse(buffer.slice(0, index))); }
    };
    child.stdout.on("data", onData);
    child.once("exit", code => reject(new Error(`MCP exited before response (${code})`)));
  });
}

(async () => {
  await new Promise(resolve => api.listen(0, "127.0.0.1", resolve));
  const child = spawn(process.execPath, [path.resolve(__dirname, "../src/mcp-server.cjs")], {
    env: {...process.env, DOUBAO_API_URL: `http://127.0.0.1:${api.address().port}`, DOUBAO_MCP_TIMEOUT_MS: "10000"},
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    child.stdin.write(JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "doubao_get_job", arguments: {requestId: "x"}}}) + "\n");
    const response = await readLine(child);
    const value = response.result?.structuredContent;
    assert.equal(value?.urlRefreshed, true);
    assert.equal(value?.watermarkFreeUrl, "https://fresh.example/video.mp4");
    console.log("MCP stale URL auto-refresh passed");
  } finally {
    child.kill();
    await new Promise(resolve => api.close(resolve));
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {spawn} = require("child_process");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "references", "api-mock.json"), "utf8"));
const port = 8878;
const runtime = path.join(__dirname, "..", "data", "test-runtime");
fs.rmSync(runtime, {recursive: true, force: true});
fs.mkdirSync(runtime, {recursive: true});
const child = spawn(process.execPath, [path.join(__dirname, "test-server-harness.cjs")], {
  cwd: path.join(__dirname, ".."),
  env: {...process.env, DOUBAO_TEST_MODE: "1", DOUBAO_SERVICE_PORT: String(port), DOUBAO_DATA_ROOT: runtime},
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", chunk => { output += chunk.toString(); });
child.stderr.on("data", chunk => { output += chunk.toString(); });

async function waitReady() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`测试服务未启动：${output}`);
}

(async () => {
  try {
    await waitReady();
    for (let round = 1; round <= fixture.rounds; round += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/video/generate?wait=1`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({prompt: `${fixture.prompt}（第${round}轮）`, timeoutMs: 30000})});
      const result = await response.json();
      assert.equal(response.status, 200);
      assert.equal(result.state, fixture.expectedState);
      assert.match(String(result.watermarkedUrl), new RegExp(`^${fixture.expectedWatermarkedPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.ok(result.requestId);
    }
    console.log(`api mock ok (${fixture.rounds} rounds)`);
  } finally {
    child.kill("SIGTERM");
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

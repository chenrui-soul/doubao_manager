"use strict";
const assert = require("node:assert/strict");
const {spawn} = require("node:child_process");
const port = 8898;
const runtime = `${__dirname}/../data/test-api-lifecycle-runtime`;
const fs = require("node:fs");
fs.rmSync(runtime, {recursive: true, force: true}); fs.mkdirSync(runtime, {recursive: true});
const accountsFile = `${runtime}/accounts.json`;
fs.writeFileSync(accountsFile, JSON.stringify({accounts: [{id: "account-001", name: "测试账号", loginState: "logged_in"}]}));
const child = spawn(process.execPath, ["scripts/test-server-harness.cjs"], {env: {...process.env, DOUBAO_TEST_MODE: "1", DOUBAO_SERVICE_PORT: String(port), DOUBAO_DATA_ROOT: runtime, DOUBAO_ACCOUNTS_FILE: accountsFile}, stdio: "ignore"});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await sleep(50); }
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/video/generate?wait=1&waitTimeoutMs=10000`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({prompt: "生命周期测试", model: "Seedance 2.0 Mini", ratio: "16:9", duration: 10})});
    const body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.state, "completed"); assert.match(String(body.watermarkedUrl), /^mock:\/\//);
    const timings = body.timings || body.payload?.timings || {};
    assert.ok(timings.queuedAt, "缺少 queuedAt 阶段时间");
    console.log("api lifecycle ok (create -> poll -> completed with video URL and timings)");
  } finally { child.kill(); }
})().catch(error => { console.error(error.stack || error); child.kill(); process.exitCode = 1; });

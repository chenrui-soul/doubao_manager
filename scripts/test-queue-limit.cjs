"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {spawn} = require("child_process");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "references", "queue-limit.json"), "utf8"));
const port = 8880;
const runtime = path.join(__dirname, "..", "data", "test-queue-limit-runtime");
fs.rmSync(runtime, {recursive: true, force: true});
fs.mkdirSync(runtime, {recursive: true});
const accountsFile = path.join(runtime, "accounts.json");
fs.writeFileSync(accountsFile, JSON.stringify({accounts: [{id: "account-001", name: "测试账号", loginState: "logged_in"}]}));
const child = spawn(process.execPath, [path.join(__dirname, "test-server-harness.cjs")], {
  cwd: path.join(__dirname, ".."),
  env: {...process.env, DOUBAO_TEST_MODE: "1", DOUBAO_TEST_DELAY_MS: "500", DOUBAO_MAX_QUEUE: String(fixture.maxQueue), DOUBAO_SERVICE_PORT: String(port), DOUBAO_DATA_ROOT: runtime, DOUBAO_ACCOUNTS_FILE: accountsFile},
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", chunk => { output += chunk.toString(); });
child.stderr.on("data", chunk => { output += chunk.toString(); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitReady() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (response.ok) return; } catch {}
    await sleep(50);
  }
  throw new Error(`测试服务未启动：${output}`);
}
async function submit(index) {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/video/generate`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({prompt: `队列上限测试 ${index}`, timeoutMs: 30000})});
  return {status: response.status, body: await response.json()};
}

(async () => {
  try {
    await waitReady();
    const responses = await Promise.all(Array.from({length: fixture.submittedCount}, (_, index) => submit(index + 1)));
    assert.equal(responses.filter(item => item.status === 202).length, fixture.expectedAccepted);
    const rejected = responses.find(item => item.status !== 202);
    assert.ok(rejected);
    assert.equal(rejected.status, fixture.expectedRejectedStatus);
    assert.equal(rejected.body.code, fixture.expectedRejectedCode);
    await sleep(1500);
    const jobs = (await (await fetch(`http://127.0.0.1:${port}/api/v1/video/jobs`)).json()).jobs || [];
    assert.equal(jobs.length, fixture.expectedAccepted);
    assert.ok(jobs.every(job => job.state === "completed" && /^mock:\/\//i.test(String(job.watermarkedUrl || ""))));
    console.log(`queue limit ok (${fixture.expectedAccepted} accepted, ${fixture.expectedRejectedStatus} rejected)`);
  } finally {
    child.kill("SIGTERM");
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {performance} = require("node:perf_hooks");
const fixtureFile = path.join(__dirname, "../references/response-performance.json");
if (!fs.existsSync(fixtureFile)) fs.writeFileSync(fixtureFile, JSON.stringify({historyCount: 500, payloadBytes: 3500, reads: 100, slowImage: "https://slow-assets.example/image.png", requestTimeoutMs: 2000}, null, 2));
const fixture = JSON.parse(fs.readFileSync(fixtureFile));
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-response-"));
process.env.DOUBAO_DATA_ROOT = runtime;
process.env.DOUBAO_ACCOUNTS_FILE = path.join(runtime, "accounts.json");
fs.writeFileSync(process.env.DOUBAO_ACCOUNTS_FILE, JSON.stringify({accounts: [{id: "performance-test", loginState: "logged_in", dailyQuotaLimit: 100}]}));
const {TaskStore} = require("../src/task-store.cjs");
const file = path.join(runtime, "history.json");
const store = new TaskStore(file);
store.write({version: 1, jobs: Array.from({length: fixture.historyCount}, (_, i) => ({id: `job-${i}`, state: "queued", created_at: new Date(i * 1000).toISOString(), payload: {prompt: "x".repeat(fixture.payloadBytes)}}))});
let diskReads = 0;
const originalRead = fs.readFileSync;
fs.readFileSync = function(target, ...args) { if (target === file) diskReads++; return originalRead.call(this, target, ...args); };
const started = performance.now();
for (let i = 0; i < fixture.reads; i++) { assert.equal(store.get("job-0").state, "queued"); store.recentJobs(5); }
const historyReadMs = performance.now() - started;
fs.readFileSync = originalRead;
assert.equal(diskReads, 1, "unchanged history must be parsed once, not on every poll");
const copy = store.read(); copy.jobs[0].state = "failed";
assert.equal(store.get("job-0").state, "queued", "returned objects must not mutate the cache");
const external = new TaskStore(file);
external.save({...external.get("job-0"), state: "failed"});
assert.equal(store.get("job-0").state, "failed", "external writes must invalidate the cache immediately");
assert.equal(store.activeJobs().length, fixture.historyCount - 1);

const license = require("../src/license.cjs");
license.checkLicense = license.requireLicense = async () => ({valid: true});
let workerCalls = 0;
globalThis.__doubaoInProcessWorker = {
  detect: async () => ({loggedIn: true}),
  generate: async job => { workerCalls++; assert.equal(job.payload.imageAssets.length, 1); return {ok: true, state: "completed", watermarkedUrl: "https://example.test/result.mp4"}; },
};
const dns = require("node:dns").promises, originalLookup = dns.lookup;
dns.lookup = async (host, options) => host === "slow-assets.example" ? [{address: "93.184.216.34", family: 4}] : originalLookup(host, options);
const originalFetch = global.fetch;
let releaseImage;
const imageGate = new Promise(resolve => { releaseImage = resolve; });
global.fetch = async (url, options) => {
  if (String(url) === fixture.slowImage) return new Response(new ReadableStream({async start(controller) {
    await imageGate;
    controller.enqueue(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]));
    controller.close();
  }}), {headers: {"content-type": "image/png"}});
  return originalFetch(url, options);
};
const service = require("../src/server.cjs");
const report = {historyReadMs, diskReads};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  await new Promise(resolve => service.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    const start = performance.now();
    const response = await fetch(`${base}/api/v1/video/generate`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({prompt: "slow image acceptance test", imageUrls: [fixture.slowImage]}), signal: AbortSignal.timeout(fixture.requestTimeoutMs)});
    const accepted = await response.json();
    report.acceptedMs = performance.now() - start;
    assert.equal(response.status, 202);
    assert.equal(accepted.state, "queued");
    assert.equal(workerCalls, 0, "202 must not wait for provider generation");
    await sleep(30);
    const preparing = await (await fetch(`${base}/api/v1/video/jobs/${accepted.requestId}`)).json();
    assert.equal(preparing.state, "preparing_assets", "slow downloads must have visible progress");
    releaseImage();
    let completed;
    for (let i = 0; i < 60; i++) {
      completed = await (await fetch(`${base}/api/v1/video/jobs/${accepted.requestId}`)).json();
      if (completed.state === "completed") break;
      await sleep(30);
    }
    assert.equal(completed.state, "completed"); assert.equal(workerCalls, 1);
    const bad = await (await fetch(`${base}/api/v1/video/generate`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({prompt: "private image fails safely", imageUrls: ["https://127.0.0.1/private.png"]})})).json();
    let failed;
    for (let i = 0; i < 60; i++) { failed = await (await fetch(`${base}/api/v1/video/jobs/${bad.requestId}`)).json(); if (failed.state === "failed") break; await sleep(30); }
    assert.equal(failed.error.code, "DOUBAO_IMAGE_URL_PRIVATE_BLOCKED"); assert.equal(workerCalls, 1);
    const recovery = new TaskStore(path.join(runtime, "recovery.json"));
    const job = recovery.create("recover-assets", {remoteImageUrls: [fixture.slowImage]});
    recovery.save({...job, state: "preparing_assets"});
    service.recoverInterruptedJobs(recovery);
    assert.equal(recovery.get(job.id).state, "queued");
    assert.equal(recovery.get(job.id).payload.remoteImageUrls[0], fixture.slowImage);
    const logDir = path.join(__dirname, "log"); fs.mkdirSync(logDir, {recursive: true});
    fs.writeFileSync(path.join(logDir, "response-performance.json"), JSON.stringify({...report, passed: true}, null, 2));
    console.log("response performance passed", report);
  } finally {
    releaseImage(); global.fetch = originalFetch; dns.lookup = originalLookup;
    await new Promise(resolve => service.server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

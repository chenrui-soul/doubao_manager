"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const fixture = require("../references/form-data-live-three-images.json");

const api = "http://127.0.0.1:8787/api/v1/video/generate";
const jobApi = id => `http://127.0.0.1:8787/api/v1/video/jobs/${encodeURIComponent(id)}`;
const initialRequestId = String(process.env.DOUBAO_ACCEPTANCE_INITIAL_ID || "").trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidenceFile = path.join(__dirname, "log", `live-acceptance-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

async function submit() {
  const form = new FormData();
  form.append("prompt", fixture.prompt);
  form.append("model", fixture.model);
  form.append("ratio", fixture.ratio);
  form.append("duration", String(fixture.duration));
  form.append("timeoutMs", String(fixture.timeoutMs));
  fixture.urls.forEach(url => form.append("files", url));
  const response = await fetch(api, {method: "POST", body: form});
  const body = await response.json();
  assert.equal(response.status, 202, `HTTP ${response.status}: ${JSON.stringify(body)}`);
  assert.match(String(body.requestId || ""), /^req_[a-z0-9]+_[a-f0-9]+$/);
  return body.requestId;
}

async function awaitTerminal(requestId, index) {
  let lastState = "";
  let lastReportAt = 0;
  while (true) {
    const response = await fetch(jobApi(requestId));
    const body = await response.json();
    assert.equal(response.status, 200, `查询失败：HTTP ${response.status}`);
    if (body.state !== lastState || Date.now() - lastReportAt >= 30_000) {
      console.log(`acceptance ${index}/3 ${requestId}: state=${body.state} account=${body.accountId || "-"}`);
      lastState = body.state;
      lastReportAt = Date.now();
    }
    if (body.state === "completed") {
      assert.match(String(body.watermarkedUrl || ""), /^https:\/\//, "缺少有水印地址");
      assert.match(String(body.watermarkFreeUrl || ""), /^https:\/\//, "缺少无水印地址");
      return body;
    }
    if (["failed", "submission_unknown", "awaiting_login", "awaiting_verification", "paused"].includes(body.state)) {
      throw new Error(`验收 ${index}/3 失败：${JSON.stringify(body)}`);
    }
    await sleep(1000);
  }
}

(async () => {
  fs.mkdirSync(path.dirname(evidenceFile), {recursive: true});
  const results = [];
  for (let index = 1; index <= 3; index += 1) {
    const requestId = index === 1 && initialRequestId ? initialRequestId : await submit();
    const result = await awaitTerminal(requestId, index);
    results.push(result);
    fs.writeFileSync(evidenceFile, `${JSON.stringify({fixture, results}, null, 2)}\n`, "utf8");
    console.log(`acceptance ${index}/3 passed: ${requestId}`);
  }
  console.log(`live acceptance 3/3 passed; evidence=${evidenceFile}`);
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

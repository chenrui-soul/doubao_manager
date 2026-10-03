"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "references", "form-data-live-three-images.json"), "utf8"));

const api = "http://127.0.0.1:8787/api/v1/video/generate";
const jobApi = id => `http://127.0.0.1:8787/api/v1/video/jobs/${encodeURIComponent(id)}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function submitFormData() {
  const form = new FormData();
  form.append("prompt", fixture.prompt);
  form.append("model", fixture.model);
  form.append("ratio", fixture.ratio);
  form.append("duration", String(fixture.duration));
  form.append("timeoutMs", String(fixture.timeoutMs));
  // Repeated Text fields are the exact Postman form-data representation.
  for (const url of fixture.urls) form.append("files", url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 11 * 60 * 1000);
  try {
    const response = await fetch(api, {method: "POST", body: form, signal: controller.signal});
    const queued = await response.json();
    assert.equal(response.status, 202, `HTTP ${response.status}: ${JSON.stringify(queued)}`);
    assert.match(String(queued.requestId || ""), /^req_[a-z0-9]+_[a-f0-9]+$/, "缺少 requestId");
    while (true) {
      const statusResponse = await fetch(jobApi(queued.requestId));
      const body = await statusResponse.json();
      if (body.state === "completed") {
        assert.match(String(body.watermarkedUrl || ""), /^https:\/\//, "缺少有水印地址");
        assert.match(String(body.watermarkFreeUrl || ""), /^https:\/\//, "缺少无水印地址");
        return body;
      }
      if (["failed", "submission_unknown", "awaiting_login", "awaiting_verification", "paused"].includes(body.state)) {
        throw new Error(`任务 ${queued.requestId} 最终状态为 ${body.state}: ${JSON.stringify(body)}`);
      }
      await sleep(1000);
    }
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const results = [];
  for (let attempt = 1; attempt <= fixture.attempts; attempt += 1) {
    const result = await submitFormData();
    results.push(result);
    console.log(`form-data live attempt ${attempt}/${fixture.attempts} ok: ${result.requestId} account=${result.accountId}`);
    if (attempt < fixture.attempts) await sleep(1000);
  }
  assert.equal(results.length, fixture.attempts);
  console.log(`form-data live ok (${results.length} attempts, 3 ordered network images each)`);
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

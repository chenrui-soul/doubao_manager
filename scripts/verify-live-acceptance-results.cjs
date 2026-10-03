"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = process.argv[2];
assert.ok(source, "请传入 live acceptance 证据 JSON 路径");
const evidence = JSON.parse(fs.readFileSync(path.resolve(source), "utf8"));

async function verifyVideoUrl(requestId, kind, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {headers: {range: "bytes=0-1023"}, signal: controller.signal});
    assert.ok([200, 206].includes(response.status), `${requestId} ${kind} HTTP ${response.status}`);
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    assert.match(contentType, /video|octet-stream/, `${requestId} ${kind} 返回类型不是视频：${contentType}`);
    const reader = response.body.getReader();
    const first = await reader.read();
    await reader.cancel();
    assert.ok(first.value?.byteLength > 0, `${requestId} ${kind} 没有返回视频字节`);
    return {kind, status: response.status, contentType, firstChunkBytes: first.value.byteLength, contentRange: response.headers.get("content-range") || null};
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const verification = [];
  for (const result of evidence.results || []) {
    assert.equal(result.state, "completed");
    const urls = [
      ["watermarked", result.watermarkedUrl],
      ["watermark-free", result.watermarkFreeUrl],
    ];
    const checked = [];
    for (const [kind, url] of urls) checked.push(await verifyVideoUrl(result.requestId, kind, url));
    verification.push({requestId: result.requestId, checked});
  }
  const output = path.join(__dirname, "log", `live-acceptance-url-verification-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(output, `${JSON.stringify({source: path.resolve(source), verifiedAt: new Date().toISOString(), verification}, null, 2)}\n`, "utf8");
  console.log(`live result URLs verified: ${verification.length} tasks / ${verification.length * 2} URLs; evidence=${output}`);
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

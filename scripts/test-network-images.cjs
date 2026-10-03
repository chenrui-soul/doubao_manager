"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "references", "network-image-input.json"), "utf8"));
const server = require(path.join(__dirname, "..", "src", "server.cjs"));

async function main() {
  const payload = server.normalizedPayload({prompt: "图1中的人物在海边转身", files: [fixture.url], duration: 10});
  assert.deepEqual(payload.remoteImageUrls, [fixture.url]);
  const markdownPayload = server.normalizedPayload({prompt: "图1中的人物在海边转身", files: `[图片](${fixture.url})`, duration: 10});
  assert.deepEqual(markdownPayload.remoteImageUrls, [fixture.url]);
  const secondUrl = fixture.url.replace("d0a30500-2742-4eae-8aa0-95ee852d5141.png", "d0a30500-2742-4eae-8aa0-95ee852d5141.png?copy=2");
  const multiPayload = server.normalizedPayload({prompt: "图1和图2中的人物在海边转身", files: [fixture.url, secondUrl], duration: 10});
  assert.deepEqual(multiPayload.remoteImageUrls, [fixture.url, secondUrl]);
  assert.equal(payload.timeoutMs >= 10 * 60 * 1000, true);
  const output = await server.downloadRemoteImage(fixture.url, "network-test", 0);
  try {
    assert.equal(output.mime, fixture.expectedMime);
    assert.equal(path.extname(output.path), fixture.expectedExtension);
    assert.equal(fs.existsSync(output.path), true);
    const bytes = fs.readFileSync(output.path);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    await assert.rejects(() => server.assertSafeRemoteImageUrl("https://127.0.0.1/private.png"), /本机或内网/);
    console.log(`network image ok (${output.size} bytes, ${output.mime})`);
  } finally {
    try { fs.unlinkSync(output.path); } catch {}
  }
  server.server.close();
}

main().catch(error => { try { server.server.close(); } catch {} console.error(error); process.exitCode = 1; });

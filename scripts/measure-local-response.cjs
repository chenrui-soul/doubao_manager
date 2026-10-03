"use strict";
const fs = require("node:fs"), path = require("node:path"), {performance} = require("node:perf_hooks");
(async () => {
  const results = {};
  for (const route of ["/health", "/api/v1/accounts", "/api/v1/video/jobs"]) {
    const samples = [];
    for (let i = 0; i < 12; i++) {
      const start = performance.now();
      const response = await fetch(`http://127.0.0.1:8787${route}`, {signal: AbortSignal.timeout(15000)});
      if (!response.ok) throw new Error(`${route}: ${response.status}`);
      await response.arrayBuffer(); samples.push(performance.now() - start);
    }
    const sorted = samples.slice(2).sort((a, b) => a - b);
    results[route] = {medianMs: +sorted[5].toFixed(2), maxMs: +sorted.at(-1).toFixed(2), samplesMs: samples.map(n => +n.toFixed(2))};
  }
  const tag = process.argv.includes("--after") ? "after" : "before";
  const dir = path.join(__dirname, "log"); fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, `local-response-${tag}.json`), JSON.stringify({at: new Date().toISOString(), results}, null, 2));
  console.log(JSON.stringify(results, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });

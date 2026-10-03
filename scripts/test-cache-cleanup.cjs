"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fixture = require("../references/cache-cleanup-fixture.json");
const {cleanupJobTemp, cleanupOrphanTemp, truncateLog, scrubJobAssets} = require("../src/cache-cleaner.cjs");
const {VideoDownloader} = require("../src/vendor/video-downloader.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-cache-test-"));
(async () => { try {
  const temp = path.join(root, "temp");
  fs.mkdirSync(path.join(temp, "downloads"), {recursive: true});
  const oldJobFile = path.join(temp, `${fixture.jobId}_0.png`);
  const oldPart = path.join(temp, "downloads", `${fixture.jobId}.mp4.123.part`);
  const fresh = path.join(temp, "fresh.keep");
  fs.writeFileSync(oldJobFile, "old"); fs.writeFileSync(oldPart, "old"); fs.writeFileSync(fresh, "fresh");
  const oldTime = Date.now() - fixture.maxAgeMs - 1000;
  fs.utimesSync(oldJobFile, oldTime / 1000, oldTime / 1000); fs.utimesSync(oldPart, oldTime / 1000, oldTime / 1000);
  assert.equal(cleanupOrphanTemp(temp, {maxAgeMs: fixture.maxAgeMs}), 2);
  assert.equal(fs.existsSync(fresh), true);

  const active = path.join(temp, `${fixture.jobId}_1.jpg`); fs.writeFileSync(active, "active");
  assert.equal(cleanupJobTemp(temp, fixture.jobId), 1); assert.equal(fs.existsSync(active), false);

  const log = path.join(root, "desktop.log"); fs.writeFileSync(log, Buffer.alloc(fixture.logMaxBytes + 100, "x"));
  assert.equal(truncateLog(log, {maxBytes: fixture.logMaxBytes, keepBytes: fixture.logKeepBytes}), true);
  assert.ok(fs.statSync(log).size <= fixture.logKeepBytes + 100);

  const cleaned = scrubJobAssets({payload: {imageAssets: [{path: "C:/tmp/a.png", ownedByService: true, name: "a.png", order: 1}]}});
  assert.deepEqual(cleaned.payload.imageAssets, [{name: "a.png", order: 1}]);
  const downloadRoot = path.join(root, "downloads");
  const downloaded = await new VideoDownloader({rootProvider: () => downloadRoot, testMode: true}).download({url: "mock://video"}, {jobId: fixture.jobId});
  assert.equal(Object.prototype.hasOwnProperty.call(downloaded, "resultPath"), false);
  assert.deepEqual(fs.readdirSync(downloadRoot), []);
  console.log("cache cleanup ok (job temp, orphan temp, log limit, asset metadata)");
} finally {
  fs.rmSync(root, {recursive: true, force: true});
} })().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

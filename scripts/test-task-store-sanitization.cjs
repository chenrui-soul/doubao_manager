"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fixture = require("../references/task-store-sanitization.json");
const {TaskStore} = require("../src/task-store.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-task-store-"));
const file = path.join(root, "jobs.json");
try {
  const store = new TaskStore(file);
  store.create("sanitize-1", {submittedEvidence: {requestUrl: fixture.requestUrl, referenceUpload: {items: [{path: fixture.temporaryPath, verified: true}]}}});
  const raw = fs.readFileSync(file, "utf8");
  const job = JSON.parse(raw).jobs[0];
  assert.equal(job.payload.submittedEvidence.requestUrl, fixture.expectedRequestUrl);
  assert.equal("path" in job.payload.submittedEvidence.referenceUpload.items[0], false);
  assert.equal(raw.includes("msToken"), false);
  assert.equal(raw.includes("a_bogus"), false);
  console.log("task store sanitization ok (temporary auth query and local upload paths removed)");
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}

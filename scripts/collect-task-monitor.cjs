"use strict";
// Read production state only. Reports and incremental cursors live in assets/.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.join(__dirname, "..");
const data = path.join(process.env.LOCALAPPDATA, "DoubaoVideoManager", "data");
const output = path.join(root, "assets", "task-monitor");
const checkpointFile = path.join(output, "checkpoint.json");
const redact = value => String(value || "")
  .replace(/https?:\/\/[^\s"<>]+/gi, "[URL]")
  .replace(/nxd_[A-Za-z0-9_-]+/g, "[KEY]")
  .replace(/((?:secret|token|cookie|authorization|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
  .slice(0, 2000);
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
(async () => {
  let previous = {jobs: {}};
  try { previous = JSON.parse(fs.readFileSync(checkpointFile, "utf8")); } catch {}
  let health;
  try {
    const response = await fetch("http://127.0.0.1:8787/health", {signal: AbortSignal.timeout(5000)});
    const value = await response.json();
    health = {online: response.ok && value.ok === true, licensed: value.licensed, queue: value.queue};
  } catch { health = {online: false}; }
  // A corrupt/missing store is a collection error, never an empty task list.
  const stored = JSON.parse(fs.readFileSync(path.join(data, "jobs.json"), "utf8"));
  if (!Array.isArray(stored.jobs)) throw new Error("jobs.json 缺少任务列表");
  const counts = {}, codes = {}, seen = {}, changes = [], active = [];
  for (const job of stored.jobs) {
    counts[job.state] = (counts[job.state] || 0) + 1;
    if (job.error?.code) codes[job.error.code] = (codes[job.error.code] || 0) + 1;
    const item = {
      id: job.id, state: job.state, accountId: job.account_id, updatedAt: job.updated_at,
      code: job.error?.code || null, message: redact(job.error?.message),
      providerMessage: redact(job.error?.providerMessageRaw || job.error?.providerMessage),
      submittedVerified: job.error?.submittedVerified === true,
      notSentVerified: job.error?.notSentVerified === true,
      conversationId: job.payload?.conversationId || null,
      imageCount: job.payload?.imageAssets?.length || 0,
      attempts: (job.payload?.attemptHistory || []).map(a => ({accountId:a.accountId,at:a.at,code:a.code,message:redact(a.message)})),
    };
    seen[job.id] = hash(item);
    if (previous.jobs?.[job.id] !== seen[job.id]) changes.push(item);
    if (["queued", "selecting_account", "checking_login", "uploading", "configuring", "submitting", "generating", "downloading"].includes(job.state)) {
      active.push({...item, unchangedMinutes: Math.max(0, Math.round((Date.now() - Date.parse(job.updated_at)) / 60000))});
    }
  }
  const timestamp = new Date().toISOString();
  const report = {timestamp,baseline:!previous.timestamp,health,total:stored.jobs.length,counts,errorCodes:codes,active,changes};
  fs.mkdirSync(output, {recursive: true});
  const write = (file, value) => { fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 2) + "\n", "utf8"); fs.renameSync(file + ".tmp", file); };
  write(path.join(output, "latest.json"), report);
  if (changes.length || hash(previous.health) !== hash(health)) write(path.join(output, timestamp.replace(/[:.]/g, "-") + ".json"), report);
  write(checkpointFile, {timestamp,health,jobs:seen});
  console.log(JSON.stringify({timestamp,health,total:stored.jobs.length,counts,changed:changes.length,active:active.length,report:path.join(output,"latest.json")},null,2));
})().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });

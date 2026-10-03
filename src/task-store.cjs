"use strict";

const fs = require("fs");

function sanitizeEvidenceUrl(value) {
  const text = String(value || "");
  if (!text) return text;
  try { const parsed = new URL(text); return `${parsed.origin}${parsed.pathname}`; }
  catch { return text.split("?", 1)[0]; }
}

function sanitizeSubmittedEvidence(value) {
  if (!value || typeof value !== "object") return value;
  const evidence = JSON.parse(JSON.stringify(value));
  if (evidence.requestUrl) evidence.requestUrl = sanitizeEvidenceUrl(evidence.requestUrl);
  if (Array.isArray(evidence.referenceUpload?.items)) {
    evidence.referenceUpload.items = evidence.referenceUpload.items.map(item => {
      const clean = {...item}; delete clean.path; return clean;
    });
  }
  return evidence;
}

function sanitizeStoredJob(job) {
  const clean = JSON.parse(JSON.stringify(job));
  if (clean.payload?.submittedEvidence) clean.payload.submittedEvidence = sanitizeSubmittedEvidence(clean.payload.submittedEvidence);
  if (clean.result?.submittedEvidence) clean.result.submittedEvidence = sanitizeSubmittedEvidence(clean.result.submittedEvidence);
  return clean;
}

class TaskStore {
  constructor(file) {
    this.file = file.endsWith(".json") ? file : `${file}.json`;
    fs.mkdirSync(require("path").dirname(this.file), {recursive: true});
    if (!fs.existsSync(this.file)) this.write({version: 1, jobs: []});
  }
  snapshot() {
    try {
      const stat = fs.statSync(this.file, {bigint: true});
      const signature = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      if (this.cachedSignature !== signature) {
        const value = JSON.parse(fs.readFileSync(this.file, "utf8"));
        this.cachedValue = value && Array.isArray(value.jobs) ? value : {version: 1, jobs: []};
        this.cachedSignature = signature;
        this.sortedJobs = null;
      }
      return this.cachedValue;
    } catch {
      this.cachedSignature = null;
      this.sortedJobs = null;
      return {version: 1, jobs: []};
    }
  }
  revision() { this.snapshot(); return this.cachedSignature; }
  read() { return this.clone(this.snapshot()); }
  write(value) { const temp = `${this.file}.${process.pid}.tmp`; const clean = {...value, jobs: Array.isArray(value?.jobs) ? value.jobs.map(sanitizeStoredJob) : []}; fs.writeFileSync(temp, JSON.stringify(clean, null, 2), {encoding: "utf8", mode: 0o600}); fs.renameSync(temp, this.file); this.cachedSignature = null; this.sortedJobs = null; }
  clone(job) { return job ? JSON.parse(JSON.stringify(job)) : null; }
  create(id, payload) { const now = new Date().toISOString(); const value = this.read(); const nextPayload = {...(payload || {}), timings: {...(payload?.timings || {}), queuedAt: now}}; const job = {id, state: "queued", account_id: null, payload: nextPayload, result: null, error: null, created_at: now, updated_at: now}; value.jobs.push(job); this.write(value); return this.clone(job); }
  save(job) { const value = this.read(); const index = value.jobs.findIndex(item => item.id === job.id); if (index < 0) throw new Error("任务不存在"); const next = {...job, updated_at: new Date().toISOString()}; value.jobs[index] = next; this.write(value); return this.clone(next); }
  get(id) { return this.clone(this.snapshot().jobs.find(item => item.id === String(id))); }
  activeJobs() { const states = new Set(["queued", "preparing_assets", "selecting_account", "checking_login", "uploading", "configuring", "submitting", "generating", "downloading", "awaiting_login", "awaiting_verification", "submission_unknown"]); return this.snapshot().jobs.filter(job => states.has(job.state)).map(job => this.clone(job)); }
  recentJobs(limit = 50) { const value = this.snapshot(); if (!this.sortedJobs) this.sortedJobs = value.jobs.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))); return this.sortedJobs.slice(0, Math.max(1, Number(limit) || 50)).map(job => this.clone(job)); }
  close() {}
}

module.exports = {TaskStore, sanitizeEvidenceUrl, sanitizeSubmittedEvidence, sanitizeStoredJob};

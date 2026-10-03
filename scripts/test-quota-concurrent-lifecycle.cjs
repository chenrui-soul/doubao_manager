"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-quota-concurrent-"));
process.env.DOUBAO_DATA_ROOT = runtime;
process.env.DOUBAO_ACCOUNTS_FILE = path.join(runtime, "accounts.json");
fs.writeFileSync(process.env.DOUBAO_ACCOUNTS_FILE, JSON.stringify({accounts: [1, 2, 3, 4].map(i => ({
  id: `account-${i}`, loginState: "logged_in", dailyQuotaLimit: 2,
}))}));
const license = require("../src/license.cjs");
license.requireLicense = license.checkLicense = async () => ({valid: true});
const calls = new Map();
let active = 0, maxActive = 0;
globalThis.__doubaoInProcessWorker = {
  detect: async () => ({loggedIn: true}),
  generate: async job => {
    calls.set(job.account.id, (calls.get(job.account.id) || 0) + 1);
    maxActive = Math.max(maxActive, ++active);
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      const quotaFailure = {ok: false, code: "DOUBAO_VIDEO_QUOTA_EXHAUSTED", message: "今日视频额度已用完", submittedVerified: true, notSentVerified: false, quotaConsumed: false};
      if (job.account.id === "account-1") return quotaFailure;
      if (job.account.id === "account-2") throw Object.assign(new Error(quotaFailure.message), quotaFailure);
      return {ok: true, state: "completed", watermarkedUrl: `https://example.test/${job.id}.mp4`};
    } finally { active--; }
  },
};
const service = require("../src/server.cjs");
const {TaskStore} = require("../src/task-store.cjs");
const {AccountStore} = require("../src/account-store.cjs");
const {accountQuota} = require("../src/quota-summary.cjs");
const store = new TaskStore(path.join(runtime, "jobs.json"));
(async () => {
  for (let i = 0; i < 10; i++) service.scheduleJob(store.create(`quota-concurrent-${i}`, {prompt: "isolated test", model: "Seedance 2.0 Mini"}));
  const deadline = Date.now() + 5000;
  let jobs;
  do {
    await new Promise(resolve => setTimeout(resolve, 40));
    jobs = store.recentJobs(10);
  } while (jobs.some(job => !["completed", "failed", "submission_unknown"].includes(job.state)) && Date.now() < deadline);
  assert.equal(jobs.filter(job => job.state === "completed").length, 8);
  assert.equal(jobs.filter(job => job.state === "submission_unknown").length, 2);
  assert.equal(jobs.filter(job => job.state === "failed").length, 0);
  assert.equal(maxActive, 4, "independent accounts can execute concurrently");
  assert.equal(calls.get("account-1"), 1, "provider-exhausted account must not be called twice");
  assert.equal(calls.get("account-2"), 1, "thrown quota error must also block later dispatch");
  assert.equal(calls.get("account-3") + calls.get("account-4"), 8, "local estimate zero must not block further successful generations");
  const accounts = new AccountStore(process.env.DOUBAO_ACCOUNTS_FILE).list();
  for (const id of ["account-1", "account-2"]) {
    const account = accounts.find(item => item.id === id);
    assert.ok(account.quotaDisabledUntil > Date.now(), "both returned and thrown quota failures persist cooldown");
    assert.equal(accountQuota(account, jobs).quotaRecordedToday, 0, "explicit no-charge evidence must survive attempt history");
  }
  assert.equal(service.reconcilePersistedQuotaCooldowns().accountIds.length, 2, "estimated quota errors must not become provider-confirmed cooldowns");
  console.log("10 concurrent jobs: 4 parallel accounts, 8 completed beyond local estimates, 2 provider quota holds; no repeated dispatch to exhausted accounts");
})().catch(error => { console.error(error); process.exitCode = 1; });

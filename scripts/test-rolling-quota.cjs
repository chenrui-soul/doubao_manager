"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-rolling-quota-"));
process.env.DOUBAO_DATA_ROOT = runtime;
process.env.DOUBAO_ACCOUNTS_FILE = path.join(runtime, "accounts.json");
const {AccountStore} = require("../src/account-store.cjs");
const {AccountScheduler} = require("../src/account-scheduler.cjs");
const {accountQuota} = require("../src/quota-summary.cjs");
const {quotaFailureDetails} = require("../src/quota-exhaustion.cjs");
const {classifyDoubaoFailureMessage, detectTrustedQuotaMessage} = require("../src/vendor/browser-controller.cjs");
const license = require("../src/license.cjs");
license.checkLicense = license.requireLicense = async () => ({valid:true});
const store = new AccountStore(process.env.DOUBAO_ACCOUNTS_FILE);
store.write([7,30].map(days => ({id:`quota-${days}`,name:`test-${days}`,loginState:"logged_in"})));
const calls = new Map();
globalThis.__doubaoInProcessWorker = {
  detect: async () => ({loggedIn:true}),
  generate: async job => {
    calls.set(job.account.id,(calls.get(job.account.id)||0)+1);
    const message = `近${job.account.id.endsWith('30') ? 30 : 7}天免费额度已用完`;
    const failure = {ok:false,...classifyDoubaoFailureMessage(message),message};
    if (job.account.id.endsWith('30')) throw Object.assign(new Error(message),failure);
    return failure;
  }
};
const service = require("../src/server.cjs");
const {TaskStore} = require("../src/task-store.cjs");
const jobs = new TaskStore(path.join(runtime,"jobs.json"));

(async () => {
  // Both functions run as serialized code in the provider page, too.
  const detector = vm.runInNewContext(`(${detectTrustedQuotaMessage.toString()})`);
  const classifier = vm.runInNewContext(`(${classifyDoubaoFailureMessage.toString()})`);
  for (const [text,days] of [["近7天免费额度已用完",7],["近30天免费额度已用完",30],["近 7 天 免费额度 已用完",7],["最近三十天免费额度耗尽",30]]) {
    assert.ok(detector([text]));
    const failure = classifier(text);
    assert.equal(failure.quotaExhausted,true);
    assert.equal(failure.notSentVerified,true);
    assert.equal(quotaFailureDetails(failure).quotaWindowDays,days);
  }
  for (const text of ["近7天免费额度未用完","近30天免费额度剩余20%","近30天免费额度","免费额度将于明日恢复"]) {
    assert.equal(detector([text]),"");
    assert.equal(classifier(text).quotaExhausted,false);
  }
  assert.equal(classifier("近7天免费额度已用完。本次将消耗付费额度，视频生成中").quotaExhausted,false);
  assert.match(detector(["视频生成额度已用完，近30天免费额度已用完"]), /近30天/);
  await new Promise(resolve=>service.server.listen(0,"127.0.0.1",resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const json = async (url, options) => {const r=await fetch(base+url,options); return {status:r.status,body:await r.json()};};
  const post = prompt => json("/api/v1/video/generate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({prompt})});
  const queued=await post("isolated test");
  assert.equal(queued.status,202);
  const deadline=Date.now()+5000;
  while (Date.now()<deadline && jobs.get(queued.body.requestId)?.state!=="failed") await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(jobs.get(queued.body.requestId).state,"failed");
  assert.equal(calls.get("quota-7"),1);
  assert.equal(calls.get("quota-30"),1);
  const next=await post("must not redispatch exhausted accounts");
  const end=Date.now()+5000;
  while(Date.now()<end && jobs.get(next.body.requestId)?.state!=="failed") await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(jobs.get(next.body.requestId).state,"failed");
  assert.equal(calls.get("quota-7"),1);
  assert.equal(calls.get("quota-30"),1);
  for(const account of store.list()) {
    assert.equal(account.quotaRequiresRecheck,true);
    assert.equal(account.quotaDisabledUntil,null,"unknown reset time must not be midnight or now+windowDays");
    assert.equal(accountQuota(account,[],Date.now()+40*86400000).quotaExhausted,true);
    assert.equal(accountQuota(account,[]).actualFreeQuotaRemaining,0);
    assert.equal(accountQuota(account,[]).actualQuotaRemaining,null);
  }
  const scheduler = new AccountScheduler(store.list());
  scheduler.pruneExpired(Date.now()+40*86400000);
  assert.equal(scheduler.available().length,0,"holds survive reload and crossing days");
  assert.equal(scheduler.available({allowPaidQuota:true}).length,2);
  scheduler.disable(store.list()[0], 0, "temporary");
  assert.equal(scheduler.available().length,0,"an expired temporary error cannot erase a persisted rolling hold");
  assert.equal(scheduler.enable("quota-7"),false,"ordinary login/resume cannot clear hold");
  const monitor = await scheduler.acquire(1000,"quota-7",[],{monitorExisting:true});
  scheduler.release(monitor);
  // Reconcile a historical failure, then explicitly release it through the API.
  const historical = jobs.create("historic-rolling", {});
  jobs.save({...historical,account_id:"quota-7",state:"failed",error:{code:"DOUBAO_VIDEO_QUOTA_EXHAUSTED",message:"近7天免费额度已用完"}});
  const listed=await json("/api/v1/accounts");
  assert.ok(listed.body.accounts.every(a=>a.disabledReason==="quota_exhausted" && a.disabledUntil===null && a.quotaRequiresRecheck));
  const reset=await json("/api/v1/accounts/quota-7",{method:"PATCH",headers:{"content-type":"application/json"},body:'{"resetQuotaExhaustion":true}'});
  assert.equal(reset.status,200);
  assert.equal(reset.body.account.quotaExhausted,false);
  const refreshed=await json("/api/v1/accounts");
  assert.equal(refreshed.body.accounts.find(a=>a.id==="quota-7").quotaExhausted,false,"old jobs must not undo an explicit reset");
  assert.equal(refreshed.body.accounts.find(a=>a.id==="quota-30").quotaRequiresRecheck,true);
  console.log("rolling quota: detection, returned/thrown errors, no redispatch, restart persistence, API display and manual reset passed");
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(service.server.listening) await new Promise(resolve=>service.server.close(resolve));
  jobs.close();
});

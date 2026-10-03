"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-stage-a-"));
process.env.DOUBAO_DATA_ROOT = runtime;
process.env.DOUBAO_ACCOUNTS_FILE = path.join(runtime, "accounts.json");
process.env.DOUBAO_TEST_MODE = "1";
const {quotaFailureDetails} = require("../src/quota-exhaustion.cjs");
const failures = [];
function check(name, fn) { try { fn(); console.log("PASS", name); } catch (e) { failures.push(name); console.error("FAIL", name, e.message); } }
check("7-day quota without 免费 must not reset at midnight", () => {
  const d = quotaFailureDetails({providerMessageRaw:"最近视频创作消耗了较多额度，近 7 天的额度用完了，预计 10 月 5 日 18:34 恢复为你服务。"});
  assert.equal(d.quotaWindowDays, 7); assert.equal(d.quotaRequiresRecheck, true);
});
check("unknown quota window requires recheck", () => assert.equal(quotaFailureDetails({message:"视频额度已用完"}).quotaRequiresRecheck, true));
const service = require("../src/server.cjs");
check("confirmation failure is not a pre-submission failure", () => assert.equal(service.isPreSubmissionFailure(null, {code:"DOUBAO_CONFIRMATION_INPUT_NOT_READY",submissionUnknown:true,notSentVerified:false}), false));
check("delivered confirmation with original context permits read-only recovery", () => {
  const job={state:"submission_unknown",account_id:"a",payload:{conversationId:"123456789",userMessageId:"original"},error:{code:"DOUBAO_CONFIRMATION_QUEUED",notSentVerified:false,monitorDiagnostic:{confirmation:{delivery:{delivered:true,queued:true,conversationId:"123456789",userMessageId:"confirmation"}}}}};
  assert.equal(service.canRecoverExistingResult(job),true);
  job.error.monitorDiagnostic.confirmation.delivery.conversationId="other";
  assert.equal(service.canRecoverExistingResult(job),false);
});
check("restart must not resend an ambiguous selecting-account job", () => {
  let job = {id:"stale", state:"selecting_account", account_id:"a", payload:{attemptHistory:[{accountId:"a",code:"DOUBAO_RESULT_WAIT_RETRYING",notSentVerified:false}]}};
  service.recoverInterruptedJobs({activeJobs:()=>[job],save:j=>(job=j)});
  assert.equal(job.state,"submission_unknown");
});
if(failures.length) process.exitCode=1;

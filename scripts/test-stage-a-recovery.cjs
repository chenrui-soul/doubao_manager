"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"doubao-A-recovery-"));
process.env.DOUBAO_DATA_ROOT=root;process.env.DOUBAO_ACCOUNTS_FILE=path.join(root,"accounts.json");
fs.writeFileSync(process.env.DOUBAO_ACCOUNTS_FILE,JSON.stringify({accounts:[{id:"old-account",loginState:"logged_in"}]}));
const {TaskStore}=require("../src/task-store.cjs");const store=new TaskStore(path.join(root,"jobs.json"));
const at="2026-09-29T07:00:00Z";
store.write({version:1,jobs:[
 {id:"stale",state:"selecting_account",created_at:at,updated_at:at,payload:{attemptHistory:[{accountId:"old-account",notSentVerified:false}]},account_id:"old-account"},
 {id:"modal",state:"submission_unknown",created_at:at,updated_at:at,payload:{},account_id:"old-account",error:{code:"DOUBAO_VIDEO_TASK_NOT_CREATED",monitorDiagnostic:{pageConfirmationText:"安全确认 你上传的素材均已获充分授权 取消 确认"}}},
 {id:"confirmation",state:"failed",created_at:at,updated_at:at,payload:{attemptHistory:[{accountId:"old-account",at,code:"DOUBAO_CONFIRMATION_INPUT_NOT_READY",notSentVerified:false}]},account_id:"old-account",error:{code:"DOUBAO_CONFIRMATION_INPUT_NOT_READY",notSentVerified:true}},
 {id:"quota",state:"submission_unknown",created_at:at,updated_at:at,payload:{},account_id:"old-account",error:{code:"DOUBAO_VIDEO_QUOTA_EXHAUSTED",message:"近7天的额度用完",quotaExhausted:true,terminalFailureVerified:true}}
]});
let generated=0;globalThis.__doubaoInProcessWorker={generate(){generated++;throw new Error("must never generate historical unknown tasks");}};
const service=require("../src/server.cjs");
const first=service.initializeRecovery();assert.equal(first.scheduled,0);assert.equal(generated,0);
assert.equal(store.get("stale").state,"submission_unknown");assert.equal(store.get("modal").state,"awaiting_verification");assert.equal(store.get("confirmation").error.notSentVerified,false);assert.equal(store.get("quota").state,"failed");
assert.deepEqual(service.initializeRecovery(),{recovered:0,scheduled:0});
const {AccountStore}=require("../src/account-store.cjs");const account=new AccountStore(process.env.DOUBAO_ACCOUNTS_FILE).list()[0];assert.equal(account.generationHealth.blocked,true);assert.equal(account.quotaWindowDays,7);
console.log("Stage A startup recovery passed: historical evidence repair, no resubmission, persisted health/quota, idempotent startup");

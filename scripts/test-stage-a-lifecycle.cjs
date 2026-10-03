"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"doubao-A-lifecycle-"));
process.env.DOUBAO_DATA_ROOT=root;process.env.DOUBAO_ACCOUNTS_FILE=path.join(root,"accounts.json");
const {AccountStore}=require("../src/account-store.cjs"),{TaskStore}=require("../src/task-store.cjs");
const accountStore=new AccountStore(process.env.DOUBAO_ACCOUNTS_FILE);
accountStore.write([{id:"fixture",loginState:"logged_in"}]);
const license=require("../src/license.cjs");license.checkLicense=license.requireLicense=async()=>({valid:true});
let failure,progress;
globalThis.__doubaoInProcessWorker={setProgressHandler:f=>progress=f,detect:async()=>({loggedIn:true}),checkGeneration:async()=>({ok:true}),generate:async job=>{
  await progress({jobId:job.id,accountId:job.account.id,state:"submitting",conversationId:"123456789",submittedEvidence:{evidenceType:"chat-message-delivered",conversationId:"123456789",userMessageId:"message-1",confirmed:false}});
  throw Object.assign(new Error(failure.message),failure);
}};
const service=require("../src/server.cjs"),store=new TaskStore(path.join(root,"jobs.json"));
(async()=>{
 failure={code:"DOUBAO_CONFIRMATION_INPUT_NOT_READY",message:"确认输入未就绪",notSentVerified:false,submissionUnknown:true,safeToRetry:false};
 for(const id of ["confirmation-1","confirmation-2"]){await service.executeJob(store.create(id,{prompt:"fixture",imageAssets:[]}));const j=store.get(id);assert.equal(j.state,"submission_unknown");assert.equal(j.error.notSentVerified,false);assert.equal(j.error.submittedVerified,false);assert.equal(j.payload.conversationId,"123456789");}
 assert.equal(accountStore.list()[0].generationHealth.blocked,true);
 await service.executeJob(store.create("blocked",{prompt:"fixture"}));
 assert.fail("blocked account must not accept a new generation");
 // Direct execution returns the scheduler error; the HTTP dispatcher wraps it.
})().catch(async e=>{
 if(e.code!=="DOUBAO_ACCOUNTS_NEED_CHECK")throw e;
 await new Promise(r=>service.server.listen(0,"127.0.0.1",r));
 const base=`http://127.0.0.1:${service.server.address().port}`;
 const reset=await fetch(base+"/api/v1/accounts/fixture/check-generation",{method:"POST"});assert.equal(reset.status,200);
 assert.equal(accountStore.list()[0].generationHealth.blocked,false);
 failure={code:"DOUBAO_VIDEO_QUOTA_EXHAUSTED",message:"近 7 天的额度用完",quotaExhausted:true,terminalFailureVerified:true,notSentVerified:false,submittedVerified:false,quotaConsumed:false};
 await service.executeJob(store.create("quota",{prompt:"fixture"}));
 assert.equal(store.get("quota").state,"failed");assert.equal(store.get("quota").payload.conversationId,"123456789");assert.equal(accountStore.list()[0].quotaWindowDays,7);
 const {nextGenerationHealth}=require("../src/generation-health.cjs");
 assert.equal(nextGenerationHealth({}, {code:"DOUBAO_PARAMETER_CONFIG_FAILED",message:"视频时长滑杆未响应"},"excluded").blocked,undefined);
 console.log("Stage A lifecycle: durable context, unknown != confirmed, repeated-fault pause, explicit recheck, quota terminal and duration exclusion passed");
}).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{if(service.server.listening)service.server.close();});

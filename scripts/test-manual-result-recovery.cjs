"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {TaskStore}=require("../src/task-store.cjs"),{TaskActions}=require("../src/task-actions.cjs");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"doubao-manual-recovery-")),store=new TaskStore(path.join(root,"jobs.json"));
const account={id:"original"},scheduler={busy:new Set(),release:a=>scheduler.busy.delete(a.id)},running=new Map(),waiting=new Set();
let probe, recoverCount=0, scheduled=[], recoverError=null, invalidResult=false, gate=null;
const worker={inspectTask:async()=>{if(gate)await gate;return probe;},freezeTakeover:async()=>{},takeoverTask:async()=>{},recoverTaskResult:async(j,c)=>{recoverCount++;assert.equal(j.account.id,"original");assert.equal(j.taskContext.conversationId,"123456789");if(recoverError)throw recoverError;return {ok:true,state:"completed",conversationId:invalidResult?"999999999":"123456789",resultMessageId:c.messageId,watermarkedUrl:"https://example.invalid/selected.mp4",watermarkFreeUrl:"https://example.invalid/free.mp4"};}};
const options={store,scheduler,worker,accounts:()=>[account],running,waiting,scheduleJob:j=>scheduled.push(j),canRecover:j=>j.state==="submission_unknown"};
const actions=new TaskActions(options);
const candidate=(id,anchored=false)=>({id,fingerprint:`fp-${id}`,messageId:`reply-${id}`,ready:true,anchored,videoVid:`video_${id}`,text:"视频已生成完成"});
function job(id,extra={}) {const j=store.create(id,{prompt:"original prompt",conversationId:"123456789",userMessageId:"original-user",submittedAt:"2026-10-01T12:00:00Z"});return store.save({...j,state:"failed",account_id:"original",manualControl:{active:false,startedAt:"2026-10-01T13:00:00Z"},error:{code:"DOUBAO_CONTENT_REJECTED",providerTerminal:true,message:"豆包原话：无法返回该内容"},...extra});}
async function check(name,fn){await fn();console.log(`PASS ${name}`);}
(async()=>{
 await check("original message absent: require explicit selection and preserve refusal",async()=>{
  job("missing");probe={conversationMatches:true,matched:false,candidates:[candidate("new")]};
  const value=await actions.run("missing","recover-result");assert.equal(value.result.needsSelection,true);assert.equal(recoverCount,0);assert.equal(store.get("missing").state,"failed");assert.match(store.get("missing").error.message,/豆包原话/);
  const review=store.get("missing").resultReview;
  await actions.run("missing","recover-result",{candidateId:"new",reviewId:review.id});
  const result=store.get("missing");assert.equal(result.state,"completed");assert.equal(result.payload.userMessageId,"original-user");assert.equal(result.result.resultMessageId,"reply-new");assert.match(result.resultRecoveryHistory[0].previousError.message,/豆包原话/);assert.equal(scheduled.length,0);assert.equal(scheduler.busy.size,0);
  const count=recoverCount;await actions.run("missing","recover-result");assert.equal(recoverCount,count);
 });
 await check("unique bound continuation auto-recovers after takeover",async()=>{
  job("bound");await actions.run("bound","takeover");probe={conversationMatches:true,matched:true,providerTerminal:true,failure:{code:"OLD_REFUSAL"},candidates:[candidate("bound",true)]};await actions.run("bound","end-takeover");assert.equal(store.get("bound").state,"completed");assert.equal(store.get("bound").manualControl.active,false);assert.equal(scheduler.busy.size,0);
 });
 await check("multiple videos never auto-pick latest",async()=>{
  job("multi");probe={conversationMatches:true,matched:true,candidates:[candidate("one",true),candidate("two",true)]};const count=recoverCount;await actions.run("multi","recover-result");assert.equal(recoverCount,count);assert.equal(store.get("multi").resultReview.candidates.length,2);
 });
 await check("stale review and forged candidate rejected",async()=>{
  const review=store.get("multi").resultReview;await assert.rejects(()=>actions.run("multi","recover-result",{candidateId:"two",reviewId:"old"}),/更新/);await assert.rejects(()=>actions.run("multi","recover-result",{candidateId:"fake",reviewId:review.id}),/更新/);
  probe={conversationMatches:true,candidates:[{...candidate("two",true),fingerprint:"changed"}]};await assert.rejects(()=>actions.run("multi","recover-result",{candidateId:"two",reviewId:review.id}),/变化/);assert.notEqual(store.get("multi").state,"completed");
 });
 await check("wrong conversation cannot be adopted",async()=>{
  job("wrong");probe={conversationMatches:false,matched:false,candidates:[candidate("wrong",true)]};const count=recoverCount;await actions.run("wrong","recover-result");assert.equal(recoverCount,count);assert.equal(store.get("wrong").error.code,"DOUBAO_SUBMISSION_CONTEXT_MISSING");assert.equal(store.get("wrong").actionHistory.at(-1).status,"needs_attention");
 });
 await check("concurrent calls and account busy blocked",async()=>{
  job("busy");scheduler.busy.add("original");await assert.rejects(()=>actions.run("busy","recover-result"),/自动操作/);scheduler.busy.clear();let release;gate=new Promise(r=>release=r);probe={conversationMatches:true,matched:false};const first=actions.run("busy","recover-result");await assert.rejects(()=>actions.run("busy","recover-result"),/重复/);release();await first;gate=null;assert.equal(scheduler.busy.size,0);
 });
 await check("extraction error visible, account released, refusal retained",async()=>{
  job("extract");probe={conversationMatches:true,candidates:[candidate("extract",true)]};recoverError=new Error("视频地址尚未就绪");await assert.rejects(()=>actions.run("extract","recover-result"),/地址/);recoverError=null;assert.match(store.get("extract").lastRecoveryError.message,/地址/);assert.match(store.get("extract").error.message,/豆包原话/);assert.equal(scheduler.busy.size,0);
 });
 await check("result binding validated before persistence",async()=>{
  job("invalid");probe={conversationMatches:true,candidates:[candidate("invalid",true)]};invalidResult=true;await assert.rejects(()=>actions.run("invalid","recover-result"),/绑定/);invalidResult=false;assert.equal(store.get("invalid").result,null);
 });
 await check("no result but ongoing generation resumes only original monitor",async()=>{
  job("monitor");probe={conversationMatches:true,matched:true,scopedGenerating:true,candidates:[]};await actions.run("monitor","recover-result");assert.equal(scheduled.length,1);assert.equal(scheduled[0].payload.resumeExisting,true);assert.equal(scheduled[0].payload.confirmPending,false);assert.equal(scheduled[0].payload.preferredAccountId,"original");assert.deepEqual(scheduled[0].payload.imageAssets,[]);
 });
 console.log("Manual result recovery: 9 behavior groups passed; no generation was sent");
})().catch(e=>{console.error(e);process.exitCode=1;});

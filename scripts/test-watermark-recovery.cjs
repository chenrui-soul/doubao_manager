"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {TaskStore} = require("../src/task-store.cjs"), {TaskActions} = require("../src/task-actions.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-watermark-test-")), file = path.join(root, "jobs.json"), store = new TaskStore(file);
const account = {id:"original"}, scheduler = {busy:new Set(),release:a=>scheduler.busy.delete(a.id)}, running = new Map(), waiting = new Set();
let retryError = null, gate = null, retries = 0, recoveries = 0;
const candidate = {id:"reply:0",messageId:"reply",fingerprint:"stable",videoVid:"original_video_123",ready:true,anchored:true};
const output = {ok:true,state:"completed",conversationId:"123456789",resultMessageId:"reply",videoVid:candidate.videoVid,watermarkedUrl:"https://example.invalid/page.mp4",watermarkFreeUrl:null,watermarkFreeAvailable:false,watermarkFreeError:"创作空间未找到视频"};
const worker = {
  inspectTask:async()=>({conversationMatches:true,candidates:[candidate]}),
  recoverTaskResult:async()=>{recoveries++;return {...output};},
  retryWatermarkFree:async j=>{retries++;assert.equal(j.account.id,"original");assert.equal(j.result.videoVid,candidate.videoVid);if(gate)await gate;if(retryError)throw retryError;return {...j.result,watermarkFreeUrl:"https://example.invalid/free.mp4",watermarkFreeAvailable:true,watermarkFreeError:null};},
  generate:async()=>{throw new Error("must never generate");},
};
const opts = {store,scheduler,worker,accounts:()=>[account],running,waiting,scheduleJob:()=>{throw new Error("must never schedule");},canRecover:()=>true};
let actions = new TaskActions(opts);
function job(id,completed=false) {const j=store.create(id,{prompt:"original prompt",conversationId:output.conversationId,userMessageId:"original-user"});return store.save({...j,state:completed?"completed":"failed",account_id:account.id,manualControl:{active:false,startedAt:"2026-10-01"},result:completed?{...output}:null,error:completed?null:{providerTerminal:true,message:"豆包原拒绝"}});}
async function check(name,fn){await fn();console.log(`PASS ${name}`);}
(async()=>{
 await check("page-only recovery waits for explicit acceptance; no completed URL leak",async()=>{
  job("pending");const r=await actions.run("pending","recover-result");assert.equal(r.result.needsWatermarkChoice,true);assert.notEqual(r.job.state,"completed");assert.equal(r.job.result,null);assert.ok(r.job.pendingWatermarkResult.output.watermarkedUrl);assert.equal(scheduler.busy.size,0);
  const before=recoveries;await actions.run("pending","recheck");assert.equal(recoveries,before);assert.ok(store.get("pending").pendingWatermarkResult);
 });
 await check("explicit acceptance validates revision, preserves original refusal and binding",async()=>{
  const pending=store.get("pending").pendingWatermarkResult;
  await assert.rejects(()=>actions.run("pending","accept-page-result",{reviewId:pending.id}),/确认/);
  await assert.rejects(()=>actions.run("pending","accept-page-result",{reviewId:"stale",acceptWatermarked:true}),/变化|更新/);
  const r=await actions.run("pending","accept-page-result",{reviewId:pending.id,acceptWatermarked:true});assert.equal(r.job.state,"completed");assert.equal(r.job.result.watermarkFreeAvailable,false);assert.ok(r.job.result.pageVersionAcceptedAt);assert.match(r.job.resultRecoveryHistory[0].previousError.message,/原拒绝/);assert.equal(r.job.payload.userMessageId,"original-user");assert.equal(r.job.pendingWatermarkResult,null);
 });
 await check("completed task can retry, failure preserves original completed result",async()=>{
  job("legacy",true);assert.equal(actions.flags(store.get("legacy")).canRetryWatermark,true);const before=structuredClone(store.get("legacy").result);
  retryError=new Error("豆包 AI 创作空间没有找到当前任务的视频 VID");await assert.rejects(()=>actions.run("legacy","retry-watermark"),/VID/);assert.deepEqual(store.get("legacy").result,before);assert.equal(store.get("legacy").state,"completed");assert.match(store.get("legacy").lastWatermarkError.message,/VID/);assert.equal(scheduler.busy.size,0);retryError=null;
  await actions.run("legacy","retry-watermark");assert.equal(store.get("legacy").result.watermarkFreeAvailable,true);assert.equal(store.get("legacy").result.watermarkedUrl,before.watermarkedUrl);assert.equal(store.get("legacy").lastWatermarkError,null);
  const n=retries;await actions.run("legacy","retry-watermark");assert.equal(retries,n);
 });
 await check("pending choice persists over restart and retry succeeds without adoption",async()=>{
  job("restart");await actions.run("restart","recover-result");actions=new TaskActions({...opts,store:new TaskStore(file)});
  await actions.run("restart","retry-watermark");const saved=new TaskStore(file).get("restart");assert.equal(saved.state,"completed");assert.equal(saved.result.watermarkFreeAvailable,true);assert.equal(saved.pendingWatermarkResult,null);assert.match(saved.resultRecoveryHistory[0].previousError.message,/原拒绝/);
  actions=new TaskActions(opts);
 });
 await check("account busy, takeover and duplicate retries cannot race",async()=>{
  job("busy",true);scheduler.busy.add(account.id);await assert.rejects(()=>actions.run("busy","retry-watermark"),/自动操作/);scheduler.busy.clear();actions.manual.set(account.id,"busy");await assert.rejects(()=>actions.run("busy","retry-watermark"),/结束/);actions.manual.clear();
  let release;gate=new Promise(r=>release=r);const first=actions.run("busy","retry-watermark");await assert.rejects(()=>actions.run("busy","retry-watermark"),/重复/);release();await first;gate=null;assert.equal(scheduler.busy.size,0);
 });
 await check("changed result binding rejected without replacing original video",async()=>{
  job("wrong",true);const original=worker.retryWatermarkFree;worker.retryWatermarkFree=async j=>({...j.result,conversationId:"987654321",watermarkFreeUrl:"https://example.invalid/wrong.mp4"});await assert.rejects(()=>actions.run("wrong","retry-watermark"),/绑定/);assert.equal(store.get("wrong").result.watermarkFreeUrl,null);worker.retryWatermarkFree=original;
 });
 await check("real worker binds original VID, scopes missing VID and releases on failure",async()=>{
  const {DoubaoWorker}=require("../src/doubao-worker.cjs"), w=Object.create(DoubaoWorker.prototype);
  let released=0,resolveCalls=0,login=true,fail=false,probeUrl=output.watermarkedUrl;
  const target="https://www.doubao.com/chat/123456789",session={};
  w.controller={embeddedBrowserProvider:()=>({retainAutomation:()=>()=>released++}),open:async a=>{assert.equal(a.id,"original");return session;},detect:async()=>({loggedIn:login}),evaluate:async()=>target,checkPageBlocker:async()=>{},resolveWatermarkFreeVideo:async(s,args)=>{assert.equal(s,session);assert.deepEqual(args,{videoVid:candidate.videoVid,conversationId:output.conversationId});resolveCalls++;if(fail)throw new Error("no download yet");return {mainUrl:"https://example.invalid/free.mp4"};}};
  w.taskManager=()=>({taskUrl:()=>target});w.probeTaskVideos=async()=>({conversationMatches:true,candidates:[{messageId:"reply",videoVid:candidate.videoVid,url:probeUrl},{messageId:"another",videoVid:"wrong_video_999",url:output.watermarkedUrl}]});
  const j={account,result:{...output},taskContext:{conversationId:output.conversationId}};
  assert.equal((await w.retryWatermarkFree(j)).watermarkFreeAvailable,true);assert.equal(resolveCalls,1);
  fail=true;await assert.rejects(()=>w.retryWatermarkFree(j),/no download/);fail=false;login=false;await assert.rejects(()=>w.retryWatermarkFree(j),/登录/);login=true;
  const missing={...j,result:{...output,videoVid:""}};assert.equal((await w.retryWatermarkFree(missing)).videoVid,candidate.videoVid);
  probeUrl="https://example.invalid/other.mp4";await assert.rejects(()=>w.retryWatermarkFree(missing),/编号/);assert.equal(released,5);assert.equal(resolveCalls,3);
 });
 console.log("Watermark recovery: 7 behavior groups passed; no generation or account switching");
})().catch(e=>{console.error(e);process.exitCode=1;});

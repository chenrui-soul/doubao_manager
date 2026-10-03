"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-refusal-"));
process.env.DOUBAO_DATA_ROOT = root;
process.env.DOUBAO_ACCOUNTS_FILE = path.join(root, "accounts.json");
const {BrowserController, classifyDoubaoFailureMessage} = require("../src/vendor/browser-controller.cjs");
const {DoubaoWorker} = require("../src/doubao-worker.cjs");
const {TaskStore} = require("../src/task-store.cjs");
const {TaskActions} = require("../src/task-actions.cjs");
const raw = "抱歉，无法针对该图片进行创作，请更换图片后再试。";

(async () => {
  for (const message of [raw, "抱歉，无法基于这些参考图生成视频，请更换素材后重试。", "该图片不支持创作，请更换图片后再试。", "无法使用当前素材进行创作，请替换素材后重试。"]){
    const failure = classifyDoubaoFailureMessage(message);
    assert.equal(failure.providerTerminal, true, message);
    assert.equal(failure.code, "DOUBAO_ASSET_REJECTED");
    assert.equal(failure.providerMessageRaw, message);
    assert.equal(failure.accountAction, "release");
    assert.equal(failure.quotaConsumed, null, "do not infer charging from a generic refusal");
  }
  const multiline = "抱歉，无法针对该图片进行创作。\n请更换图片后再试。";
  assert.equal(classifyDoubaoFailureMessage(multiline).providerMessageRaw, multiline);
  for(const message of ["正在针对该图片进行创作，预计等待5分钟。", "请勿更换图片，视频正在生成。", "如果无法针对该图片进行创作，可以更换图片后再试。", "你问：无法针对该图片进行创作是什么意思？"])
    assert.equal(classifyDoubaoFailureMessage(message).providerTerminal, false, message);

  const failure = classifyDoubaoFailureMessage(raw);
  const controller = Object.create(BrowserController.prototype);
  const session = {account:{id:"original"}, currentJobId:"refused"};
  controller.open = async()=>session;
  controller.connect = async()=>({});
  controller.detect = async()=>({loggedIn:true});
  controller.readSubmissionState = async()=>({...failure, conversationId:"123456789", conversationMatches:true, userMessage:true, promptPresentInCurrentConversation:true});
  controller.fillComposer = controller.clickComposerSend = async()=>assert.fail("refusal must never send a message");
  const resumed = await controller.runGeneration({action:"resume_monitor",id:"refused",account:session.account,payload:{prompt:"test",conversationId:"123456789"}});
  assert.equal(resumed.ok, false);
  assert.equal(resumed.generating, undefined);
  assert.equal(resumed.providerMessageRaw, raw);
  await assert.rejects(()=>controller.waitForVideo(session,{jobId:"refused",prompt:"test",conversationId:"123456789",timeoutMs:1000}), error=>error.providerTerminal===true && error.message===raw);

  const worker = Object.create(DoubaoWorker.prototype);
  worker.controller = controller;
  worker.taskManager = ()=>({taskUrl:()=>"https://www.doubao.com/chat/123456789"});
  controller.evaluate = async(_s, expression)=>expression==="location.href"?"https://www.doubao.com/chat/123456789":{kind:""};
  controller.readConversationTurn = async()=>({delivered:false});
  const inspection = await worker.inspectTask({account:session.account,taskContext:{conversationId:"123456789"},payload:{prompt:"test"}});
  assert.equal(inspection.failure.providerMessageRaw, raw);
  const store = new TaskStore(path.join(root,"jobs.json"));
  const j = store.create("refused",{prompt:"test",conversationId:"123456789",resumeExisting:true});
  store.save({...j,state:"submission_unknown",account_id:"original"});
  const scheduler = {busy:new Set(),release:a=>scheduler.busy.delete(a.id)};
  const actions = new TaskActions({store,scheduler,worker:{inspectTask:async()=>inspection},accounts:()=>[session.account],running:new Map(),waiting:new Set(),scheduleJob:()=>assert.fail("must not schedule a rejected task"),canRecover:()=>false});
  await actions.run("refused","recheck");
  assert.equal(store.get("refused").state,"failed");
  assert.equal(store.get("refused").error.code,"DOUBAO_ASSET_REJECTED");
  assert.equal(store.get("refused").error.message,raw);
  assert.equal(store.get("refused").error.providerMessageRaw,raw);
  assert.equal(scheduler.busy.size,0);

  const {AccountStore} = require("../src/account-store.cjs");
  new AccountStore(process.env.DOUBAO_ACCOUNTS_FILE).write([{id:"original",loginState:"logged_in"}]);
  const license = require("../src/license.cjs");
  license.checkLicense = license.requireLicense = async()=>({valid:true});
  let calls=0, progress;
  globalThis.__doubaoInProcessWorker = {setProgressHandler:f=>progress=f,detect:async()=>({loggedIn:true}),generate:async job=>{
    calls++;
    await progress({jobId:job.id,accountId:"original",state:"generating",conversationId:"123456789"});
    return controller.waitForVideo(session,{jobId:job.id,prompt:"test",conversationId:"123456789",timeoutMs:1000});
  }};
  const service = require("../src/server.cjs");
  const live = store.create("monitor-refusal",{prompt:"test",model:"Seedance 2.0 Fast",ratio:"16:9",duration:10,preferredAccountId:"original",accountLockRequired:true,resumeExisting:true,conversationId:"123456789"});
  store.save({...live,account_id:"original"});
  try {
    await new Promise(r=>service.server.listen(0,"127.0.0.1",r));
    await service.executeJob(store.get(live.id));
    const base=`http://127.0.0.1:${service.server.address().port}`;
    const detail=await (await fetch(base+"/api/v1/video/jobs/"+live.id)).json();
    const health=await (await fetch(base+"/health")).json();
    assert.equal(detail.state,"failed");
    assert.equal(detail.error.providerMessageRaw,raw);
    assert.equal(detail.error.message,raw);
    assert.equal(health.accounts[0].busy,false);
    assert.equal(health.queue.active,0);
    assert.equal(health.queue.waiting,0);
    assert.equal(store.get(live.id).payload.resultRecoveryAttempts,undefined);
    assert.equal(calls,1);
    assert.equal(service.canRecoverExistingResult(store.get(live.id)),false);
  } finally {service.server.close();}
  console.log("Image refusal: original text, variants/negative cases, resume refusal, stop monitor, manual review, HTTP failed state and released account passed");
})().catch(error=>{console.error(error);process.exitCode=1;});

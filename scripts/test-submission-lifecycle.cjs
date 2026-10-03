"use strict";
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'doubao-lifecycle-'));
process.env.DOUBAO_DATA_ROOT=runtime;
process.env.DOUBAO_ACCOUNTS_FILE=path.join(runtime,'accounts.json');
fs.writeFileSync(process.env.DOUBAO_ACCOUNTS_FILE,JSON.stringify({accounts:[{id:'test-account',loginState:'logged_in',dailyQuotaLimit:100}]}));
// This lifecycle test owns an isolated temp store and a fake worker. Stub only
// its license dependency; never read/copy a real device secret into fixtures.
const license = require('../src/license.cjs');
license.requireLicense = async () => ({valid:true});
license.checkLicense = async () => ({valid:true});
let progress,mode='success',calls=0;
globalThis.__doubaoInProcessWorker={
  setProgressHandler:handler=>{progress=handler;},
  detect:async()=>({loggedIn:true}),
  generate:async job=>{
    calls++;
    if(mode!=='success')throw Object.assign(new Error('unknown'),{code:mode,submissionUnknown:true,safeToRetry:false,notSentVerified:false});
    await progress({jobId:job.id,state:'generating',accountId:'test-account',conversationId:'123456789'});
    await new Promise(r=>setTimeout(r,700));
    return {ok:true,state:'completed',watermarkedUrl:'https://example.test/unit-test.mp4'};
  }
};
const {executeJob}=require('../src/server.cjs');
const {TaskStore}=require('../src/task-store.cjs');
const store=new TaskStore(path.join(runtime,'jobs.json'));
(async()=>{
  await executeJob(store.create('unit-success',{prompt:'test'}));
  assert.equal(store.get('unit-success').state,'completed','generating progress must not resolve the result race');
  mode='DOUBAO_VIDEO_TASK_NOT_CREATED';
  await executeJob(store.create('unit-unknown',{prompt:'test'}));
  assert.equal(store.get('unit-unknown').state,'submission_unknown');
  assert.equal(calls,2,'unknown submission must not be submitted again');
  assert.equal(store.get('unit-unknown').payload.attemptHistory.length,1);
  for (const code of ['DOUBAO_CONFIRMATION_QUEUED','DOUBAO_CONFIRMATION_DELIVERY_UNKNOWN','DOUBAO_REPLY_NOT_FINISHED','DOUBAO_REPLY_STREAM_FAILED']) {
    mode=code;
    const before=calls;
    await executeJob(store.create(code,{prompt:'test'}));
    assert.equal(store.get(code).state,'submission_unknown');
    assert.equal(store.get(code).error.code,code);
    assert.equal(calls,before+1,'confirmation uncertainty must not create another generation');
  }
  const desktop=fs.readFileSync(path.join(__dirname,'../desktop/main.cjs'),'utf8');
  const respond=desktop.slice(desktop.indexOf('function respondWorker('),desktop.indexOf('async function handleWorkerRequest('));
  let wire;
  vm.runInNewContext(respond+';respondWorker({id:"unit"},null,{code:"DOUBAO_VIDEO_TASK_NOT_CREATED",message:"unknown",submissionUnknown:true,userMessageId:"original-user",submittedAt:"2026-09-28T05:46:00Z"});',{serviceProcess:{connected:true,send:value=>{wire=value;}}});
  assert.equal(wire.error.submissionUnknown,true,'Electron IPC must preserve unknown submission status');
  assert.equal(wire.error.userMessageId,'original-user');
  assert.equal(wire.error.submittedAt,'2026-09-28T05:46:00Z');
  console.log('submission lifecycle ok: await final result, hold unknown submission, preserve IPC status');
})().catch(e=>{console.error(e);process.exitCode=1;});

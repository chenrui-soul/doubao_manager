"use strict";
// Real Chromium editor/click/queue behavior without platform requests or quota.
const {app, BrowserWindow} = require("electron");
const assert = require("node:assert/strict");
const {BrowserController} = require("../src/vendor/browser-controller.cjs");
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("in-process-gpu");
let win;
app.whenReady().then(async () => {
  win = new BrowserWindow({show:false,width:900,height:700,webPreferences:{backgroundThrottling:false,partition:`confirmation-test-${Date.now()}`}});
  const wc = win.webContents;
  wc.debugger.attach("1.3");
  const c = Object.create(BrowserController.prototype);
  c.evaluate = async (_s, expression) => wc.executeJavaScript(expression);
  c.connect = async () => ({send:(method, params) => wc.debugger.sendCommand(method, params)});
  const prompt = "不需要，直接帮我生成视频。";
  const load = async () => {
    await wc.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`
      <style>#composer{position:absolute;left:20px;top:400px;width:600px;height:100px}
      #send{position:absolute;left:550px;top:510px;width:70px;height:40px}
      #pending{position:absolute;left:20px;top:350px;width:600px;height:40px}</style>
      <section id="messages"></section><div id="pending"></div>
      <textarea id="composer"></textarea><button id="send">发送</button>
      <script>
      window.mode='deliver';window.clicks=0;
      document.querySelector('#send').onclick=()=>{
        window.clicks++;const input=document.querySelector('#composer');const value=input.value;
        if(window.mode==='queue') document.querySelector('#pending').textContent=value;
        else if(window.mode==='deliver') {
          const message=document.createElement('div');message.dataset.messageId='new-'+window.clicks;message.dataset.role='user';message.textContent=value;document.querySelector('#messages').append(message);
        }
        input.value='';
      };</script>`));
    return {currentJobId:"fixture",uiTimings:{submissionProbeMs:10},submissionRequests:[]};
  };
  let s = await load();
  s.submissionRequests.push({jobId:"fixture",requestId:"reply-1",promptMatched:true,url:"https://www.doubao.com/chat/completion"});
  let finished = false;
  const waiting = c.waitForAssistantReply(s,{timeoutMs:1000}).then(()=>{finished=true;});
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(finished,false,"a matching in-flight completion blocks confirmation even without a stop button");
  c.finishSubmissionRequest(s,{requestId:"reply-1"});
  await waiting;
  const start = Date.now();
  await c.waitForAssistantReply(s,{timeoutMs:500});
  assert.ok(Date.now()-start<400,"an idle reply adds no fixed waiting time");
  await wc.executeJavaScript(`document.querySelector('#send').textContent='停止生成'`);
  await assert.rejects(c.waitForAssistantReply(s,{timeoutMs:60}),e=>e.code==='DOUBAO_REPLY_NOT_FINISHED'&&e.safeToRetry===false);
  assert.equal(await wc.executeJavaScript('window.clicks'),0,"never stop the provider's reply");
  await wc.executeJavaScript(`document.querySelector('#send').textContent='发送'`);
  assert.equal(await c.fillComposer(s,prompt),true);
  assert.equal(await c.clickComposerSend(s,{requireIdleReply:true}),true);
  assert.equal((await c.waitForConfirmationDelivery(s,prompt,"",{timeoutMs:500})).delivered,true);
  assert.equal(await wc.executeJavaScript('window.clicks'),1);

  s = await load();
  await wc.executeJavaScript(`window.mode='queue'`);
  assert.equal(await c.fillComposer(s,prompt),true);
  assert.equal(await c.clickComposerSend(s,{requireIdleReply:true}),true);
  assert.equal(await wc.executeJavaScript(`document.querySelector('#composer').value`),"");
  await assert.rejects(c.waitForConfirmationDelivery(s,prompt,"",{timeoutMs:80}),e=>e.code==='DOUBAO_CONFIRMATION_QUEUED'&&e.submissionUnknown&&e.safeToRetry===false);
  assert.equal(await wc.executeJavaScript('window.clicks'),1,"queued message must not be sent a second time");

  s = await load();
  await wc.executeJavaScript(`window.mode='drop'`);
  assert.equal(await c.fillComposer(s,prompt),true);
  await c.clickComposerSend(s);
  await assert.rejects(c.waitForConfirmationDelivery(s,prompt,"",{timeoutMs:80}),e=>e.code==='DOUBAO_CONFIRMATION_DELIVERY_UNKNOWN');
  assert.equal(await wc.executeJavaScript('window.clicks'),1,"empty editor alone is not delivery");

  s = await load();
  s.pendingSubmission = {confirmationBeforeMessageId:"old-message"};
  await wc.executeJavaScript(`document.querySelector('#messages').innerHTML='<div data-message-id="old-message" data-role="user">${prompt}</div>'`);
  await assert.rejects(c.waitForConfirmationDelivery(s,prompt,"",{timeoutMs:80}),e=>e.code==='DOUBAO_CONFIRMATION_DELIVERY_UNKNOWN');
  s.submissionRequests.push({jobId:"fixture",requestId:"reply-failed",promptMatched:true,url:"https://www.doubao.com/chat/completion"});
  c.finishSubmissionRequest(s,{requestId:"reply-failed"},true);
  await assert.rejects(c.waitForAssistantReply(s,{timeoutMs:80}),e=>e.code==='DOUBAO_REPLY_STREAM_FAILED');
  console.log('Chromium confirmation passed: streaming/stop guard, immediate idle, delivered bubble, queued chip, dropped click, old message, failed stream; no duplicate sends');
  win.destroy(); app.exit(0);
}).catch(error=>{console.error(error.stack||error);win?.destroy();app.exit(1);});

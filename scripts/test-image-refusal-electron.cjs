"use strict";
const {app,BrowserWindow}=require("electron"),assert=require("node:assert/strict"),http=require("node:http");
const {BrowserController}=require("../src/vendor/browser-controller.cjs");
app.disableHardwareAcceleration();app.commandLine.appendSwitch("no-sandbox");
let win,server;
app.whenReady().then(async()=>{
  server=http.createServer((_req,res)=>{res.setHeader("Content-Type","text/html; charset=utf-8");res.end('<main><div data-message-id="initial" data-role="user">test image video</div><div data-message-id="plan">确认后我再开始生成视频。</div><div data-message-id="confirm" data-role="user">不需要，直接帮我生成视频。</div><div data-message-id="answer">抱歉，无法针对该图片进行创作，请更换图片后再试。</div></main><textarea></textarea>');});
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  win=new BrowserWindow({show:false,width:1000,height:800});
  await win.loadURL(`http://127.0.0.1:${server.address().port}/chat/123456789`);
  const c=Object.create(BrowserController.prototype);
  c.evaluate=async(_s,e)=>win.webContents.executeJavaScript(e);
  const probe=()=>c.readSubmissionState({},"test image video","initial","123456789");
  const failure=await probe();
  assert.equal(failure.code,"DOUBAO_ASSET_REJECTED");
  assert.equal(failure.providerMessageRaw,"抱歉，无法针对该图片进行创作，请更换图片后再试。");
  assert.equal(failure.providerTerminal,true);
  assert.equal(failure.scopedGenerating,false);
  assert.equal(failure.planningConfirmation,false);
  await win.webContents.executeJavaScript('document.querySelector("[data-message-id=answer]").textContent="正在生成视频，预计等待5分钟。"');
  const generating=await probe();
  assert.equal(generating.providerTerminal,false);assert.equal(generating.scopedGenerating,true);
  // An earlier refusal or refusal text inside user input must not fail a new active turn.
  await win.webContents.executeJavaScript('document.querySelector("[data-message-id=plan]").textContent="抱歉，无法针对该图片进行创作，请更换图片后再试。";document.querySelector("[data-message-id=initial]").textContent+=" 抱歉，无法针对该图片进行创作，请更换图片后再试。"');
  assert.equal((await probe()).providerTerminal,false);
  console.log("Real Chromium refusal: current reply rejected, raw reply retained, ordinary generation and historical/user text do not fail current turn");
}).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{win?.destroy();server?.close();app.exit(process.exitCode||0);});

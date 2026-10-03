"use strict";
// Run with Electron. Uses a hidden, isolated fixture page; never submits to Doubao.
const {app, BrowserWindow} = require("electron");
const assert = require("node:assert/strict");
const {BrowserController} = require("../src/vendor/browser-controller.cjs");
let win;
app.whenReady().then(async () => {
  win = new BrowserWindow({show: false, width: 900, height: 700, webPreferences: {backgroundThrottling: false, partition: `composer-test-${Date.now()}`}});
  const wc = win.webContents;
  wc.debugger.attach("1.3");
  const controller = Object.create(BrowserController.prototype);
  controller.evaluate = async (_session, expression) => wc.executeJavaScript(expression);
  controller.connect = async () => ({send: (method, params) => wc.debugger.sendCommand(method, params)});
  const prompt = "冷蓝雨夜，暖金宠物店。\n" + "顾言真抱稳阿七，玻璃门保持关闭。".repeat(300) + "\n最后一句，完整保留。";
  for (const rich of [false, true]) {
    const html = `<style>#composer{display:block;position:absolute;left:20px;top:100px;width:600px;height:300px;overflow:auto;white-space:pre-wrap}button{position:absolute;left:550px;top:420px;width:70px;height:40px}</style>${rich ? '<div id="composer" contenteditable="true"></div>' : '<textarea id="composer"></textarea>'}<button id="send">生成</button><script>window.sends=[];window.accepted='';const editor=document.getElementById('composer');const value=()=>${rich ? "editor.innerText" : "editor.value"};editor.addEventListener('input',()=>{window.accepted=value()});document.getElementById('send').onclick=()=>window.sends.push(window.accepted);</script>`;
    await wc.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    const session = {};
    assert.equal(await controller.fillComposer(session, prompt), true, `${rich ? "rich" : "textarea"} accepts full multiline prompt`);
    assert.equal(await wc.executeJavaScript("window.accepted"), prompt, "native input updates the app's event state");
    assert.equal(await controller.clickComposerSend(session), true);
    assert.deepEqual(await wc.executeJavaScript("window.sends"), [prompt], "one actual browser click sends full prompt");
    assert.equal(await controller.clickComposerSend(session), false);
    console.log(`Chromium ${rich ? "contenteditable" : "textarea"}: native long-text input and single send passed`);

    const resetSession = {};
    await wc.executeJavaScript(`document.getElementById('composer').addEventListener('input',()=>setTimeout(()=>{${rich ? "document.getElementById('composer').innerText=''" : "document.getElementById('composer').value=''"}},200),{once:true})`);
    assert.equal(await controller.fillComposer(resetSession, prompt, {timeoutMs: 1200}), false);
    assert.equal(await controller.clickComposerSend(resetSession), false);
    assert.equal(await wc.executeJavaScript("window.sends.length"), 1, "editor reset cannot submit");
  }
  console.log("Chromium composer integration passed");
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error.stack || error); win?.destroy(); app.exit(1); });

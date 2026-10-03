"use strict";
// Offline Chromium fixture: native seconds and zero-based duration indices.
const {app,BrowserWindow} = require("electron");
const assert = require("node:assert/strict");
const {BrowserController} = require("../src/vendor/browser-controller.cjs");
const {reconcileVideoParameters} = require("../src/vendor/video-parameters.cjs");
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("in-process-gpu");
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:900,height:700,webPreferences:{backgroundThrottling:false,partition:`slider-${Date.now()}`}});
  const wc=win.webContents;
  wc.debugger.attach("1.3");
  const c=Object.create(BrowserController.prototype);
  c.evaluate=(_s,expr)=>wc.executeJavaScript(expr);
  c.connect=async()=>({send:(method,params)=>wc.debugger.sendCommand(method,params)});
  const load=async native=>wc.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`
    <button data-input-engine-actionbar-control-key="video-model">模型 Seedance 2.0 Fast</button>
    <button id="summary" aria-controls="menu" data-state="open" data-creation-params-panel-id="fixture">16:9 · 10s</button>
    <div id="menu" role="dialog"><button>16:9</button><button>9:16</button>
    ${native?'<input type="range" min="4" max="15" value="10" step="1">':'<div tabindex="0" role="slider" aria-valuemin="0" aria-valuemax="11" aria-valuenow="6" style="width:180px;height:24px">时长</div>'}</div>
    <script>
    const slider=document.querySelector('[role=slider],input');
    const update=()=>{document.querySelector('#summary').textContent='16:9 · '+${native?'slider.value':"(Number(slider.getAttribute('aria-valuenow'))+4)"}+'s';};
    slider.oninput=update;
    slider.onkeydown=e=>{${native?'':"let v=Number(slider.getAttribute('aria-valuenow'));if(e.key==='Home')v=0;else if(e.key==='ArrowRight')v=Math.min(11,v+1);else return;e.preventDefault();slider.setAttribute('aria-valuenow',v);update();"}};
    </script>`));
  for(const native of [false,true]){
    await load(native);
    for(const duration of [15,4,11,10]){
      await reconcileVideoParameters(c,{parameterVerificationTimeoutMs:1000},{model:'Seedance 2.0 Fast',ratio:'16:9',duration});
      assert.equal(await wc.executeJavaScript("document.querySelector('#summary').textContent"),`16:9 · ${duration}s`);
    }
  }
  win.destroy();
  console.log('Chromium duration test passed: index 0..11 maps to 4..15 seconds; native slider preserved');
  app.exit(0);
}).catch(e=>{console.error(e.stack||e);app.exit(1);});

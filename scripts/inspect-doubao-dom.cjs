"use strict";

const WebSocket = require("ws");
const path = require("path");

async function main() {
  const targets = await fetch("http://127.0.0.1:9223/json").then(response => response.json());
  const target = targets.find(item => item.type === "page" && /doubao\.com/i.test(item.url));
  if (!target) throw new Error("没有找到豆包调试页面");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let sequence = 0;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const onMessage = data => {
      const message = JSON.parse(data.toString());
      if (message.id !== id) return;
      socket.off("message", onMessage);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({id, method, params}));
  });
  if (process.argv.includes("--video")) {
    const located = await call("Runtime.evaluate", {expression:`(() => {
      const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>2&&r.height>2&&s.display!=="none"&&s.visibility!=="hidden"};
      const model=[...document.querySelectorAll('[data-input-engine-actionbar-control-key="video-model"]')].find(visible);
      const params=[...document.querySelectorAll('[data-input-engine-actionbar-render-entry-key="video-generation-params-panel"],[data-creation-params-panel-id]')].find(visible);
      if(model&&params)return {active:true};
      const button=document.querySelector('button[data-skill-id="skill_bar_button_17"]');
      if(!button)return null;
      const r=button.getBoundingClientRect();
      return {active:false,x:r.left+r.width/2,y:r.top+r.height/2};
    })()`, returnByValue:true});
    const point = located.result.value;
    if (!point) throw new Error("没有找到视频生成按钮");
    if (!point.active) {
      await call("Input.dispatchMouseEvent", {type:"mouseMoved", x:point.x, y:point.y});
      await call("Input.dispatchMouseEvent", {type:"mousePressed", x:point.x, y:point.y, button:"left", clickCount:1});
      await call("Input.dispatchMouseEvent", {type:"mouseReleased", x:point.x, y:point.y, button:"left", clickCount:1});
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  if (process.argv.includes("--upload-assets")) {
    const documentNode = await call("DOM.getDocument", {depth:-1, pierce:true});
    const inputNode = await call("DOM.querySelector", {nodeId:documentNode.root.nodeId, selector:'input[type="file"][accept*=".jpg"]'});
    if (!inputNode.nodeId) throw new Error("没有找到视频参考图上传控件");
    const assetDirectory = path.resolve(__dirname, "..", "assets", "20260911-gu-yanzhen");
    const files = ["01-gu-yanzhen.jpg", "02-a-qi.jpg", "03-red-100.jpg", "04-pet-shop.jpg", "05-storyboard.jpg", "06-start-frame.jpg", "07-end-frame.jpg"].map(name => path.join(assetDirectory, name));
    await call("DOM.setFileInputFiles", {nodeId:inputNode.nodeId, files});
    await new Promise(resolve => setTimeout(resolve, 15000));
  }
  if (process.argv.includes("--fill-preview")) {
    await call("Runtime.evaluate", {expression:`(() => {
      const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>2&&r.height>2&&s.display!=="none"&&s.visibility!=="hidden"};
      const editor=[...document.querySelectorAll('[contenteditable="true"],[role="textbox"],.ProseMirror')].filter(visible).sort((a,b)=>b.getBoundingClientRect().bottom-a.getBoundingClientRect().bottom)[0];
      if(!editor)return false;
      editor.focus();
      editor.textContent='诊断占位文本（不发送）';
      editor.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:'诊断占位文本（不发送）'}));
      return true;
    })()`, returnByValue:true});
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const expression = `(() => {
    const visible = el => { if (!el) return false; const r=el.getBoundingClientRect(),s=getComputedStyle(el); return r.width>2&&r.height>2&&s.display!=="none"&&s.visibility!=="hidden"; };
    const clean = value => String(value || "").replace(/\\s+/g, " ").trim();
    const describe = el => { const r=el.getBoundingClientRect(); return {tag:el.tagName,text:clean(el.innerText||el.textContent||"").slice(0,180),placeholder:el.getAttribute("placeholder")||el.getAttribute("aria-placeholder")||"",aria:el.getAttribute("aria-label")||"",title:el.getAttribute("title")||"",role:el.getAttribute("role")||"",testid:el.getAttribute("data-testid")||"",skillId:el.getAttribute("data-skill-id")||"",modelKey:el.getAttribute("data-input-engine-actionbar-control-key")||"",paramsKey:el.getAttribute("data-input-engine-actionbar-render-entry-key")||"",pressed:el.getAttribute("aria-pressed")||"",selected:el.getAttribute("aria-selected")||"",state:el.getAttribute("data-state")||"",disabled:Boolean(el.disabled)||el.getAttribute("aria-disabled")==="true",cls:String(el.className||"").slice(0,220),rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},outer:String(el.outerHTML||"").slice(0,1200)}; };
    const all=[...document.querySelectorAll("*")].filter(visible);
    const editors=all.filter(el=>el.matches?.('textarea,input:not([type="file"]),[contenteditable="true"],[role="textbox"],[data-slate-editor="true"],.ProseMirror')).map(describe);
    const controls=all.filter(el=>/视频生成|生成视频|Seedance|10\\s|16:9/.test(clean(el.innerText||el.textContent||el.getAttribute("aria-label")||el.getAttribute("title")||""))||el.hasAttribute("data-input-engine-actionbar-control-key")||el.hasAttribute("data-input-engine-actionbar-render-entry-key")||el.hasAttribute("data-creation-params-panel-id")).map(describe).filter((item,index,array)=>index<100);
    const buttons=all.filter(el=>el.matches?.('button,[role="button"]')).map(describe).filter(item=>item.rect.y>innerHeight*.45).slice(-100);
    const videoRoot=document.querySelector('[data-input-engine-actionbar-control-key="video-model"]')?.closest('.guidance-input-surface')||document.querySelector('.guidance-input-surface');
    const videoButtons=[...(videoRoot?.querySelectorAll('button,[role="button"]')||[])].filter(visible).map(describe);
    const videoSvgs=[...(videoRoot?.querySelectorAll('svg')||[])].filter(visible).map(el=>{const item=describe(el);return{...item,parent:describe(el.parentElement),pathCount:el.querySelectorAll('path').length};});
    const images=all.filter(el=>el.tagName==="IMG").map(describe).filter(item=>item.rect.y>innerHeight*.35).slice(-30);
    const fileInputs=[...document.querySelectorAll('input[type="file"]')].map(el=>({...describe(el),accept:el.accept||"",multiple:Boolean(el.multiple),fileCount:Number(el.files?.length||0),outer:String(el.outerHTML||"").slice(0,800)}));
    return {url:location.href,title:document.title,viewport:{w:innerWidth,h:innerHeight},editors,controls,buttons,videoButtons,videoSvgs,images,fileInputs,bodyTail:clean(document.body?.innerText||"").slice(-1800)};
  })()`;
  const result = await call("Runtime.evaluate", {expression, returnByValue:true, awaitPromise:true});
  console.log(JSON.stringify(result.result.value, null, 2));
  socket.close();
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

"use strict";

// Runs in the page. Read only current controls and their parameter menu, never
// conversation text (which can contain old ratios and durations).
function normalizeVideoModelLabel(value) {
  return String(value || "").replace(/\s+/g, "").replace(/^(?:模型|model|选择模型|当前模型)/i, "").toLowerCase();
}

function probeVideoParameters(desired, action = "read") {
  const visible = element => {
    if (!element) return false;
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return rect.width > 2 && rect.height > 2 && style.display !== "none" && style.visibility !== "hidden";
  };
  const text = element => String(element?.innerText || element?.textContent || element?.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  const clean = value => String(value || "").replace(/\s+/g, "").toLowerCase();
  // This function is serialized into the Doubao page, so the page-side
  // implementation must remain self-contained.
  const normalizeModel = value => String(value || "").replace(/\s+/g, "").replace(/^(?:模型|model|选择模型|当前模型)/i, "").toLowerCase();
  const point = element => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return {x:r.left + r.width/2, y:r.top + r.height/2};
  };
  const bottommost = selector => [...document.querySelectorAll(selector)].filter(visible).sort((a,b) => b.getBoundingClientRect().bottom-a.getBoundingClientRect().bottom)[0];
  const model = bottommost('[data-input-engine-actionbar-control-key="video-model"]');
  const panel = bottommost('[data-input-engine-actionbar-render-entry-key="video-generation-params-panel"],[data-creation-params-panel-id]');
  const summary = text(panel).replace(/：/g, ":");
  const match = summary.match(/^(自动|3:4|4:3|9:16|16:9|1:1|21:9)\s*[·•|,，]?\s*(\d{1,2})\s*(?:s|秒)?$/i);
  const ratios = new Set(["自动","3:4","4:3","9:16","16:9","1:1","21:9"]);
  const ratioNodes = root => [...root.querySelectorAll('button,[role="button"],[role="radio"],[role="option"],[data-radix-collection-item],div,span')].filter(visible).filter(e => ratios.has(clean(text(e))));
  const controlled = panel?.getAttribute("aria-controls");
  const linked = controlled ? document.getElementById(controlled) : null;
  const menus = [...document.querySelectorAll('[role="menu"],[role="dialog"],[role="listbox"],[data-radix-popper-content-wrapper]')].filter(visible)
    .filter(e => new Set(ratioNodes(e).map(n=>clean(text(n)))).size >= 2 || (e===linked && e.querySelector('[role="slider"],input[type="range"]')));
  const menu = (visible(linked) && menus.includes(linked) ? linked : menus.sort((a,b)=>a.getBoundingClientRect().width*a.getBoundingClientRect().height-b.getBoundingClientRect().width*b.getBoundingClientRect().height)[0]) || null;
  const ratioItem = menu ? ratioNodes(menu).filter(e=>clean(text(e))===desired.ratio).sort((a,b)=>a.getBoundingClientRect().width*a.getBoundingClientRect().height-b.getBoundingClientRect().width*b.getBoundingClientRect().height)[0] : null;
  const slider = menu ? [...menu.querySelectorAll('input[type="range"],[role="slider"]')].find(visible) : null;
  let durationTarget = null;
  if (slider) {
    const native = slider.matches('input[type="range"]');
    const min = Number(slider.getAttribute(native ? "min" : "aria-valuemin") ?? 4);
    const max = Number(slider.getAttribute(native ? "max" : "aria-valuemax") ?? 15);
    const step = Number(slider.getAttribute("step") || slider.getAttribute("aria-valuestep") || 1);
    const value = Number(native?slider.value:slider.getAttribute("aria-valuenow"));
    const valueIsSeconds = () => native && match && value === Number(match[2]) && min >= 4;
    durationTarget = {...point(slider),method:valueIsSeconds()?"native":"keyboard",min,max,step,value};
    if (action === "setDuration" && step > 0) {
      if (native && valueIsSeconds()) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(slider,String(desired.duration));
        slider.dispatchEvent(new Event("input",{bubbles:true}));
        slider.dispatchEvent(new Event("change",{bubbles:true}));
      } else slider.focus();
    }
  }
  return {
    model:text(model), ratio:match?.[1] || "", duration:match ? Number(match[2]) : null,
    modelMatches: Boolean(model) && normalizeModel(text(model))===normalizeModel(desired.model),
    panel: panel ? {...point(panel),text:summary,state:panel.getAttribute("data-state") || "",expanded:panel.getAttribute("aria-expanded")} : null,
    menuOpen:Boolean(menu), ratioTarget:point(ratioItem), durationTarget,
  };
}

async function reconcileVideoParameters(controller, session, desired) {
  const started = Date.now();
  const timeout = Math.max(50, Number(session.parameterVerificationTimeoutMs) || 3500);
  const read = async action => {
    const value = await controller.evaluate(session, `(${probeVideoParameters.toString()})(${JSON.stringify(desired)},${JSON.stringify(action || "read")})`);
    session.lastParameterDiagnostic = {desired,actual:value,elapsedMs:Date.now()-started};
    return value || {};
  };
  const fail = message => { throw Object.assign(new Error(message), {code:"DOUBAO_PARAMETER_CONFIG_FAILED",category:"parameters",safeToRetry:true,notSentVerified:session.phase!=="submitting",monitorDiagnostic:session.lastParameterDiagnostic}); };
  const wait = async predicate => {
    const deadline = Date.now()+timeout;
    do {
      const value = await read();
      if (predicate(value)) return value;
      if (Date.now()>=deadline) break;
      await new Promise(resolve=>setTimeout(resolve,Math.min(100,Math.max(1,deadline-Date.now()))));
    } while (true);
    return null;
  };
  const matches = state => state.modelMatches && state.ratio===desired.ratio && state.duration===desired.duration;
  const click = async key => {
    const before = await read(), target = before[key];
    if (!target) return false;
    return controller.dispatchHumanClick(session,target,async()=>{
      const current=await read(), fresh=current[key];
      if(key==="panel" && (current.menuOpen || current.panel?.state==="open" || current.panel?.expanded==="true")) return false;
      // React can remeasure the same visible option between the probe and the
      // physical click. Sub-pixel layout shifts are safe when the target is
      // still present; strict coordinate equality incorrectly rejected them.
      const dx=Number(fresh?.x)-Number(target.x),dy=Number(fresh?.y)-Number(target.y);
      // A scrollbar/slider mount can move a portal option by a few pixels.
      // Keep the click bound to the same live option while allowing that
      // bounded reflow; a newly probed target is still required each attempt.
      return Boolean(fresh && Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx,dy)<=24);
    });
  };
  const clickWithRetry = async (key, maxAttempts = 6) => {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (await click(key)) return true;
      // The parameter popover can reflow once after the model selection and
      // once again when the duration slider mounts. Re-probe the live target
      // instead of failing the whole submission on that transient layout.
      if (attempt + 1 < maxAttempts) await new Promise(resolve => setTimeout(resolve, 120));
    }
    return false;
  };
  const open = async () => {
    // Never toggle an open trigger shut because menu contents are still loading.
    for(let attempt=0;attempt<2;attempt++) {
      const current=await read();
      if(current.menuOpen) return current;
      if(!current.panel) { if(!await wait(s=>s.panel)) break; }
      await click("panel");
      const opened=await wait(s=>s.menuOpen);
      if(opened) return opened;
    }
    fail("豆包参数面板未就绪，未修改或提交生成参数");
  };
  let current=await wait(s=>Boolean(s.panel));
  if(!current) fail("没有找到豆包画面比例和时长设置");
  if(matches(current)) return desired;
  if(current.ratio!==desired.ratio) {
    await open();
    if(!await wait(s=>s.ratioTarget)) fail(`豆包参数面板没有找到画面比例：${desired.ratio}`);
    if(!await clickWithRetry("ratioTarget")) fail("比例选项已变化，请重新核对参数面板");
    current=await wait(s=>s.ratio===desired.ratio);
    if(!current) fail(`豆包画面比例未生效：${desired.ratio}`);
  }
  current=await read();
  if(current.duration!==desired.duration) {
    await open();
    current=await wait(s=>s.durationTarget);
    const slider=current?.durationTarget;
    if(!slider) fail("没有找到豆包视频时长滑杆");
    if (!(slider.step>0)) fail("视频时长控件步长无效");
    const prepared=await read("setDuration");
    if(!prepared.durationTarget || prepared.durationTarget.method!==slider.method) fail("视频时长控件已变化，请重新核对参数面板");
    if(slider.method==="keyboard") {
      const cdp=await controller.connect(session);
      const press=async key=>{await cdp.send("Input.dispatchKeyEvent",{type:"rawKeyDown",key,code:key});await cdp.send("Input.dispatchKeyEvent",{type:"keyUp",key,code:key});};
      await press("Home");
      current=await wait(s=>s.durationTarget?.value===slider.min && Number.isFinite(s.duration));
      if(!current) fail("视频时长滑杆未响应，未提交任务");
      // aria-valuenow is an index in some Doubao builds (6 means 10s).
      // Read the rendered seconds after each step; never compare seconds to indices.
      const steps=Math.min(100,Math.ceil((slider.max-slider.min)/slider.step));
      for(let index=0;index<steps && current.duration!==desired.duration;index++) {
        const before=current;
        await press("ArrowRight");
        current=await wait(s=>s.durationTarget?.value!==before.durationTarget.value && s.duration!==before.duration);
        if(!current) fail("视频时长滑杆未响应，未提交任务");
      }
      if(current.duration!==desired.duration) fail("当前页面未找到请求的视频时长");
    } else if(desired.duration<slider.min || desired.duration>slider.max) fail("当前页面未找到请求的视频时长");
  }
  if(!await wait(matches)) fail(`豆包视频参数确认失败：${desired.model} · ${desired.ratio} · ${desired.duration}s`);
  return desired;
}

module.exports={probeVideoParameters,reconcileVideoParameters,normalizeVideoModelLabel};

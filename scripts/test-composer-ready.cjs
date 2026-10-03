"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const {BrowserController} = require("../src/vendor/browser-controller.cjs");

function fixture({truncate = false, iconSend = false, clearAfterClicks = 0} = {}) {
  let text = "", inserts = 0, clicks = 0, enters = 0;
  const attrs = {}, listeners = {};
  class Textarea {
    get value() { return text; }
    set value(value) { text = truncate ? value.slice(0, 12) : value; }
  }
  const input = Object.assign(new Textarea(), {
    tagName: "TEXTAREA", className: "composer", disabled: false, readOnly: false,
    getBoundingClientRect: () => ({left: 0, top: 200, bottom: 400, right: 600, width: 600, height: 200}),
    getAttribute: key => attrs[key] || null, setAttribute: (key, value) => { attrs[key] = value; },
    querySelector: () => null, focus() {}, select() {}, getRootNode: () => document,
    addEventListener: (name, fn) => { listeners[name] = fn; }, dispatchEvent() {},
  });
  const button = {innerText: iconSend ? "" : "生成", outerHTML: iconSend ? '<button id="flow-end-msg-send" data-dbx-name="button" class="g-send-msg-btn-bg"></button>' : '<button></button>', disabled: false, getAttribute: () => null,
    getBoundingClientRect: () => ({left: 550, right: 600, top: 405, bottom: 445, width: 50, height: 40})};
  const document = {activeElement: input, querySelectorAll: selector => selector === "*" ? [] : selector.startsWith("button,") ? [button] : [input]};
  const context = vm.createContext({document, HTMLTextAreaElement: Textarea, HTMLInputElement: Textarea,
    getComputedStyle: () => ({display: "block", visibility: "visible"}),
    InputEvent: class {}, Event: class {}, location: {href: "https://www.doubao.com/chat/"},
  });
  const controller = Object.create(BrowserController.prototype);
  controller.evaluate = async (_session, expression) => expression.includes("function probePageBlocker") ? {kind:""} : vm.runInContext(expression, context);
  controller.connect = async () => ({send: async (method, params) => {
    if (method === "Input.insertText") { inserts++; input.value = params.text; }
    if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") { clicks++; if (clearAfterClicks > 0 && clicks >= clearAfterClicks) text = ""; }
    if (method === "Input.dispatchKeyEvent") enters++;
  }});
  return {controller, input, button, listeners, get inserts() { return inserts; }, get clicks() { return clicks; }, get enters() { return enters; }};
}

(async () => {
  const prompt = "冷蓝雨夜包围暖金救助空间。\n" + "顾言真抱稳三腿阿七，门仍关闭。".repeat(300) + "最后一句不可丢失。";
  const truncated = fixture({truncate: true});
  assert.equal(await truncated.controller.fillComposer({}, prompt, {timeoutMs: 300, stableMs: 60}), false, "only the first 12 characters must never count as a complete prompt");
  const full = fixture(), session = {};
  assert.equal(await full.controller.clickComposerSend(session), false, "no send without verified fill");
  assert.equal(await full.controller.fillComposer(session, prompt, {timeoutMs: 1000, stableMs: 60}), true);
  assert.equal(full.inserts, 1, "one native insert, no blind repeated input");
  assert.equal(full.input.value, prompt);
  assert.equal(await full.controller.clickComposerSend(session), true);
  assert.equal(full.clicks, 1);
  assert.equal(full.enters, 0, "slow input clearing after click must not cause Enter resubmission");
  assert.equal(await full.controller.clickComposerSend(session), false, "same verified fill cannot be sent twice");

  const changed = fixture(), changedSession = {};
  await changed.controller.fillComposer(changedSession, prompt, {timeoutMs: 1000, stableMs: 60});
  changed.input.value = prompt.slice(0, 12);
  assert.equal(await changed.controller.clickComposerSend(changedSession), false);
  assert.equal(changed.clicks, 0, "text changed after verification blocks send");

  const late = fixture(), lateSession = {};
  await late.controller.fillComposer(lateSession, prompt, {timeoutMs: 1000, stableMs: 60});
  const send = (await late.controller.connect()).send;
  late.controller.connect = async () => ({send: async (method, args) => {
    if (method === "Input.dispatchMouseEvent" && args.type === "mouseMoved") late.input.value = "";
    return send(method, args);
  }});
  assert.equal(await late.controller.clickComposerSend(lateSession), false);
  assert.equal(late.clicks, 0, "cleared while mouse moves is checked immediately before press");

  const transient = fixture(), transientSession = {};
  const inFlight = transient.controller.fillComposer(transientSession, prompt, {timeoutMs: 700, stableMs: 300});
  setTimeout(() => { transient.input.value = ""; }, 200);
  assert.equal(await inFlight, false, "briefly matching DOM is not stable editor state");
  assert.equal(transient.inserts, 1);

  const delayed = fixture({truncate: true}), delayedSession = {};
  const delayedFill = delayed.controller.fillComposer(delayedSession, prompt, {timeoutMs: 1100, stableMs: 60});
  setTimeout(() => { Object.defineProperty(delayed.input, "value", {value: prompt, configurable: true}); }, 350);
  assert.equal(await delayedFill, true, "wait for entire delayed prompt before allowing submit");
  delayed.listeners.compositionstart();
  assert.equal(await delayed.controller.clickComposerSend(delayedSession), false, "IME composition blocks sending");
  delayed.listeners.compositionend();
  delayed.input.setAttribute("data-doubao-composer-token", "another-editor");
  assert.equal(await delayed.controller.clickComposerSend(delayedSession), false, "replaced editor must be filled and checked again");
  const disabled = fixture(), disabledSession = {};
  await disabled.controller.fillComposer(disabledSession, prompt, {timeoutMs: 1000, stableMs: 60});
  disabled.button.disabled = true;
  assert.equal((await disabled.controller.readComposerReadiness(disabledSession, false, true)).sendPoint, undefined);
  setTimeout(() => { disabled.button.disabled = false; }, 300);
  assert.equal(await disabled.controller.clickComposerSend(disabledSession), true, "disabled submit waits for application readiness");
  assert.equal(disabled.clicks, 1);
  assert.equal(await disabled.controller.fillComposer(disabledSession, "不需要，直接帮我生成视频。", {timeoutMs: 1000, stableMs: 60}), true);
  assert.equal(disabled.input.value, "不需要，直接帮我生成视频。", "confirmation replaces old prompt with its own verified text");
  assert.equal(await disabled.controller.clickComposerSend(disabledSession), true);
  disabledSession.composerExpected.verified = true;
  disabled.button.innerText = "无关按钮";
  assert.equal((await disabled.controller.readComposerReadiness(disabledSession, false, true)).sendPoint, undefined, "missing send control never fabricates fallback coordinates");

  const retained = fixture({clearAfterClicks: 2}), retainedSession = {};
  await retained.controller.fillComposer(retainedSession, "不需要，直接帮我生成视频。", {timeoutMs: 1000, stableMs: 60});
  assert.equal(await retained.controller.clickComposerSend(retainedSession), true, "native click is only a send attempt");
  assert.equal(retained.clicks, 1, "delayed input clearing must never cause duplicate sends");
  assert.equal(await retained.controller.clickComposerSend(retainedSession), false, "delivery uncertainty cannot reuse the verified fill");

  for (const label of ["停止生成", "排队发送", "稍后发送"]) {
    const busy = fixture(), busySession = {};
    await busy.controller.fillComposer(busySession, "确认", {timeoutMs:1000,stableMs:60});
    busy.button.innerText = label;
    assert.equal((await busy.controller.readComposerReadiness(busySession,false,true)).sendPoint, undefined, `${label} must not be clicked as a send button`);
  }

  const iconSend = fixture({iconSend: true}), iconSession = {};
  await iconSend.controller.fillComposer(iconSession, prompt, {timeoutMs: 1000, stableMs: 60});
  assert.equal((await iconSend.controller.readComposerReadiness(iconSession, false, true)).sendPoint?.label, "", "icon-only Doubao send control is recognized by its DOM identity");
  assert.equal(await iconSend.controller.clickComposerSend(iconSession), true);
  assert.equal(iconSend.clicks, 1, "icon-only send control receives the native click");

  const moving = fixture(), movingSession = {};
  await moving.controller.fillComposer(movingSession, prompt, {timeoutMs: 1000, stableMs: 60});
  const movingSend = (await moving.controller.connect()).send;
  let moved = false;
  moving.controller.connect = async () => ({send: async (method, args) => {
    if (!moved && method === "Input.dispatchMouseEvent" && args.type === "mouseMoved") {
      moved = true;
      moving.button.getBoundingClientRect = () => ({left: 540, right: 590, top: 405, bottom: 445, width: 50, height: 40});
    }
    return movingSend(method, args);
  }});
  assert.equal(await moving.controller.clickComposerSend(movingSession), true, "layout shift before mouse press should reacquire the button instead of ending the job");
  assert.equal(moving.clicks, 1, "layout recovery must still send exactly once");

  const paragraphs = fixture(), paragraphSession = {};
  const paragraphSend = (await paragraphs.controller.connect()).send;
  paragraphs.controller.connect = async () => ({send: async (method, args) => {
    await paragraphSend(method, args);
    if (method === "Input.insertText") paragraphs.input.value = args.text.replace(/\n/g, " \n\n");
  }});
  assert.equal(await paragraphs.controller.fillComposer(paragraphSession, prompt, {timeoutMs: 1000, stableMs: 60}), true, "Doubao paragraph spacing is presentation, not missing prompt text");
  assert.equal(await paragraphs.controller.clickComposerSend(paragraphSession), true);
  assert.equal(paragraphs.clicks, 1);
  console.log("Composer readiness passed: truncation, delayed input, transient text, IME, replaced editor, pre-click races and single-send");
})().catch(error => { console.error(error); process.exitCode = 1; });

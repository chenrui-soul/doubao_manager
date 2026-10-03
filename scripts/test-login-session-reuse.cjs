"use strict";
const assert = require("node:assert/strict");
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === "electron") return {BrowserWindow: class {}, WebContentsView: class {}, shell: {}};
  return originalLoad.call(this, name, ...args);
};
const {EmbeddedBrowserManager} = require("../src/embedded-browser-manager.cjs");
Module._load = originalLoad;
const {BrowserController} = require("../src/vendor/browser-controller.cjs");

(async () => {
  const manager = new EmbeddedBrowserManager();
  manager.createSession = () => { throw new Error("login check created a second visible session"); };
  const account = {id: "test-reuse", platform: "豆包"};
  const session = {account, embedded: true, profile: "persist:test-reuse", webContents: {
    isDestroyed: () => false,
    getURL: () => "https://www.doubao.com/chat/",
    isLoading: () => false,
    session: {cookies: {get: async () => []}},
    executeJavaScript: async () => ({onPlatform: true, avatarFound: true, readyState: "complete", bodyTextLength: 100}),
  }};
  const controller = Object.create(BrowserController.prototype);
  controller.open = async () => session;
  controller.embeddedBrowserProvider = () => manager;
  const detected = await controller.detect(account);
  assert.equal(detected.loggedIn, true);
  assert.equal(detected.accountId, account.id);
  assert.equal(detected.partition, session.profile);
  assert.equal(manager.sessions.size, 0);

  // Accelerate only test timers; exercise real retry/stop behavior on a load
  // promise that never resolves, as happens during the reported login hang.
  const originalTimeout = global.setTimeout;
  let attempts = 0, stops = 0;
  const hung = {account, webContents: {
    isDestroyed: () => false,
    getURL: () => "about:blank",
    loadURL: () => { attempts++; return new Promise(() => {}); },
    stop: () => { stops++; },
  }};
  global.setTimeout = (callback, ms, ...args) => originalTimeout(callback, Math.min(ms, 5), ...args);
  try {
    await assert.rejects(manager.ensureLoaded(hung), /页面加载失败.*已重试 3 次.*加载超时/);
    assert.equal(attempts, 3);
    assert.equal(stops, 3);
    attempts = 0;
    hung.webContents.loadURL = async () => { if (++attempts === 1) throw new Error("ERR_FAILED"); };
    await manager.ensureLoaded(hung);
    assert.equal(attempts, 2, "transient navigation errors should recover");
  } finally { global.setTimeout = originalTimeout; }
  let destroyed = 0;
  const idle = {id: account.id, window: {destroy() { destroyed++; }}};
  manager.automationSessions.set(account.id, idle);
  manager.releaseIdleAutomation(account, () => true, 5);
  const release = manager.retainAutomation(account);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(destroyed, 0, "an active generation lease must cancel idle cleanup");
  release();
  manager.releaseIdleAutomation(account, () => false, 5);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(destroyed, 0, "uncertain submissions must retain their page context");
  manager.releaseIdleAutomation(account, () => true, 5);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(destroyed, 1, "idle login-only windows must be released");
  console.log("login session reuse and bounded navigation retries passed");
})().catch(error => { console.error(error); process.exitCode = 1; });

"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), Module = require("node:module"), {EventEmitter} = require("node:events");
const fixtureFile = path.join(__dirname, "../references/browser-resource-lifecycle.json");
if (!fs.existsSync(fixtureFile)) fs.writeFileSync(fixtureFile, JSON.stringify({accountIds: ["account-a", "account-b", "account-c", "account-d"], switches: 12, maxManualPages: 1}, null, 2));
const fixture = JSON.parse(fs.readFileSync(fixtureFile));
const holds = new Map();
let cacheClears = 0;
class Contents extends EventEmitter {
  constructor(options) { super(); this.options = options; this.url = ""; this.loads = 0; this.destroyed = false; this.session = {cookies: {get: async () => []}, clearCache: () => { cacheClears++; }}; }
  getURL() { return this.url; }
  isDestroyed() { return this.destroyed; }
  isLoading() { return !!this.loading; }
  setWindowOpenHandler() {}
  setBackgroundThrottling(value) { this.throttled = value; }
  async loadURL(url) { this.loads++; this.url = url; this.loading = true; await holds.get(this.options.partition); this.loading = false; }
  stop() { this.loading = false; }
  close() { this.destroyed = true; this.emit("destroyed"); }
  async executeJavaScript() { return {onPlatform: true, avatarFound: true, readyState: "complete", bodyTextLength: 100}; }
}
class View { constructor(options) { this.webContents = new Contents(options.webPreferences); } setVisible(value) { this.visible = value; } setBounds() {} }
class Window extends EventEmitter {
  constructor(options) { super(); this.options = options; this.webContents = new Contents(options.webPreferences); }
  destroy() { this.webContents.close(); this.emit("closed"); }
}
const load = Module._load;
Module._load = function(name, ...args) { return name === "electron" ? {BrowserWindow: Window, WebContentsView: View, shell: {}} : load.call(this, name, ...args); };
const {EmbeddedBrowserManager} = require("../src/embedded-browser-manager.cjs");
Module._load = load;
const main = new EventEmitter();
const children = new Set(); let maxChildren = 0;
Object.assign(main, {webContents: new EventEmitter(), isDestroyed: () => false, show() {}, focus() {}, getContentBounds: () => ({width: 1440, height: 900}), getBounds: () => ({width: 1440, height: 900}), contentView: {addChildView(view) { children.add(view); maxChildren = Math.max(maxChildren, children.size); }, removeChildView(view) { children.delete(view); }}});
const manager = new EmbeddedBrowserManager({mainWindow: main});
const accounts = fixture.accountIds.map(id => ({id, platform: "豆包"}));
(async () => {
  await manager.open(accounts[0]);
  const release = manager.retainAutomation(accounts[0]);
  const running = await manager.automationSession(accounts[0]);
  assert.equal(manager.closeAutomationSession(accounts[0].id).closed,false,"idle cleanup must not close a retained context");
  assert.equal(running.window.options.show, false, "generation windows must start hidden");
  const previousViews = [];
  for (let i = 0; i < fixture.switches; i++) {
    previousViews.push([...manager.sessions.values()][0]);
    await manager.open(accounts[(i + 1) % accounts.length]);
    assert.equal(manager.sessions.size, fixture.maxManualPages);
    assert.equal(running.webContents.isDestroyed(), false, "account switching must preserve generation WebContents");
    assert.equal(running.webContents.throttled, false);
  }
  assert.equal(maxChildren, 1, "old pages must be removed before allocating the next view");
  assert.ok(previousViews.every(item => item.webContents.isDestroyed()), "inactive manual views must actually close");
  assert.equal(cacheClears, 0, "switching must preserve the shared session cache and cookies");
  release();
  manager.closeAutomationSession(accounts[0].id);
  manager.closeVisibleSession(accounts[0].id);

  let finish;
  holds.set(manager.partitionFor(accounts[0]), new Promise(resolve => { finish = resolve; }));
  const first = manager.open(accounts[0]);
  const second = manager.open(accounts[0]);
  const duplicateView = manager.sessions.get(accounts[0].id);
  assert.equal(duplicateView.webContents.loads, 1, "double clicks share one navigation");
  let settled = false; second.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "a URL alone does not mean the shared navigation finished");
  finish(); await Promise.all([first, second]); holds.clear();

  manager.closeVisibleSession(accounts[0].id);
  holds.set(manager.partitionFor(accounts[0]), new Promise(() => {}));
  const superseded = manager.open(accounts[0]);
  const rejected = assert.rejects(superseded, error => error.code === "DOUBAO_BROWSER_OPEN_SUPERSEDED");
  await manager.open(accounts[1]); await rejected;
  assert.equal(manager.activeId, accounts[1].id);
  assert.equal(manager.sessions.size, 1);
  holds.clear();

  const {DoubaoWorker} = require("../src/doubao-worker.cjs");
  const worker = new DoubaoWorker({profileRoot: __dirname, tempRoot: __dirname, embeddedBrowserProvider: () => manager});
  const opened = await worker.open(accounts[2]);
  assert.equal(opened.loginChecked, true);
  assert.equal(opened.loggedIn, true);
  assert.equal(manager.automationSessions.size, 0, "manual open+detect must not allocate a hidden page");
  await worker.detect(accounts[2], {background: true});
  assert.equal(manager.automationSessions.size, 1, "generation login detection must use its independent context");
  await manager.open(accounts[2]);
  assert.equal(manager.automationSessions.size, 0, "opening an account should release its idle detection-only page");
  const dir = path.join(__dirname, "log"); fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, "browser-resource-lifecycle.json"), JSON.stringify({passed: true, switches: fixture.switches, maxManualViews: maxChildren, cacheClears}, null, 2));
  console.log("browser resource lifecycle passed: 12 switches, one manual view, protected background job, shared loading, cancelled obsolete navigation, no cache purge");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => manager.dispose());

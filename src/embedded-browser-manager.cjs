"use strict";

const {BrowserWindow, WebContentsView, shell} = require("electron");
const fs = require("fs");
const path = require("path");
const {DOUBAO_LOGIN_PROBE_EXPRESSION, classifyDoubaoLoginState, hasDecisivePageLoginSignal} = require("./vendor/doubao-login-state.cjs");

function safeId(value) { return String(value || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "unknown"; }
function isDoubaoUrl(url) { return /^https:\/\/(?:www\.)?(?:doubao\.com|dola\.com)(?:\/|$)/i.test(String(url || "")); }

function activateSession(sessions, item) {
  for (const other of sessions.values()) {
    if (other === item) continue;
    try { other.view?.setVisible(false); } catch {}
    other.visible = false;
  }
  try { item?.view?.setVisible(true); } catch {}
  if (item) item.visible = true;
}

class EmbeddedBrowserManager {
  constructor({mainWindow = null, dataRootProvider = () => ""} = {}) {
    this.mainWindow = null; this.dataRootProvider = dataRootProvider; this.sessions = new Map(); this.automationSessions = new Map(); this.activeId = ""; this.disposing = false;
    this.automationUsers = new Map();
    this.automationIdleTimers = new Map();
    this.lastVisibleUrls = new Map();
    this.taskViews = new Map();
    this.manualOwners = new Map();
    this.licenseBlocked = false;
    this.popupWindows = new Set();
    this.resizeHandler = () => this.layout(); this.setMainWindow(mainWindow);
  }
  setMainWindow(window) {
    if (this.mainWindow === window) return;
    try { this.mainWindow?.removeListener("resize", this.resizeHandler); this.mainWindow?.removeListener("show", this.resizeHandler); this.mainWindow?.webContents?.removeListener("did-finish-load", this.resizeHandler); } catch {}
    this.mainWindow = window || null;
    try {
      this.mainWindow?.on("resize", this.resizeHandler);
      // 创建 WebContentsView 时主窗口可能仍处于初始小尺寸；窗口真正显示
      // 或主界面加载完成后必须再次布局，否则会永久落入最小 380px 宽度。
      this.mainWindow?.on("show", this.resizeHandler);
      this.mainWindow?.webContents?.on("did-finish-load", this.resizeHandler);
    } catch {}
    this.layout();
  }
  platformUrl(account) { return String(account?.platform || "豆包").toLowerCase() === "dola" ? "https://www.dola.com/chat/" : "https://www.doubao.com/chat/"; }
  partitionFor(account) { return `persist:doubao_service_${safeId(account?.id)}`; }
  taskUrl(account, conversationId) {
    if (!/^\d{5,30}$/.test(String(conversationId))) throw new Error("原会话编号无效，不能打开任务页面");
    return this.platformUrl(account) + encodeURIComponent(conversationId);
  }
  assertUserAccess() {
    if (this.licenseBlocked) throw Object.assign(new Error("授权无效，请返回工作台重新验证"), {code: "DOUBAO_LICENSE_REQUIRED", statusCode: 403});
  }
  guardWindow(item) {
    item.webContents.on("before-input-event", event => { if (this.licenseBlocked) event.preventDefault(); });
    item.window?.on("show", () => { if (this.licenseBlocked) item.window.hide(); });
    item.webContents.on("did-create-window", window => {
      this.popupWindows.add(window);
      window.once("closed", () => this.popupWindows.delete(window));
      if (this.licenseBlocked) window.destroy();
    });
  }
  async setLicenseValid(valid) {
    this.licenseBlocked = valid !== true;
    for (const item of this.automationSessions.values()) item.window?.setIgnoreMouseEvents?.(this.licenseBlocked);
    if (!this.licenseBlocked) return; // Recovery never opens or takes over a page automatically.
    for (const id of [...this.sessions.keys()]) this.closeVisibleSession(id);
    for (const item of this.taskViews.values()) { try { item.window.destroy(); } catch {} }
    this.taskViews.clear();
    for (const window of this.popupWindows) { try { window.destroy(); } catch {} }
    this.popupWindows.clear();
    const freezing = [];
    for (const item of this.automationSessions.values()) {
      item.window?.hide?.();
      if (item.blockedForUser || this.manualOwners.has(item.id)) {
        freezing.push(this.setTaskReadOnly(item, true).catch(() => { item.window?.hide?.(); }));
      }
    }
    // Keep original sessions and manual ownership; API/pre-submit checks block new
    // work. Existing generation can still collect its result without resubmitting.
    await Promise.all(freezing);
  }
  async setTaskReadOnly(item, readOnly) {
    readOnly = readOnly === true || this.licenseBlocked === true;
    item.taskReadOnly = readOnly;
    if (!item.taskGuardInstalled) {
      item.taskGuardInstalled = true;
      const install = () => { if (this.alive(item) && item.webContents.getURL()) return item.webContents.executeJavaScriptInIsolatedWorld(993, [{code: `(() => {
        if (!globalThis.taskViewGuard) {
          globalThis.taskViewGuard = {readOnly: true};
          for (const event of ['click','dblclick','auxclick','pointerdown','pointerup','mousedown','mouseup','keydown','beforeinput','paste','drop','submit'])
            document.addEventListener(event, e => {
              const guard=globalThis.taskViewGuard;
              if (guard.readOnly && !(e.type==='click' && !e.isTrusted && guard.playbackTarget && e.target===guard.playbackTarget)) {e.preventDefault();e.stopImmediatePropagation();}
            }, true);
        }
        globalThis.taskViewGuard.readOnly = ${item.taskReadOnly === true};
      })()`}]); };
      item.webContents.on("dom-ready", () => { Promise.resolve(install()).catch(error => {
        if (item.taskReadOnly) item.window?.hide();
        console.warn(`task-view-guard account=${item.id} failed=${error.message}`);
      }); });
      item.webContents.on("before-input-event", (event) => { if (item.taskReadOnly) event.preventDefault(); });
      item.webContents.on("will-navigate", (event) => { if (item.taskReadOnly) event.preventDefault(); });
      item.installTaskGuard = install;
    }
    // A brand-new WebContents has no document; evaluating before its first
    // load waits for a load that the caller has not started yet.
    if (!item.webContents.getURL()) return;
    await item.webContents.executeJavaScriptInIsolatedWorld(993, [{code: `if(globalThis.taskViewGuard) globalThis.taskViewGuard.readOnly=${readOnly === true}`}]);
    await item.installTaskGuard();
  }
  async openTask(job) {
    this.assertUserAccess();
    const {account, taskContext: c} = job, url = this.taskUrl(account, c.conversationId);
    let item = this.taskViews.get(job.id);
    if (!this.alive(item)) {
      // A separate read-only page shares only the original account partition.
      // It never navigates or closes the page used by the generation worker.
      const window = new BrowserWindow({show: false, width: 1200, height: 840, title: "原会话 · 只读查看", webPreferences: {partition: this.partitionFor(account), contextIsolation: true, nodeIntegration: false, sandbox: false}});
      item = {window, webContents: window.webContents, id: account.id};
      this.taskViews.set(job.id, item);
      window.removeMenu();
      window.webContents.setWindowOpenHandler(() => ({action: "deny"}));
      window.on("page-title-updated", event => event.preventDefault());
      window.once("closed", () => this.taskViews.delete(job.id));
      await this.setTaskReadOnly(item, true);
      try { await window.loadURL(url); await this.setTaskReadOnly(item, true); } catch (error) { window.destroy(); throw error; }
    }
    this.assertUserAccess();
    item.window.setTitle(`${account.id} · ${job.id} · 只读查看（操作请在工作台人工接管）`);
    item.window.show(); item.window.focus();
    return {ok: true, accountId: account.id, conversationId: c.conversationId, readOnly: true};
  }
  async takeoverTask(job) {
    this.assertUserAccess();
    const {account, taskContext: c} = job;
    if (this.automationUsers.get(account.id)) throw new Error("原账号仍有自动操作，请稍后接管");
    const existing = this.automationSessions.get(account.id);
    const item = this.manualOwners.get(account.id) === job.id && this.alive(existing) ? existing : await this.automationSession(account), url = this.taskUrl(account, c.conversationId);
    if (item.webContents.getURL().split(/[?#]/)[0].replace(/\/$/, "") !== url.replace(/\/$/, "")) await item.webContents.loadURL(url);
    this.assertUserAccess();
    this.manualOwners.set(account.id, job.id);
    item.blockedForUser = true;
    await this.setTaskReadOnly(item, false);
    if (this.licenseBlocked) await this.setTaskReadOnly(item, true);
    this.assertUserAccess();
    item.window.setTitle(`${account.id} · ${job.id} · 人工接管（完成后返回工作台结束接管）`);
    item.window.show(); item.window.focus();
    return {ok: true, accountId: account.id, conversationId: c.conversationId, manual: true};
  }
  async freezeTakeover(job) {
    const item = this.automationSessions.get(job.account.id);
    if (this.alive(item)) { await this.setTaskReadOnly(item, true); item.window.hide(); item.blockedForUser = false; }
    this.manualOwners.delete(job.account.id);
    return {ok: true};
  }
  async withTaskResultPlayback(job, candidate, callback) {
    this.assertUserAccess();
    const item=this.automationSessions.get(job.account.id);
    if (!this.alive(item) || !item.taskReadOnly) return callback();
    // A frozen takeover page may open exactly one result card programmatically.
    // All human input, navigation, form submission and other clicks stay blocked.
    await item.webContents.executeJavaScriptInIsolatedWorld(993,[{code:`(() => {
      const guard=globalThis.taskViewGuard;if(!guard)return;
      const message=[...document.querySelectorAll('[data-message-id]')].find(node=>node.getAttribute('data-message-id')===${JSON.stringify(candidate.messageId)});
      const selector='video,[class*="block-video"],[class*="video-player"],[class*="play-icon-wrapper"]';
      const cards=message?[...message.querySelectorAll(selector)].filter(node=>!node.parentElement?.closest(selector)||!message.contains(node.parentElement.closest(selector))):[];
      guard.playbackTarget=cards[${JSON.stringify(candidate.cardIndex)}]||null;
    })()`}]);
    try {return await callback();}
    finally {if(this.alive(item))await item.webContents.executeJavaScriptInIsolatedWorld(993,[{code:"if(globalThis.taskViewGuard)globalThis.taskViewGuard.playbackTarget=null"}]);}
  }
  alive(item) { return Boolean(item?.webContents && !item.webContents.isDestroyed()); }
  createSession(account) {
    const id = safeId(account?.id), current = this.sessions.get(id);
    if (this.alive(current)) { current.account = {...current.account, ...account, id}; return current; }
    if (!this.mainWindow || this.mainWindow.isDestroyed()) throw new Error("豆包工作台窗口尚未就绪");
    const partition = this.partitionFor(account), root = this.dataRootProvider();
    if (root) { const marker = path.join(root, "embedded-browser-profiles", id); fs.mkdirSync(marker, {recursive: true}); fs.writeFileSync(path.join(marker, "partition.txt"), partition, "utf8"); }
    // Windows 下持久化 partition 的 Network 目录可能被 Chromium 网络沙箱拒绝访问，
    // 导致 loadURL 直接返回 ERR_FAILED。内嵌窗口仍保持隔离（无 Node 注入），关闭
    // renderer sandbox 仅用于兼容本地持久化会话。
    const view = new WebContentsView({webPreferences: {partition, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: true}});
    this.mainWindow.contentView.addChildView(view); view.setVisible(false);
    const item = {id, account: {...account, id}, partition, view, webContents: view.webContents, visible: false, automationUsers: 0}; this.sessions.set(id, item);
    view.webContents.on("dom-ready", () => { item.domReadyAt = Date.now(); });
    view.webContents.on("did-finish-load", () => { item.loadFinishedAt = Date.now(); });
    this.guardWindow(item);
    view.webContents.setWindowOpenHandler(({url}) => { if (this.licenseBlocked) return {action: "deny"}; if (isDoubaoUrl(url)) return {action: "allow"}; shell.openExternal(url); return {action: "deny"}; });
    view.webContents.on("did-navigate", () => this.layout());
    view.webContents.once("destroyed", () => { if (this.sessions.get(id) === item) this.sessions.delete(id); });
    this.layout(); return item;
  }
  layout() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    // 与工作台左侧账号中心、右侧窗口标题栏对齐；WebContentsView 不覆盖控制区。
    const content = this.mainWindow.getContentBounds(), outer = this.mainWindow.getBounds();
    // 某些 Windows/Electron 启动时 getContentBounds() 会短暂返回约 600px
    // 的旧值；主窗口已经显示后优先采用外框尺寸，避免内嵌页面被锁在 380px。
    const bounds = content.width >= 900 && content.height >= 600 ? content : outer;
    const left = 252, top = 44, right = 0, bottom = 0;
    for (const item of this.sessions.values()) if (this.alive(item)) item.view.setBounds({x: left, y: top, width: Math.max(520, bounds.width - left - right), height: Math.max(420, bounds.height - top - bottom)});
  }
  async ensureLoaded(item) {
    if (!this.alive(item)) throw Object.assign(new Error("豆包页面已关闭，请核对原任务"),{code:"DOUBAO_BROWSER_CONTEXT_CLOSED"});
    if (item.loadingPromise) return item.loadingPromise;
    if (item.closed) throw this.openSuperseded();
    if (item.webContents.getURL() && !item.webContents.getURL().startsWith("about:")) return item;
    const promise = this.loadSession(item);
    item.loadingPromise = promise;
    try { return await promise; }
    finally { if (item.loadingPromise === promise) { delete item.loadingPromise; delete item.cancelLoading; } }
  }
  openSuperseded() { return Object.assign(new Error("已切换到其他账号，停止加载上一个页面"), {code: "DOUBAO_BROWSER_OPEN_SUPERSEDED"}); }
  async loadSession(item) {
    item.loadStartedAt = Date.now();
    const url = !item.automation && this.lastVisibleUrls.get(item.id) || this.platformUrl(item.account);
    const timeoutMs = Math.max(5_000, Number(process.env.DOUBAO_PAGE_LOAD_TIMEOUT_MS || 30_000));
    const cancelled = new Promise((_, reject) => { item.cancelLoading = () => reject(this.openSuperseded()); });
    cancelled.catch(() => {}); // loadURL can throw synchronously before the race attaches.
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (item.closed) throw this.openSuperseded();
      try {
        let timer;
        await Promise.race([
          item.webContents.loadURL(url),
          cancelled,
          new Promise((_, reject) => { timer = setTimeout(() => { try { item.webContents.stop(); } catch {} reject(new Error(`豆包页面加载超时（${Math.round(timeoutMs / 1000)} 秒）`)); }, timeoutMs); }),
        ]).finally(() => clearTimeout(timer));
        return item;
      }
      catch (error) { if (item.closed || error.code === "DOUBAO_BROWSER_OPEN_SUPERSEDED") throw this.openSuperseded(); lastError = error; if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 800 * attempt)); }
    }
    throw new Error(`豆包页面加载失败（已重试 3 次）：${lastError?.message || lastError || "ERR_FAILED"}`);
  }
  async open(account, {focus = true} = {}) {
    this.assertUserAccess();
    const id = safeId(account?.id);
    // One manual account page at a time. Background generation uses a separate
    // map, so switching pages never destroys an executing job's WebContents.
    for (const otherId of [...this.sessions.keys()]) if (otherId !== id) this.closeVisibleSession(otherId);
    const background = this.automationSessions.get(id);
    if (this.alive(background) && background.blockedForUser) {
      if (!this.manualOwners.has(id) && background.taskReadOnly) await this.setTaskReadOnly(background, false);
      this.assertUserAccess();
      background.window?.show(); background.window?.focus();
      return {...this.status(id),manualActionRequired:true};
    }
    if (!this.automationUsers.get(id) && background?.canReleaseWhenIdle?.()) this.closeAutomationSession(id);
    const item = this.createSession(account);
    this.activeId = id;
    activateSession(this.sessions, item); this.layout();
    if (focus) { this.mainWindow.show(); this.mainWindow.focus(); }
    await this.ensureLoaded(item);
    this.assertUserAccess();
    if (this.sessions.get(id) !== item || this.activeId !== id) throw this.openSuperseded();
    return this.status(id);
  }
  async automationSession(account) {
    const id = safeId(account?.id), current = this.automationSessions.get(id);
    if (this.manualOwners.has(id)) throw Object.assign(new Error("原账号处于人工接管，自动操作已暂停"), {code: "DOUBAO_MANUAL_CONTROL_ACTIVE"});
    if (this.alive(current)) { current.account = {...current.account, ...account, id}; if(current.taskReadOnly) await this.setTaskReadOnly(current, false); return this.ensureLoaded(current); }
    if (!this.mainWindow || this.mainWindow.isDestroyed()) throw new Error("豆包工作台窗口尚未就绪");
    const partition = this.partitionFor(account), root = this.dataRootProvider();
    if (root) { const marker = path.join(root, "embedded-browser-profiles", id); fs.mkdirSync(marker, {recursive: true}); fs.writeFileSync(path.join(marker, "partition.txt"), partition, "utf8"); }
    // API 任务使用独立的隐藏 BrowserWindow。它保留真实的渲染视口和
    // backgroundThrottling=false，但不会抢占工作台焦点，也不会让多个账号
    // 的 WebContentsView 互相覆盖。
    const window = new BrowserWindow({show: false, width: 1280, height: 900, webPreferences: {partition, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false}});
    try { window.webContents.setBackgroundThrottling(false); } catch {}
    const item = {id, account: {...account, id}, partition, window, webContents: window.webContents, view: null, visible: false, automation: true, automationUsers: this.automationUsers.get(id) || 0};
    this.automationSessions.set(id, item);
    this.guardWindow(item);
    window.setIgnoreMouseEvents?.(this.licenseBlocked);
    window.on("close", event => { if (!this.disposing && this.manualOwners.has(id)) {event.preventDefault();window.hide();} });
    window.webContents.setWindowOpenHandler(({url}) => { if (this.licenseBlocked) return {action: "deny"}; if (isDoubaoUrl(url)) return {action: "allow"}; shell.openExternal(url); return {action: "deny"}; });
    window.once("closed", () => { item.closed=true; item.cancelLoading?.(); if (this.automationSessions.get(id) === item) this.automationSessions.delete(id); });
    await this.ensureLoaded(item);
    return item;
  }
  retainAutomation(account) {
    const id = safeId(account?.id);
    clearTimeout(this.automationIdleTimers.get(id));
    this.automationIdleTimers.delete(id);
    const count = (this.automationUsers.get(id) || 0) + 1;
    this.automationUsers.set(id, count);
    const background = this.automationSessions.get(id);
    if (background) { background.automationUsers = count; delete background.canReleaseWhenIdle; }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = Math.max(0, (this.automationUsers.get(id) || 1) - 1);
      if (remaining) this.automationUsers.set(id, remaining); else this.automationUsers.delete(id);
      const background = this.automationSessions.get(id);
      if (background) background.automationUsers = remaining;
    };
  }
  releaseIdleAutomation(account, canClose = () => true, delayMs = 10_000) {
    const id = safeId(account?.id), item = this.automationSessions.get(id);
    if (!item || this.automationUsers.get(id)) return;
    item.canReleaseWhenIdle = canClose;
    clearTimeout(this.automationIdleTimers.get(id));
    const timer = setTimeout(() => {
      this.automationIdleTimers.delete(id);
      if (this.automationSessions.get(id) !== item || this.automationUsers.get(id) || !canClose()) return;
      this.closeAutomationSession(id);
    }, delayMs);
    timer.unref?.();
    this.automationIdleTimers.set(id, timer);
  }
  async detect(account, existingItem = null) {
    const item = await this.ensureLoaded(existingItem && this.alive(existingItem) ? existingItem : this.createSession(account));
    const cookies = await item.webContents.session.cookies.get({url: this.platformUrl(item.account)});
    let probe = {onPlatform: isDoubaoUrl(item.webContents.getURL()), readyState: item.webContents.isLoading() ? "loading" : "complete", bodyTextLength: 0};
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (item.closed) throw this.openSuperseded();
      try { probe = await item.webContents.executeJavaScript(DOUBAO_LOGIN_PROBE_EXPRESSION, true); }
      catch (error) { probe = {...probe, probeError: String(error?.message || error)}; }
      if (item.closed) throw this.openSuperseded();
      const stable = probe.readyState === "complete" && Number(probe.bodyTextLength || 0) > 20;
      if (hasDecisivePageLoginSignal(probe) || (stable && attempt >= 4)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return {...classifyDoubaoLoginState({...probe, url: item.webContents.getURL()}, cookies), accountId: item.id || safeId(account.id), partition: item.partition || item.profile, embedded: true};
  }
  closeAutomationSession(id, {force=false,reason="idle"} = {}) {
    clearTimeout(this.automationIdleTimers.get(id)); this.automationIdleTimers.delete(id);
    const item = this.automationSessions.get(id);
    if (!item) return {ok: true, closed: false, accountId: id, automation: true};
    if(!force&&!this.disposing&&(this.automationUsers.get(id)||item.blockedForUser)) return {ok:false,closed:false,accountId:id,reason:"session_in_use"};
    console.log(`browser-context-close account=${id} reason=${reason} users=${this.automationUsers.get(id)||0}`);
    item.closed = true; item.cancelLoading?.();
    this.automationSessions.delete(id);
    try { item.window?.destroy(); } catch {}
    return {ok: true, closed: true, accountId: id, automation: true};
  }
  closeVisibleSession(id) {
    const item = this.sessions.get(id);
    if (!item) return {ok: true, closed: false, accountId: id};
    try { const url = item.webContents.getURL(); if (isDoubaoUrl(url)) this.lastVisibleUrls.set(id, url); } catch {}
    item.closed = true; item.cancelLoading?.();
    this.sessions.delete(id);
    try { this.mainWindow?.contentView.removeChildView(item.view); } catch {}
    try { item.webContents.close({waitForBeforeUnload: false}); } catch {}
    if (this.activeId === id) this.activeId = "";
    return {ok: true, closed: true, accountId: id};
  }
  close(account, options={}) { const id = safeId(typeof account === "object" ? account?.id : account); return this.automationSessions.has(id) ? this.closeAutomationSession(id,options) : this.closeVisibleSession(id); }
  showActive() { this.assertUserAccess(); const item = this.sessions.get(this.activeId); if (!item) return {ok: false, message: "当前没有打开的豆包窗口"}; activateSession(this.sessions, item); this.layout(); this.mainWindow?.focus(); return this.status(item.id); }
  focusActive() { return this.showActive(); }
  hideActive() { const item = this.sessions.get(this.activeId); if (!item) return {ok: false, message: "当前没有打开的豆包窗口"}; item.view.setVisible(false); item.visible = false; return this.status(item.id); }
  closeAll() { for (const id of [...this.automationSessions.keys()]) this.closeAutomationSession(id); for (const id of [...this.sessions.keys()]) this.closeVisibleSession(id); }
  status(accountId = "") { const values = [...this.sessions.values(), ...this.automationSessions.values()].filter(item => this.alive(item)), describe = item => ({accountId: item.id, partition: item.partition, url: item.webContents.getURL(), visible: item.visible === true, automation: item.automation === true, loading: item.webContents.isLoading(), domReadyMs: item.domReadyAt && item.loadStartedAt ? item.domReadyAt - item.loadStartedAt : null, pageLoadMs: item.loadFinishedAt && item.loadStartedAt ? item.loadFinishedAt - item.loadStartedAt : null}), current = values.find(item => item.id === safeId(accountId || this.activeId)); return {ok: true, embedded: true, activeAccountId: this.activeId || null, current: current ? describe(current) : null, accounts: values.map(describe)}; }
  dispose() { this.disposing = true; for (const item of this.taskViews.values()) {try {item.window.destroy();} catch {}} this.taskViews.clear(); this.manualOwners.clear(); for (const timer of this.automationIdleTimers.values()) clearTimeout(timer); this.automationIdleTimers.clear(); this.closeAll(); try { this.mainWindow?.removeListener("resize", this.resizeHandler); } catch {} }
}

module.exports = {EmbeddedBrowserManager, activateSession};

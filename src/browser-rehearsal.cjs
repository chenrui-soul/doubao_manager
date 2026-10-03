"use strict";
const fs = require("node:fs"), path = require("node:path");
function shouldBlockRequest(details, strict) {
  if (["GET", "HEAD", "OPTIONS"].includes(details.method)) return false;
  if (strict) return true;
  return /completion|generate|(?:send|create)[_/-]?message|message[_/-]?(?:send|create)/i.test(new URL(details.url).pathname);
}
// A separate workflow with no send or confirmation step.
async function rehearseAccount(controller, account, payload, screenshotDir) {
  const started = Date.now(), steps = [], blockedRequests = [];
  const manager = controller.embeddedBrowserProvider(), release = manager.retainAutomation(account);
  let session, strict = false, browserSession, targetId, timer;
  const result = {accountId: account.id, ok: false, steps, blockedRequests};
  async function step(name, run) {
    const at = Date.now();
    try { const value = await run(); steps.push({name, ms: Date.now() - at, ok: true}); return value; }
    catch (error) { steps.push({name, ms: Date.now() - at, ok: false}); throw error; }
  }
  const screenshot = async suffix => {
    if (!session?.webContents || session.webContents.isDestroyed()) return;
    const file = path.join(screenshotDir, `${account.id}-${suffix}.png`);
    fs.writeFileSync(file, (await session.webContents.capturePage()).toPNG()); result.screenshot = file;
  };
  try {
    timer = setTimeout(() => manager.closeAutomationSession(account.id,{force:true,reason:"rehearsal_timeout"}), 180_000);
    session = await step("open_page", () => controller.open(account));
    if (!session.embedded || session.testMode) throw new Error("页面预演必须使用真实 Electron 页面");
    session.rehearsal = true; session.phase = "rehearsing";
    browserSession = session.webContents.session; targetId = session.webContents.id;
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const blocked = details.webContentsId === targetId && shouldBlockRequest(details, strict);
      if (blocked) blockedRequests.push({method: details.method, path: new URL(details.url).pathname});
      callback({cancel: blocked});
    });
    const login = await step("check_login", () => controller.detect(account));
    if (!login.loggedIn || login.verificationRequired) throw new Error(login.verificationRequired ? "账号需要人工验证" : "账号未登录");
    await step("new_conversation", () => controller.prepareFreshConversation(session, account));
    await step("video_mode", () => controller.ensureVideoMode(session));
    result.parameters = await step("select_parameters", () => controller.setVideoParameters(session, payload));
    await step("close_panel", () => controller.closeVideoParameterPanel(session));
    await step("composer_ready", () => controller.waitForComposer(session, 12000));
    // Deny all non-read requests before inserting a prompt, independent of
    // endpoint names. Keep the guard until the window has been destroyed.
    strict = true;
    await step("fill_prompt", async () => { if (!await controller.fillComposer(session, payload.prompt)) throw new Error("提示词输入未通过校验"); });
    result.composer = await step("verify_composer", () => controller.readComposerReadiness(session, false, true));
    if (!result.composer.ready || !result.composer.sendPoint) throw new Error(`输入框或发送按钮未就绪：${result.composer.reason || "unknown"}`);
    result.hidden = !session.window?.isVisible();
    result.rendererPid = session.webContents.getOSProcessId();
    await step("capture_page", () => screenshot("ready"));
    result.ok = true; result.stoppedBeforeSend = true;
    await step("clear_draft", async () => {
      await controller.readComposerReadiness(session, true);
      const cdp = await controller.connect(session);
      await cdp.send("Input.dispatchKeyEvent", {type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8});
      await cdp.send("Input.dispatchKeyEvent", {type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8});
      await controller.navigateSession(session, "about:blank");
    });
  } catch (error) {
    result.ok = false; result.error = {code: error.code || "REHEARSAL_FAILED", message: String(error.message || error)};
    try { await screenshot("failed"); } catch {}
  } finally {
    clearTimeout(timer);
    try { controller.closeAccount(account,{force:true,reason:"rehearsal_complete"}); } finally { try { browserSession?.webRequest.onBeforeRequest(null); } catch {} release(); }
    result.totalMs = Date.now() - started;
  }
  return result;
}
async function rehearseBrowsers(worker, accounts, payload) {
  const manager = worker.controller.embeddedBrowserProvider?.();
  if (!manager) throw new Error("请通过桌面程序运行真实页面预演");
  const {app} = require("electron"), started = Date.now();
  const dir = path.join(worker.tempRoot, "browser-rehearsal", String(started)); fs.mkdirSync(dir, {recursive: true});
  const samples = [];
  const sample = () => {
    const metrics = app.getAppMetrics(), pages = [...manager.automationSessions.values()].filter(item => manager.alive(item));
    const cpuValues = metrics.map(m => Number(m.cpu?.percentCPUUsage)).filter(Number.isFinite);
    const rendererCpuValues = metrics.filter(m => m.type === "Tab").map(m => Number(m.cpu?.percentCPUUsage)).filter(Number.isFinite);
    samples.push({elapsedMs: Date.now() - started,
      workingSetMB: Math.round(metrics.reduce((n, m) => n + (m.memory?.workingSetSize || 0), 0) / 1024),
      cpuPercent: cpuValues.length ? Math.round(cpuValues.reduce((n, value) => n + value, 0) * 100) / 100 : null,
      rendererCpuPercent: rendererCpuValues.length ? Math.round(rendererCpuValues.reduce((n, value) => n + value, 0) * 100) / 100 : null,
      rendererCount: metrics.filter(m => m.type === "Tab").length, automationPages: pages.length, visibleAutomationPages: pages.filter(item => item.window?.isVisible()).length});
  };
  sample(); const timer = setInterval(sample, 500); let results;
  try { results = await Promise.all(accounts.map(account => rehearseAccount(worker.controller, account, payload, dir))); }
  finally { clearInterval(timer); sample(); }
  return {mode: "real-page-no-submit", startedAt: new Date(started).toISOString(), totalMs: Date.now() - started, accountCount: accounts.length, results, samples,
    peakWorkingSetMB: Math.max(...samples.map(s => s.workingSetMB)), peakCpuPercent: Math.max(...samples.map(s => s.cpuPercent ?? 0)), peakRendererCpuPercent: Math.max(...samples.map(s => s.rendererCpuPercent ?? 0)), cpuMetricAvailable: samples.some(s => s.cpuPercent !== null), peakAutomationPages: Math.max(...samples.map(s => s.automationPages)), maxVisibleAutomationPages: Math.max(...samples.map(s => s.visibleAutomationPages)),
    memoryNote: "Electron 所属进程工作集之和；不含独立 API 进程与独立显存。按 500ms 采样。"};
}
module.exports = {shouldBlockRequest, rehearseAccount, rehearseBrowsers};

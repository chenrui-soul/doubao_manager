"use strict";

const path = require("path");
const {app, BrowserWindow, ipcMain, shell, screen} = require("electron");
const {fork} = require("child_process");
const fs = require("fs");
const {EmbeddedBrowserManager} = require(path.join(__dirname, "..", "src", "embedded-browser-manager.cjs"));
const {DoubaoWorker} = require(path.join(__dirname, "..", "src", "doubao-worker.cjs"));
const {RemoteConnector, validateProfile} = require(path.join(__dirname, "..", "src", "remote-connector.cjs"));
const {getStoredLicenseSecret} = require(path.join(__dirname, "..", "src", "license.cjs"));
const {cleanupBrowserCaches, truncateLog} = require(path.join(__dirname, "..", "src", "cache-cleaner.cjs"));

// Keep Chromium's HTTP cache for repeated account checks and submissions.
// The previous unconditional switch redownloaded provider scripts each time.
// Use the available GPU for page compositing. Software rendering is an
// explicit compatibility fallback, not the default for every account page.
if (process.env.DOUBAO_SOFTWARE_RENDERING === "1") {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("in-process-gpu");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  app.commandLine.appendSwitch("use-gl", "swiftshader");
  app.disableHardwareAcceleration();
}
// 当前 Windows 环境对 Electron Chromium 沙箱目录访问受限，导致 renderer 以 49 退出。
// 桌面宿主是本地单机应用，关闭 Chromium 沙箱以保证主界面和内嵌豆包窗口可启动。
app.commandLine.appendSwitch("no-sandbox");
try {
  // 开发版和 EXE 版必须共用同一个正式数据根目录，避免登录 Cookie 分裂。
  const formalRoot = path.join(process.env.LOCALAPPDATA || app.getPath("userData"), "DoubaoVideoManager");
  app.setPath("userData", path.join(formalRoot, "electron-user-data"));
} catch {}
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
  process.exit(0);
}
let mainWindow;
let serviceProcess;
let serviceStartup;
let inProcessServer;
let hostWorker;
let runtimeRoot;
let embeddedBrowser;
let remoteConnector;
let remoteConnectorConfigRoot;
let quitting = false;
let progressSequence = 0;
const pendingProgress = new Map();

function log(message) {
  try {
    const root = runtimeRoot || path.join(__dirname, "..");
    const file = path.join(root, "data", "desktop.log");
    fs.mkdirSync(path.dirname(file), {recursive: true});
    truncateLog(file);
    fs.appendFileSync(file, `${new Date().toISOString()} ${String(message || "").slice(0, 4000)}\n`);
    truncateLog(file);
  } catch {}
}

function writeBuiltInMcpConfig() {
  try {
    const installRoot = path.join(process.env.LOCALAPPDATA || app.getPath("userData"), "DoubaoVideoManager");
    const appRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..");
    const serverPath = app.isPackaged ? path.join(process.resourcesPath, "mcp-server.cjs") : path.join(appRoot, "src", "mcp-server.cjs");
    const config = {mcpServers: {"doubao-video-manager": {
      command: process.execPath,
      args: [serverPath],
      env: {ELECTRON_RUN_AS_NODE: "1"},
    }}};
    fs.mkdirSync(installRoot, {recursive: true});
    fs.writeFileSync(path.join(installRoot, "mcp-config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
    log(`mcp-config-written path=${path.join(installRoot, "mcp-config.json")}`);
  } catch (error) { log(`mcp-config-write-error ${error.message || error}`); }
}

function ensureWindowOnScreen() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    const displays = screen.getAllDisplays();
    const bounds = mainWindow.getBounds();
    const display = displays.find(item => {
      const area = item.workArea;
      const overlapWidth = Math.max(0, Math.min(bounds.right, area.x + area.width) - Math.max(bounds.left, area.x));
      const overlapHeight = Math.max(0, Math.min(bounds.bottom, area.y + area.height) - Math.max(bounds.top, area.y));
      return overlapWidth >= Math.min(400, area.width * 0.4) && overlapHeight >= Math.min(300, area.height * 0.4);
    });
    const area = (display || screen.getPrimaryDisplay()).workArea;
    const width = Math.max(900, Math.min(bounds.width || 1440, area.width - 24));
    const height = Math.max(620, Math.min(bounds.height || 900, area.height - 24));
    const targetBounds = {x: area.x + 20, y: area.y + 20, width, height};
    const needsMove = Math.abs(bounds.left - targetBounds.x) > 10 || Math.abs(bounds.top - targetBounds.y) > 10;
    const needsResize = bounds.width !== width || bounds.height !== height || !display;
    if (needsMove || needsResize || bounds.left < area.x || bounds.top < area.y || bounds.right > area.x + area.width || bounds.bottom > area.y + area.height) {
      mainWindow.setBounds(targetBounds);
      log(`window-repositioned bounds=${JSON.stringify(mainWindow.getBounds())}`);
    }
  } catch (error) { log(`window-position-check-error ${error.message || error}`); }
  return true;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  ensureWindowOnScreen();
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  app.focus({steal: true});
  mainWindow.setSkipTaskbar(false);
  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.moveTop();
  mainWindow.focus();
  setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false); }, 1500);
  const bounds = mainWindow.getBounds();
  log(`window-shown visible=${mainWindow.isVisible()} minimized=${mainWindow.isMinimized()} bounds=${JSON.stringify(bounds)}`);
  return true;
}
app.on("second-instance", () => { log("second-instance"); showMainWindow(); });

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: "豆包视频工作台",
    show: true,
    center: true,
    icon: path.join(__dirname, "..", "assets", "doubao-manager.png"),
    backgroundColor: "#0b1020",
    webPreferences: {preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false},
  });
  log(`window-created bounds=${JSON.stringify(mainWindow.getBounds())}`);
  const indexFile = path.join(__dirname, "index.html");
  let loadAttempts = 0;
  const loadIndex = () => {
    loadAttempts += 1;
    mainWindow.loadFile(indexFile).catch(error => log(`window-load-error attempt=${loadAttempts} ${error.stack || error}`));
  };
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    log(`window-did-fail-load code=${errorCode} description=${errorDescription} url=${validatedURL} mainFrame=${isMainFrame}`);
    if (isMainFrame && loadAttempts < 3 && !mainWindow.isDestroyed()) setTimeout(loadIndex, 500);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => log(`renderer-gone reason=${details.reason} exitCode=${details.exitCode}`));
  mainWindow.webContents.on("unresponsive", () => log("renderer-unresponsive"));
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => log(`renderer-console level=${level} line=${line} source=${sourceId} message=${message}`));
  loadIndex();
  mainWindow.webContents.once("did-finish-load", () => { log("window-did-finish-load"); log(`graphics-features ${JSON.stringify(app.getGPUFeatureStatus())}`); showMainWindow(); });
  mainWindow.once("ready-to-show", () => { showMainWindow(); log("window-ready"); });
  mainWindow.on("show", () => log("window-show-event"));
  mainWindow.on("hide", () => log("window-hide-event"));
  // 关闭主窗口必须结束桌面宿主和 API 子进程，避免用户关闭后仍锁定
  // 安装目录，导致 Windows 无法删除或卸载。需要后台运行时使用界面中的
  // “隐藏窗口”按钮，它不会触发 close 事件。
  mainWindow.on("close", () => { quitting = true; log("window-close-requested"); });
  mainWindow.on("closed", () => { mainWindow = null; app.quit(); });
}

function respondWorker(message, value, error) {
  if (!serviceProcess || !serviceProcess.connected) return;
  serviceProcess.send({type: "doubao-worker-response", id: message.id, ok: !error, ...(error ? {error: {
    code: String(error.code || "DOUBAO_WORKER_HOST_FAILED"),
    message: String(error.message || error),
    ...Object.fromEntries(["category", "retryMode", "userAction", "providerMessage", "providerMessageRaw", "accountAction", "safeToRetry", "notSentVerified", "submittedVerified", "submissionUnknown", "terminalFailureVerified", "quotaExhausted", "quotaConsumed", "providerTerminal", "verificationRequired", "monitorDiagnostic", "conversationId", "userMessageId", "submittedAt", "submittedEvidence"].filter(key => error[key] !== undefined).map(key => [key, error[key]])),
  }} : {value})});
}
async function handleWorkerRequest(message) {
  if (message && message.type === "doubao-worker-progress-ack") {
    const pending = pendingProgress.get(String(message.id || ""));
    if (!pending) return;
    pendingProgress.delete(String(message.id || ""));
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve();
    else pending.reject(new Error(String(message.error?.message || "任务进度持久化失败")));
    return;
  }
  if (!message || message.type !== "doubao-worker-request") return;
  const method = String(message.method || "");
  log(`worker-request id=${String(message.id || "")} method=${method}`);
  try {
    if (!hostWorker || typeof hostWorker[method] !== "function") throw new Error(`不支持的豆包宿主方法：${method}`);
    const value = await hostWorker[method](...(Array.isArray(message.args) ? message.args : []));
    log(`worker-response id=${String(message.id || "")} method=${method} ok=true`);
    respondWorker(message, value);
  } catch (error) {
    const diagnostic = error?.monitorDiagnostic ? ` diagnostic=${JSON.stringify(error.monitorDiagnostic).slice(0, 5000)}` : "";
    log(`worker-response id=${String(message.id || "")} method=${method} ok=false code=${String(error?.code || "")} message=${String(error?.message || error)}${diagnostic}`);
    respondWorker(message, null, error);
  }
}

function sendWorkerProgress(progress) {
  if (!serviceProcess?.connected) return Promise.reject(new Error("API 服务连接已断开，无法持久化豆包任务会话"));
  const id = `progress-${process.pid}-${++progressSequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingProgress.delete(id); reject(new Error("豆包任务会话持久化超时")); }, 10_000);
    pendingProgress.set(id, {resolve, reject, timer});
    serviceProcess.send({type: "doubao-worker-progress", id, progress}, error => {
      if (!error) return;
      clearTimeout(timer); pendingProgress.delete(id); reject(error);
    });
  });
}
async function waitServiceReady(port = 8787, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const response = await fetch(`http://127.0.0.1:${port}/health`, {signal: AbortSignal.timeout(Math.min(1000, Math.max(1, deadline - Date.now())))}); if (response.ok) return await response.json(); } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("独立 API 服务启动超时");
}

async function startInProcessService(serviceFile) {
  process.env.DOUBAO_WORKER_RPC = "0";
  // The fallback runs the HTTP server in Electron's main process. Reuse the
  // existing host worker so account sessions still use the embedded browser.
  globalThis.__doubaoInProcessWorker = hostWorker;
  let serviceModule;
  try {
    serviceModule = require(serviceFile);
  } finally {
    delete globalThis.__doubaoInProcessWorker;
  }
  inProcessServer = serviceModule.server;
  const recovery=serviceModule.initializeRecovery();
  if (!inProcessServer.listening) {
    await new Promise((resolve, reject) => {
      const onError = error => { inProcessServer.off("listening", onListening); reject(error); };
      const onListening = () => { inProcessServer.off("error", onError); resolve(); };
      inProcessServer.once("error", onError);
      inProcessServer.once("listening", onListening);
      inProcessServer.listen(8787, "127.0.0.1");
    });
  }
  log(`service-fallback-ready mode=in-process recovered=${recovery.recovered} scheduled=${recovery.scheduled}`);
}

async function startService() {
  process.env.DOUBAO_SERVICE_HOST = "127.0.0.1";
  const preferredRoot = path.join(process.env.LOCALAPPDATA || app.getPath("userData"), "DoubaoVideoManager");
  const fallbackRoot = app.getPath("userData");
  runtimeRoot = preferredRoot;
  writeBuiltInMcpConfig();
  try { fs.mkdirSync(path.join(runtimeRoot, "data"), {recursive: true}); } catch { runtimeRoot = fallbackRoot; fs.mkdirSync(path.join(runtimeRoot, "data"), {recursive: true}); }
  const dataRoot = path.join(runtimeRoot, "data");
  // Reuse provider scripts/assets across launches. Cache cleanup is a repair
  // option, not part of every normal startup; account storage is preserved.
  if (process.env.DOUBAO_CLEAR_BROWSER_CACHE_ON_START === "1") {
    try { cleanupBrowserCaches(path.join(runtimeRoot, "electron-user-data")); } catch {}
    try { cleanupBrowserCaches(path.join(dataRoot, "profiles")); } catch {}
  }
  const configRoot = path.join(runtimeRoot, "config");
  remoteConnectorConfigRoot = configRoot;
  fs.mkdirSync(configRoot, {recursive: true});
  try {
    const network = JSON.parse(fs.readFileSync(path.join(configRoot, "network.json"), "utf8"));
    process.env.DOUBAO_LAN_ADDRESS = String(network.lanAddress || "").trim();
  } catch (error) { if (error.code !== "ENOENT") log(`network-config-error ${error.message}`); }
  const packagedAccounts = path.join(__dirname, "..", "config", "accounts.json");
  const accountsFile = path.join(configRoot, "accounts.json");
  if (!fs.existsSync(accountsFile) && fs.existsSync(packagedAccounts)) fs.copyFileSync(packagedAccounts, accountsFile);
  process.env.DOUBAO_DATA_ROOT = dataRoot;
  process.env.DOUBAO_PROFILE_ROOT = path.join(dataRoot, "profiles");
  process.env.DOUBAO_TEMP_ROOT = path.join(dataRoot, "temp");
  process.env.DOUBAO_ACCOUNTS_FILE = accountsFile;
  if (!embeddedBrowser) {
    embeddedBrowser = new EmbeddedBrowserManager({
      mainWindow,
      dataRootProvider: () => dataRoot,
    });
    globalThis.__doubaoEmbeddedBrowserManager = embeddedBrowser;
  }
  hostWorker = new DoubaoWorker({profileRoot: path.join(dataRoot, "profiles"), tempRoot: path.join(dataRoot, "temp"), embeddedBrowserProvider: () => embeddedBrowser, onProgress: sendWorkerProgress});
  const serviceFile = path.join(__dirname, "..", "src", "server.cjs");
  // 使用应用自带的 Electron 可执行文件作为 Node 子进程运行 API 服务，
  // 部署到新电脑时无需另外安装 Node.js。
  const serviceEnvironment = {...process.env, ELECTRON_RUN_AS_NODE: "1", DOUBAO_WORKER_RPC: "1", DOUBAO_SERVICE_PORT: "8787", DOUBAO_SERVICE_HOST: "127.0.0.1", DOUBAO_DATA_ROOT: dataRoot, DOUBAO_PROFILE_ROOT: path.join(dataRoot, "profiles"), DOUBAO_TEMP_ROOT: path.join(dataRoot, "temp"), DOUBAO_ACCOUNTS_FILE: accountsFile};
  serviceProcess = fork(serviceFile, [], {cwd: path.join(__dirname, ".."), execPath: process.execPath, env: serviceEnvironment, stdio: ["ignore", "pipe", "pipe", "ipc"]});
  log(`service-spawn pid=${serviceProcess.pid} exec=${process.execPath} embedded-node=true`);
  serviceProcess.stdout?.on("data", chunk => log(`service ${String(chunk).trim()}`));
  serviceProcess.stderr?.on("data", chunk => log(`service-error ${String(chunk).trim()}`));
  serviceProcess.on("message", handleWorkerRequest);
  serviceProcess.once("exit", (code, signal) => { log(`service-exit code=${code ?? ""} signal=${signal || ""}`); if (!quitting) serviceProcess = null; });
  const spawnFailure = new Promise((_, reject) => serviceProcess.once("error", reject));
  try {
    await Promise.race([waitServiceReady(), spawnFailure]);
  } catch (error) {
    log(`service-child-unavailable ${error.stack || error}`);
    try { serviceProcess?.kill(); } catch {}
    serviceProcess = null;
    await startInProcessService(serviceFile);
    await waitServiceReady(8787, 5000);
  }
  startRemoteConnector(configRoot);
}

function startRemoteConnector(configRoot) {
  if (remoteConnector) return;
  let config = {};
  const configFile = path.join(configRoot, "remote-connector.json");
  try { config = JSON.parse(fs.readFileSync(configFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") log(`remote-connector-config-error ${error.message || error}`); }
  const server = String(process.env.DOUBAO_REMOTE_SERVER || config.server || "").trim();
  const token = String(process.env.DOUBAO_REMOTE_TOKEN || config.token || "").trim();
  if (config.enabled === false || !server || !token) return;
  try {
    remoteConnector = new RemoteConnector({
      server,
      token,
      localOrigin: String(process.env.DOUBAO_REMOTE_LOCAL_ORIGIN || config.localOrigin || "http://127.0.0.1:8787"),
    }, {log: message => log(message)});
    void remoteConnector.start();
    log(`remote-connector-configured server=${server}`);
  } catch (error) {
    log(`remote-connector-start-error ${error.message || error}`);
  }
}

function readRemoteConnectorConfig() {
  const configRoot = remoteConnectorConfigRoot || path.join(runtimeRoot || path.join(process.env.LOCALAPPDATA || app.getPath("userData"), "DoubaoVideoManager"), "config");
  const configFile = path.join(configRoot, "remote-connector.json");
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configFile, "utf8")); } catch (error) { if (error.code !== "ENOENT") log(`remote-connector-config-error ${error.message || error}`); }
  return {configRoot, configFile, config};
}

function remoteConnectorState() {
  const {config} = readRemoteConnectorConfig();
  const configured = Boolean(String(config.server || "").trim() && String(config.token || "").trim() && config.enabled !== false);
  const lastPollAt = Number(remoteConnector?.lastPollAt || 0);
  const connected = configured && Boolean(remoteConnector) && !remoteConnector.stopped && (remoteConnector.enabled === true || Date.now() - lastPollAt < 120_000);
  const error = String(remoteConnector?.lastError || "");
  return {
    configured,
    connected,
    enabled: config.enabled !== false,
    server: String(config.server || ""),
    token: String(config.token || ""),
    state: !configured ? "未配置" : connected ? "已连接" : error || "连接中",
    error,
  };
}

ipcMain.handle("remote-connector:get", () => remoteConnectorState());
ipcMain.handle("remote-connector:save", (_event, input = {}) => {
  const {configRoot, configFile} = readRemoteConnectorConfig();
  const profile = validateProfile({
    server: input.server,
    token: input.token,
    localOrigin: input.localOrigin || "http://127.0.0.1:8787",
  });
  const config = {enabled: true, server: profile.server, token: profile.token, localOrigin: profile.localOrigin};
  fs.mkdirSync(configRoot, {recursive: true});
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", "utf8");
  try { remoteConnector?.stop(); } catch {}
  remoteConnector = null;
  startRemoteConnector(configRoot);
  log(`remote-connector-configured server=${profile.server} source=ui`);
  return remoteConnectorState();
});

ipcMain.handle("service:open-folder", () => shell.openPath(path.join(__dirname, "..")));
ipcMain.handle("service:open-logs", () => shell.openPath(runtimeRoot || path.join(__dirname, "..")));
async function desktopLicense(force = false) {
  try {
    // Keep the renderer's loading screen until the local API (including its
    // fallback) is ready; a cold start is not an authorization failure.
    if (serviceStartup) await serviceStartup;
    const response = await fetch("http://127.0.0.1:8787/api/v1/license/status" + (force ? "?refresh=1" : ""), {signal: AbortSignal.timeout(22000)});
    if (!response.ok) throw new Error("unavailable");
    const state = await response.json();
    await embeddedBrowser?.setLicenseValid(state.valid === true);
    return state;
  } catch {
    await embeddedBrowser?.setLicenseValid(false);
    return {valid: false, code: "DOUBAO_LICENSE_SERVICE_UNAVAILABLE", message: "授权服务未连接，请稍后重试"};
  }
}
ipcMain.handle("license:status", (_event, force) => desktopLicense(force === true));
ipcMain.handle("license:secret", async () => {
  const state = await desktopLicense();
  if (!state.valid) return "";
  return getStoredLicenseSecret(path.join(runtimeRoot || path.join(__dirname, ".."), "data", "online-license.json"));
});
ipcMain.handle("license:show", () => { embeddedBrowser?.hideActive(); return {ok: true}; });
ipcMain.handle("browser:action", async (_event, action) => {
  const license = await desktopLicense();
  if (!license.valid) return {ok: false, message: license.message};
  if (action === "open" || action === "focus") return embeddedBrowser?.showActive() || {ok: false, message: "浏览器尚未就绪"};
  if (action === "hide") return embeddedBrowser?.hideActive() || {ok: false, message: "浏览器尚未就绪"};
  return {ok: false, message: "不支持的浏览器操作"};
});

app.whenReady().then(async () => {
  log("app-ready");
  try { createWindow(); } catch (error) { console.error("窗口创建失败", error); log(`window-error ${error.stack || error}`); }
  embeddedBrowser?.setMainWindow(mainWindow);
  serviceStartup = startService();
  try { await serviceStartup; log("service-ready"); } catch (error) { console.error("服务启动失败", error); log(`service-error ${error.stack || error}`); }
  finally { serviceStartup = null; } // Later status checks can recover after a startup failure.
  let checkingLicense = false;
  const licenseTimer = setInterval(async () => {
    if (checkingLicense || quitting) return;
    checkingLicense = true;
    try { await desktopLicense(); } finally { checkingLicense = false; }
  }, 5000);
  licenseTimer.unref();
});
app.on("activate", () => { showMainWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { quitting = true; try { remoteConnector?.stop(); } catch {} try { serviceProcess?.kill(); } catch {} try { inProcessServer?.close(); } catch {} try { hostWorker?.close(); } catch {} try { embeddedBrowser?.dispose(); } catch {} });

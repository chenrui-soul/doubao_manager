"use strict";

const crypto = require("node:crypto");

const DEFAULT_LOCAL_ORIGIN = "http://127.0.0.1:8787";
const MAX_REQUEST_BYTES = 48 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// The website's poll endpoint is long-polling. Keep this above the server's
// normal idle window so a healthy connector is not marked offline mid-poll.
const REQUEST_TIMEOUT_MS = 90_000;
const JOB_TIMEOUT_MS = 120_000;

function allowed(method, route) {
  return (method === "GET" && (route === "/health" || /^\/api\/v1\/video\/jobs\/[A-Za-z0-9_-]{1,160}$/.test(route)))
    || (method === "POST" && route === "/api/v1/video/generate");
}

function isPrivateIPv4(hostname) {
  const parts = String(hostname || "").split(".");
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [first, second] = parts.map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function decodeCredential(value) {
  const raw = String(value || "").trim();
  const prefix = "doubao-local-v1.";
  if (!raw.startsWith(prefix)) return null;
  const encoded = raw.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("远程连接凭证格式无效");
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("远程连接凭证格式无效");
  }
  if (payload?.version !== 1 || typeof payload.server !== "string" || typeof payload.token !== "string") {
    throw new Error("远程连接凭证格式无效");
  }
  return {server: payload.server, token: payload.token};
}

function validateProfile(profile) {
  const credential = decodeCredential(profile.token);
  const suppliedServer = String(profile.server || "").trim();
  if (credential && suppliedServer && new URL(suppliedServer).origin !== new URL(credential.server).origin) {
    throw new Error("连接凭证与服务器地址不一致");
  }
  const site = new URL(credential?.server || suppliedServer);
  const loopbackHttp = site.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(site.hostname);
  const privateHttp = site.protocol === "http:" && isPrivateIPv4(site.hostname);
  if ((site.protocol !== "https:" && !loopbackHttp && !privateHttp) || site.username || site.password || site.pathname !== "/" || site.search || site.hash) {
    throw new Error("远程连接地址必须使用 HTTPS；HTTP 仅支持 localhost 或 10.x、172.16-31.x、192.168.x 内网地址");
  }
  const local = new URL(String(profile.localOrigin || DEFAULT_LOCAL_ORIGIN));
  if (!["127.0.0.1", "localhost", "[::1]"].includes(local.hostname) || !["http:", "https:"].includes(local.protocol)
    || local.username || local.password || local.pathname !== "/" || local.search || local.hash) {
    throw new Error("本地连接地址必须是 localhost 或 127.0.0.1");
  }
  const token = String(credential?.token || profile.token || "").trim();
  if (!token) throw new Error("远程连接令牌不能为空");
  return {server: site.origin, token, localOrigin: local.origin};
}

async function readResponseBody(response, maxBytes = MAX_RESPONSE_BYTES) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body || []) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("豆包响应超过大小限制");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function executeJob(profile, job, permitted, signal, fetchImpl = fetch) {
  const method = String(job?.method || "").toUpperCase();
  const route = String(job?.path || "");
  if (!allowed(method, route)) throw new Error("拒绝访问豆包视频之外的接口");

  const body = Buffer.from(String(job?.body || ""), "base64");
  if (body.length > MAX_REQUEST_BYTES) throw new Error("参考素材过大");
  if (!await permitted()) throw new Error("本地访问已关闭或任务已撤回");

  const response = await fetchImpl(profile.localOrigin + route, {
    method,
    redirect: "error",
    signal,
    headers: method === "POST" ? {"content-type": String(job.contentType || "application/json")} : undefined,
    body: method === "POST" ? body : undefined,
  });
  return {status: response.status, body: await readResponseBody(response)};
}

class RemoteConnector {
  constructor(profile, options = {}) {
    this.profile = validateProfile(profile);
    this.fetchImpl = options.fetchImpl || fetch;
    this.log = typeof options.log === "function" ? options.log : (() => {});
    this.retryDelayMs = Math.max(1000, Number(options.retryDelayMs || 5000));
    this.clientId = crypto.randomUUID();
    this.active = new Map();
    this.stopped = true;
    this.enabled = false;
    this.managerOnline = false;
    this.lastHealth = 0;
    this.lastPollAt = 0;
    this.lastError = "";
    this.loopPromise = null;
    this.loopController = null;
  }

  start() {
    if (!this.stopped) return this.loopPromise;
    this.stopped = false;
    this.loopController = new AbortController();
    this.loopPromise = this.loop(this.loopController.signal);
    return this.loopPromise;
  }

  stop() {
    this.stopped = true;
    this.loopController?.abort();
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
  }

  async api(route, body = {}, signal) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await this.fetchImpl(this.profile.server + "/api/local-doubao" + route, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${this.profile.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({...body, clientId: this.clientId}),
      signal: requestSignal,
    });
    if (response.status === 401) throw Object.assign(new Error("远程连接令牌已失效"), {fatal: true});
    // The website keeps a connector lease for about 45 seconds after an
    // unexpected process exit. Treat that lease collision as recoverable.
    if (response.status === 409) throw Object.assign(new Error("该配置已有其他连接正在运行"), {conflict: true, retryAfterMs: 50_000});
    if (!response.ok) throw new Error(`远程连接响应 ${response.status}`);
    return response.json();
  }

  async runJob(job) {
    const controller = new AbortController();
    this.active.set(String(job.id), controller);
    const timer = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS);
    try {
      const result = await executeJob(this.profile, job, async () => {
        const permission = await this.api(`/check/${encodeURIComponent(String(job.id))}`);
        return permission.allowed === true;
      }, controller.signal, this.fetchImpl);
      await this.api(`/result/${encodeURIComponent(String(job.id))}`, result);
    } catch (error) {
      const message = error?.name === "AbortError" ? "本地访问已关闭或请求超时" : String(error?.message || error);
      try { await this.api(`/result/${encodeURIComponent(String(job.id))}`, {error: message}); } catch {}
      this.log(`remote-job-failed id=${String(job.id)} message=${message}`);
    } finally {
      clearTimeout(timer);
      this.active.delete(String(job.id));
    }
  }

  async loop(signal) {
    this.log("remote-connector-started");
    while (!this.stopped) {
      try {
        const response = await this.api("/poll", {managerOnline: this.managerOnline}, signal);
        this.lastPollAt = Date.now();
        this.lastError = "";
        const nextEnabled = response.enabled === true;
        if (nextEnabled !== this.enabled) this.log(`remote-access-${nextEnabled ? "enabled" : "disabled"}`);
        this.enabled = nextEnabled;
        if (!this.enabled) {
          this.managerOnline = false;
          for (const controller of this.active.values()) controller.abort();
        }
        if (response.job) void this.runJob(response.job);

        if (this.enabled && Date.now() - this.lastHealth > 15_000) {
          const permission = await this.api("/permission");
          if (permission.enabled === true) {
            try {
              const health = await this.fetchImpl(this.profile.localOrigin + "/health", {redirect: "error", signal: AbortSignal.timeout(3000)});
              this.managerOnline = health.ok;
              await health.body?.cancel?.();
            } catch { this.managerOnline = false; }
          } else this.managerOnline = false;
          this.lastHealth = Date.now();
        }
      } catch (error) {
        if (this.stopped || signal?.aborted) break;
        if (error?.fatal) {
          this.lastError = error.message;
          this.log(`remote-connector-stopped reason=${error.message}`);
          this.stop();
          break;
        }
        const delayMs = error?.conflict ? Math.max(this.retryDelayMs, Number(error.retryAfterMs) || 50_000) : this.retryDelayMs;
        this.log(`remote-connector-retry reason=${String(error?.message || error)} delayMs=${delayMs}`);
        await new Promise(resolve => {
          const timer = setTimeout(resolve, delayMs);
          if (signal) signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, {once: true});
        });
      }
    }
    this.loopPromise = null;
    this.loopController = null;
  }
}

module.exports = {RemoteConnector, allowed, executeJob, validateProfile, isPrivateIPv4, decodeCredential};

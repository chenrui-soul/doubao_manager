"use strict";

// API 服务子进程中的 Worker 代理。真正的豆包浏览器自动化仍由 Electron
// 宿主执行，这样服务与界面解耦，同时保留内嵌 WebContentsView。
class RpcWorker {
  constructor({requestTimeoutMs = 0} = {}) {
    this.requestTimeoutMs = requestTimeoutMs;
    this.sequence = 0;
    this.pending = new Map();
    this.connected = typeof process.send === "function";
    this.progressHandler = null;
    if (this.connected) process.on("message", message => this.onMessage(message));
    process.once("disconnect", () => {
      for (const [id, pending] of this.pending) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(Object.assign(new Error("豆包浏览器宿主连接已断开"), {code: "DOUBAO_BROWSER_HOST_DISCONNECTED"}));
        this.pending.delete(id);
      }
      this.connected = false;
    });
  }
  onMessage(message) {
    if (message && message.type === "doubao-worker-progress") {
      Promise.resolve(this.progressHandler?.(message.progress || {})).then(
        () => process.send?.({type: "doubao-worker-progress-ack", id: message.id, ok: true}),
        error => process.send?.({type: "doubao-worker-progress-ack", id: message.id, ok: false, error: {message: String(error?.message || error)}}),
      );
      return;
    }
    if (!message || message.type !== "doubao-worker-response") return;
    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    this.pending.delete(String(message.id));
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(Object.assign(new Error(String(message.error?.message || "豆包自动化宿主调用失败")), message.error || {}));
  }
  setProgressHandler(handler) { this.progressHandler = typeof handler === "function" ? handler : null; }
  call(method, args) {
    if (!this.connected || !process.connected) return Promise.reject(Object.assign(new Error("豆包浏览器宿主未连接，请保持桌面程序运行"), {code: "DOUBAO_BROWSER_HOST_DISCONNECTED"}));
    const id = `rpc-${process.pid}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = this.requestTimeoutMs > 0 ? setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error(`豆包自动化宿主调用超时：${method}`), {code: "DOUBAO_BROWSER_HOST_TIMEOUT"})); }, this.requestTimeoutMs) : null;
      this.pending.set(id, {resolve, reject, timer});
      try { process.send({type: "doubao-worker-request", id, method, args}, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  open(account) { return this.call("open", [account]); }
  checkGeneration(account) { return this.call("checkGeneration", [account]); }
  openTask(job) { return this.call("openTask", [job]); }
  takeoverTask(job) { return this.call("takeoverTask", [job]); }
  freezeTakeover(job) { return this.call("freezeTakeover", [job]); }
  inspectTask(job) { return this.call("inspectTask", [job]); }
  recoverTaskResult(job, candidate) { return this.call("recoverTaskResult", [job, candidate]); }
  retryWatermarkFree(job) { return this.call("retryWatermarkFree", [job]); }
  detect(account, options = {}) { return this.call("detect", [account, options]); }
  generate(job) { return this.call("generate", [job]); }
  rehearseBrowsers(accounts, payload) { return this.call("rehearseBrowsers", [accounts, payload]); }
  refreshUrls(job) { return this.call("refreshUrls", [job]); }
  close() {}
}

module.exports = {RpcWorker};

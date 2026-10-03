"use strict";

const fs = require("fs");
const path = require("path");
const {spawn} = require("child_process");

function safeFileId(value) {
  return String(value || "video").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 100) || "video";
}

function run(executable, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
    const stderr = [];
    child.stderr.on("data", chunk => stderr.push(chunk));
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error("视频处理超时")); }, timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(Buffer.concat(stderr).toString("utf8").slice(-1000) || `视频处理退出码 ${code}`));
    });
  });
}

function findTool(name) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const candidates = [
    process.env[`LINGFRAME_${name.toUpperCase()}_EXE`],
    path.join(process.cwd(), `${name}${suffix}`),
    path.join(process.cwd(), "tools", `${name}${suffix}`),
    name,
  ].filter(Boolean);
  return candidates[0];
}

class VideoDownloader {
  constructor({rootProvider, minBytes = 64 * 1024, maxBytes = 1024 * 1024 * 1024, timeoutMs = 10 * 60 * 1000, testMode = false, retainFile = false} = {}) {
    this.rootProvider = rootProvider;
    this.minBytes = minBytes;
    this.maxBytes = maxBytes;
    this.timeoutMs = timeoutMs;
    this.testMode = testMode;
    this.retainFile = retainFile === true;
  }
  root() {
    const value = this.rootProvider && this.rootProvider();
    if (!value) throw new Error("授权未生效，无法确定租户下载目录");
    fs.mkdirSync(value, {recursive: true});
    return value;
  }
  async download(resource, {jobId, cookie = ""} = {}) {
    const url = String(resource?.url || "");
    const target = path.join(this.root(), `${safeFileId(jobId)}.mp4`);
    const temporary = `${target}.${process.pid}.part`;
    if (this.testMode || url.startsWith("mock://")) {
      fs.writeFileSync(temporary, Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from("ftypisom0000isommp41"), Buffer.alloc(65536)]));
      fs.renameSync(temporary, target);
      const downloadAudit = this.verify(target, "mock");
      if (!this.retainFile) { try { fs.unlinkSync(target); } catch {} }
      return {...(this.retainFile ? {resultPath: target} : {}), downloadAudit};
    }
    if (!/^https?:\/\//i.test(url)) throw new Error("视频资源不是 HTTP(S) 地址");
    let diagnostic = null;
    try {
      if (/\.m3u8(?:\?|$)/i.test(url) || /mpegurl/i.test(String(resource?.mimeType || ""))) {
        const headers = cookie ? `Cookie: ${cookie}\r\nReferer: https://www.doubao.com/\r\n` : "Referer: https://www.doubao.com/\r\n";
        await run(findTool("ffmpeg"), ["-y", "-headers", headers, "-i", url, "-c", "copy", temporary], this.timeoutMs);
      } else {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
        const response = await fetch(url, {headers: {...(cookie ? {cookie} : {}), referer: "https://www.doubao.com/", accept: "video/*,application/octet-stream;q=0.9,*/*;q=0.5"}, signal: controller.signal, redirect: "follow"});
          if (!response.ok) throw new Error(`视频下载返回 ${response.status}`);
          const type = String(response.headers.get("content-type") || "");
          const finalUrl = String(response.url || url);
          const buffer = Buffer.from(await response.arrayBuffer());
          diagnostic = {requestedUrl:url, finalUrl, status:response.status, contentType:type, contentLength:response.headers.get("content-length") || "", bytes:buffer.length, headHex:buffer.subarray(0,128).toString("hex"), headText:buffer.subarray(0,128).toString("latin1").replace(/[\u0000-\u001f\u007f]/g,".")};
          if (/application\/json|text\/html|image\//i.test(type)) throw new Error(`视频地址返回了非视频内容：${type}${finalUrl!==url?`（最终地址：${finalUrl}）`:""}`);
          if (buffer.length > this.maxBytes) throw new Error("视频文件超过允许大小");
          fs.writeFileSync(temporary, buffer);
        } finally { clearTimeout(timer); }
      }
      const audit = this.verify(temporary, "magic");
      if (fs.existsSync(target)) fs.unlinkSync(target);
      fs.renameSync(temporary, target);
      if (!this.retainFile) { try { fs.unlinkSync(target); } catch {} }
      return {...(this.retainFile ? {resultPath: target} : {}), downloadAudit: audit};
    } catch (error) {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
      if (diagnostic) {
        error.downloadDiagnostic = diagnostic;
      }
      throw error;
    }
  }
  verify(file, method = "magic") {
    const stat = fs.statSync(file);
    if (stat.size < this.minBytes) throw new Error(`视频文件过小：${stat.size} 字节`);
    if (stat.size > this.maxBytes) throw new Error(`视频文件过大：${stat.size} 字节`);
    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(64);
    const size = fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    const sample = head.subarray(0, size).toString("latin1");
    if (!sample.includes("ftyp") && !sample.includes("moov") && !sample.includes("mdat")) throw new Error("下载文件头不是有效 MP4");
    return {verified: true, method, bytes: stat.size};
  }
}

module.exports = {VideoDownloader, safeFileId};

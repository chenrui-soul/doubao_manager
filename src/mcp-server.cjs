"use strict";

// Minimal MCP 2025-03-26 stdio server. It deliberately delegates all video
// work to the already-tested local HTTP service; MCP is only an adapter.
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");

const API = process.env.DOUBAO_API_URL || "http://127.0.0.1:8787";
const PROTOCOL_VERSION = "2025-03-26";
const tools = [
  {name: "doubao_health", description: "检查豆包视频服务、账号和队列状态", inputSchema: {type: "object", properties: {}, additionalProperties: false}},
  {name: "doubao_list_accounts", description: "列出豆包账号及登录状态", inputSchema: {type: "object", properties: {}, additionalProperties: false}},
  {name: "doubao_generate_video", description: "使用指定账号、提示词和本地参考图片生成视频；返回任务编号，必要时可等待完成", inputSchema: {type: "object", required: ["prompt"], properties: {
    prompt: {type: "string", description: "视频生成提示词"}, model: {type: "string", enum: ["Seedance 2.0 Mini", "Seedance 2.0 Fast"]}, ratio: {type: "string", enum: ["自动", "3:4", "4:3", "9:16", "16:9", "1:1", "21:9"]}, duration: {type: "integer", minimum: 4, maximum: 15}, accountId: {type: "string", description: "固定账号，例如 account-001"}, files: {type: "array", items: {type: "string"}, description: "本地图片绝对路径，最多10张"}, wait: {type: "boolean", description: "是否等待任务终态"}, waitTimeoutMs: {type: "integer", minimum: 1000}
  }, additionalProperties: false}},
  {name: "doubao_get_job", description: "查询视频任务状态和视频地址", inputSchema: {type: "object", required: ["requestId"], properties: {requestId: {type: "string"}}, additionalProperties: false}},
  {name: "doubao_wait_job", description: "异步等待任务完成；默认约每2秒检查一次，客户端超时不会重新提交任务", inputSchema: {type: "object", required: ["requestId"], properties: {requestId: {type: "string"}, timeoutMs: {type: "integer", minimum: 1000, maximum: 1800000}, intervalMs: {type: "integer", minimum: 1000, maximum: 60000}}, additionalProperties: false}},
  {name: "doubao_resume_job", description: "恢复人工验证或已有提交证据的任务", inputSchema: {type: "object", required: ["requestId"], properties: {requestId: {type: "string"}}, additionalProperties: false}},
  {name: "doubao_recover_existing_result", description: "仅补取已经提交的原视频任务；锁定原账号和原会话，不重新发送提示词", inputSchema: {type: "object", required: ["requestId"], properties: {requestId: {type: "string"}}, additionalProperties: false}},
  {name: "doubao_refresh_url", description: "刷新已完成视频的过期地址", inputSchema: {type: "object", required: ["requestId"], properties: {requestId: {type: "string"}}, additionalProperties: false}},
];

function reply(id, result) { process.stdout.write(JSON.stringify({jsonrpc: "2.0", id, result}) + "\n"); }
function fail(id, code, message) { reply(id, {isError: true, content: [{type: "text", text: message}], _meta: {code}}); }
function result(value) { return {content: [{type: "text", text: JSON.stringify(value, null, 2)}], structuredContent: value}; }
async function request(route, options = {}) {
  const response = await fetch(API + route, {...options, signal: AbortSignal.timeout(Number(process.env.DOUBAO_MCP_TIMEOUT_MS || 30 * 60 * 1000))});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body?.error?.message || body?.error || `HTTP ${response.status}`), {status: response.status, body});
  return body;
}
async function probeVideoUrl(value) {
  const url = String(value || "").trim();
  if (!/^https?:\/\//i.test(url)) return {skipped: true, ok: true};
  try {
    const response = await fetch(url, {
      method: "HEAD",
      headers: {referer: "https://www.doubao.com/", "user-agent": "Mozilla/5.0", accept: "video/*,application/octet-stream;q=0.9,*/*;q=0.5"},
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    return {ok: response.ok, status: response.status, refresh: [401, 403, 404, 410].includes(response.status)};
  } catch (error) {
    // 网络抖动不应触发重新解析，避免把一次临时失败误判成地址过期。
    return {ok: false, refresh: false, error: String(error?.message || error)};
  }
}
async function refreshCompletedJobIfNeeded(job, requestId) {
  if (!job || String(job.state || "") !== "completed") return job;
  const candidates = [job.watermarkFreeUrl, job.watermarkedUrl].filter(Boolean);
  if (!candidates.length) return job;
  for (const candidate of candidates) {
    const probe = await probeVideoUrl(candidate);
    if (probe.refresh) {
      try {
        return await request(`/api/v1/video/jobs/${encodeURIComponent(requestId)}/refresh-url`, {method: "POST"});
      } catch (error) {
        return {...job, urlRefreshAttempted: true, urlRefreshError: String(error?.message || error)};
      }
    }
    // A live primary address is enough; do not probe the fallback unnecessarily.
    if (probe.ok) return job;
  }
  return job;
}
function assertFile(file) {
  const value = path.resolve(String(file || ""));
  if (!fs.existsSync(value) || !fs.statSync(value).isFile()) throw new Error(`参考图片不存在：${file}`);
  const ext = path.extname(value).toLowerCase();
  if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext)) throw new Error(`不支持的参考图片格式：${file}`);
  return value;
}
async function callTool(name, args = {}) {
  if (name === "doubao_health") return request("/health");
  if (name === "doubao_list_accounts") return request("/api/v1/accounts");
  const id = String(args.requestId || "").trim();
  if (name === "doubao_get_job") { if (!id) throw new Error("requestId 不能为空"); const job = await request(`/api/v1/video/jobs/${encodeURIComponent(id)}`); return refreshCompletedJobIfNeeded(job, id); }
  if (name === "doubao_wait_job") {
    if (!id) throw new Error("requestId 不能为空");
    const timeout = Math.min(1800000, Math.max(1000, Number(args.timeoutMs || 900000)));
    const requestedInterval = Number(args.intervalMs || 0);
    const interval = requestedInterval > 0 ? Math.min(60000, Math.max(1000, requestedInterval)) : 2000;
    const deadline = Date.now() + timeout;
    let job;
    do {
      job = await request(`/api/v1/video/jobs/${encodeURIComponent(id)}`);
      if (["completed", "failed", "error", "cancelled"].includes(String(job.state))) return refreshCompletedJobIfNeeded(job, id);
      // Keep the first part of a job responsive, then reduce local polling
      // traffic while the provider renders. An explicit interval always wins.
      const delay = requestedInterval > 0 ? interval : (job?.state === "generating" ? 5000 : interval);
      if (Date.now() + delay > deadline) break;
      await new Promise(resolve => setTimeout(resolve, delay));
    } while (Date.now() < deadline);
    return {requestId: id, state: String(job?.state || "unknown"), timedOut: true, message: "客户端等待超时，任务可能仍在执行；请继续使用 doubao_wait_job，不要重复提交。", job};
  }
  if (name === "doubao_resume_job") { if (!id) throw new Error("requestId 不能为空"); return request(`/api/v1/video/jobs/${encodeURIComponent(id)}/resume`, {method: "POST"}); }
  if (name === "doubao_recover_existing_result") { if (!id) throw new Error("requestId 不能为空"); return request(`/api/v1/video/jobs/${encodeURIComponent(id)}/recover-result`, {method: "POST"}); }
  if (name === "doubao_refresh_url") { if (!id) throw new Error("requestId 不能为空"); return request(`/api/v1/video/jobs/${encodeURIComponent(id)}/refresh-url`, {method: "POST"}); }
  if (name !== "doubao_generate_video") throw new Error(`未知工具：${name}`);
  const prompt = String(args.prompt || "").trim(); if (!prompt) throw new Error("prompt 不能为空");
  const form = new FormData(); form.append("prompt", prompt); form.append("source", "mcp"); form.append("model", String(args.model || "Seedance 2.0 Mini")); form.append("ratio", String(args.ratio || "自动")); form.append("duration", String(args.duration || 10)); form.append("accountLockRequired", args.accountId ? "true" : "false"); if (args.accountId) form.append("preferredAccountId", String(args.accountId));
  for (const file of (Array.isArray(args.files) ? args.files : [])) { const full = assertFile(file); form.append("files", new Blob([fs.readFileSync(full)], {type: "image/" + (path.extname(full).toLowerCase() === ".jpg" || path.extname(full).toLowerCase() === ".jpeg" ? "jpeg" : path.extname(full).slice(1))}), path.basename(full)); }
  const query = args.wait ? `?wait=1${args.waitTimeoutMs ? `&waitTimeoutMs=${encodeURIComponent(args.waitTimeoutMs)}` : ""}` : "";
  const queued = await request(`/api/v1/video/generate${query}`, {method: "POST", body: form});
  if (args.wait) return refreshCompletedJobIfNeeded(queued, queued.requestId || queued.id || "");
  return {...queued, nextAction: "doubao_wait_job", suggestedPollIntervalMs: 2000, message: "任务已提交；请使用 doubao_wait_job 继续跟踪，不要重复提交。"};
}
async function handle(message) {
  const {id, method, params = {}} = message;
  if (method === "initialize") return reply(id, {protocolVersion: PROTOCOL_VERSION, capabilities: {tools: {}}, serverInfo: {name: "doubao-video-manager", version: "0.2.0"}});
  if (method === "notifications/initialized") return;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, {tools});
  if (method === "tools/call") { try { return reply(id, result(await callTool(String(params.name || ""), params.arguments || {}))); } catch (error) { return fail(id, `DOUBAO_MCP_${error.status || "CALL_FAILED"}`, error.message); } }
  if (id !== undefined) return fail(id, "METHOD_NOT_FOUND", `不支持的方法：${method}`);
}
const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
input.on("line", line => { if (!line.trim()) return; try { const message = JSON.parse(line); Promise.resolve(handle(message)).catch(error => { if (message.id !== undefined) fail(message.id, "INTERNAL_ERROR", error.message); }); } catch (error) { process.stderr.write(`MCP JSON 解析失败：${error.message}\n`); } });

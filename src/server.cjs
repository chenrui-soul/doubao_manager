"use strict";

if (require.main === module) process.title = "doubao-video-service";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const {ROOT, DATA_ROOT, PROFILE_ROOT, TEMP_ROOT, ACCOUNTS_FILE, PORT, HOST, loadAccounts} = require("./config.cjs");
const {TaskStore} = require("./task-store.cjs");
const {AccountScheduler} = require("./account-scheduler.cjs");
const {DoubaoWorker} = require("./doubao-worker.cjs");
const {RpcWorker} = require("./rpc-worker.cjs");
const {AccountStore} = require("./account-store.cjs");
const {accountQuota, beijingDay} = require("./quota-summary.cjs");
const {quotaFailureDetails} = require("./quota-exhaustion.cjs");
const {nextGenerationHealth} = require("./generation-health.cjs");
const {TaskActions, contextOf, canConfirm, watermarkStatus} = require("./task-actions.cjs");
const {reviewHistoricalJob} = require("./historical-job-review.cjs");
const {cleanupJobTemp, cleanupOrphanTemp, scrubJobAssets} = require("./cache-cleaner.cjs");
const {checkLicense, requireLicense, activateLicense} = require("./license.cjs");

fs.mkdirSync(DATA_ROOT, {recursive: true});
fs.mkdirSync(PROFILE_ROOT, {recursive: true});
fs.mkdirSync(TEMP_ROOT, {recursive: true});
// 临时图片/下载残留只保留 24 小时，账号 Cookie、登录分区和任务状态不在此目录，不会被清理。
cleanupOrphanTemp(TEMP_ROOT);

const accountStore = new AccountStore(ACCOUNTS_FILE);
let accounts = accountStore.list();
const store = new TaskStore(path.join(DATA_ROOT, "jobs.json"));
let quotaSnapshot = null;
function currentAccountQuota(account) {
  const now = Date.now(), revision = store.revision(), day = beijingDay(now);
  if (!quotaSnapshot || quotaSnapshot.revision !== revision || quotaSnapshot.day !== day) {
    quotaSnapshot = {revision, day, jobs: store.recentJobs(500), values: new Map()};
  }
  // Account corrections and cooldown expiry must also invalidate this entry.
  const key = JSON.stringify([account, Number(account.quotaDisabledUntil || 0) > now]);
  const entry = quotaSnapshot.values.get(account.id);
  if (entry?.key === key) return entry.quota;
  const quota = accountQuota(account, quotaSnapshot.jobs, now);
  quotaSnapshot.values.set(account.id, {key, quota});
  return quota;
}
const scheduler = new AccountScheduler(accounts, {
  // Submission history supplies advisory usage statistics only; it must not
  // block dispatch without a provider-confirmed quota failure.
  quotaProvider: currentAccountQuota,
});
// Portable Electron builds can fail to start the API child process on some
// Windows machines. In that case the desktop host injects its embedded-browser
// worker and this module serves HTTP directly from the Electron main process.
const worker = globalThis.__doubaoInProcessWorker || (process.env.DOUBAO_WORKER_RPC === "1" ? new RpcWorker() : new DoubaoWorker({profileRoot: PROFILE_ROOT, tempRoot: TEMP_ROOT}));
const running = new Map();
const submissionTimers = new Map();
const waiting = new Set();
const taskActions = new TaskActions({store, scheduler, worker, accounts: () => accounts, running, waiting, scheduleJob, canRecover: canRecoverExistingResult});
let browserRehearsalActive = false;
const maxQueueSize = Math.min(1000, Math.max(1, Number(process.env.DOUBAO_MAX_QUEUE || 100)));
const loginStates = new Map();
const RESULT_RECOVERY_DELAY_MS = Math.max(5_000, Number(process.env.DOUBAO_RESULT_RECOVERY_DELAY_MS || 15_000));
const RESULT_RECOVERY_MAX_ATTEMPTS = Math.max(1, Number(process.env.DOUBAO_RESULT_RECOVERY_MAX_ATTEMPTS || 4));
const IMAGE_TASK_MAX_TIMEOUT_MS = Math.max(6 * 60 * 1000, Number(process.env.DOUBAO_IMAGE_TASK_MAX_TIMEOUT_MS || 15 * 60 * 1000));

function persistWorkerProgress(progress = {}) {
  const id = String(progress.jobId || "");
  const current = id ? store.get(id) : null;
  if (!current || terminalState(current.state)) return null;
  const conversationId = String(progress.conversationId || "").trim();
  const payload = {...current.payload};
  if (progress.confirmationAttempt && !payload.confirmationAttempt) payload.confirmationAttempt = progress.confirmationAttempt;
  const now = new Date().toISOString();
  const timings = {...(payload.timings || {})};
  const stage = String(progress.state || current.state);
  if (stage === "generating") { clearTimeout(submissionTimers.get(id)); submissionTimers.delete(id); }
  const stageMap = {checking_login: "accountAcquiredAt", configuring: "modeReadyAt", uploading: "uploadCompletedAt", submitting: "submittedAt", generating: "providerStartedAt", completed: "providerCompletedAt"};
  if (stageMap[stage] && !timings[stageMap[stage]]) timings[stageMap[stage]] = now;
  if (timings.queuedAt && timings.accountAcquiredAt) timings.accountWaitMs = Math.max(0, Date.parse(timings.accountAcquiredAt) - Date.parse(timings.queuedAt));
  if (timings.submittedAt && timings.providerCompletedAt) timings.generationWaitMs = Math.max(0, Date.parse(timings.providerCompletedAt) - Date.parse(timings.submittedAt));
  payload.timings = timings;
  if (conversationId) payload.conversationId = conversationId;
  if (progress.submittedEvidence) {
    payload.submittedEvidence = {...payload.submittedEvidence,...progress.submittedEvidence};
    if(current.payload?.submittedEvidence?.confirmed===true) payload.submittedEvidence.confirmed=true;
    if (progress.submittedEvidence.userMessageId) payload.userMessageId = String(progress.submittedEvidence.userMessageId);
    if (progress.submittedEvidence.submittedAt) payload.submittedAt = String(progress.submittedEvidence.submittedAt);
  }
  return store.save({...current, state: String(progress.state || current.state), account_id: String(progress.accountId || current.account_id || "") || null, payload});
}
worker.setProgressHandler?.(persistWorkerProgress);

const REQUEUE_ON_RESTART_STATES = new Set(["queued", "preparing_assets", "selecting_account", "checking_login", "uploading", "configuring"]);
const SUBMITTED_ON_RESTART_STATES = new Set(["generating", "downloading"]);
function recoverInterruptedJobs(taskStore = store) {
  let recovered = 0;
  for(const job of taskStore.recentJobs?.(1000)||[]) {
    const reviewed=reviewHistoricalJob(job);
    if(reviewed){taskStore.save(reviewed);recovered++;}
  }
  if(taskStore===store) reconcileGenerationHealth();
  for (const job of taskStore.activeJobs()) {
    if (job.manualControl?.active) continue;
    if (REQUEUE_ON_RESTART_STATES.has(job.state)) {
      const attempts=job.payload?.attemptHistory||[];
      const ambiguous=hasSubmissionEvidence(job)||attempts.some(a=>a.notSentVerified!==true);
      const stale=job.state!=="queued"&&Date.now()-Date.parse(job.updated_at||job.created_at||new Date().toISOString())>30*60*1000;
      if(ambiguous||stale){
        taskStore.save({...job,state:"submission_unknown",error:{code:"DOUBAO_RESTART_REVIEW_REQUIRED",message:"中断任务需要核对原记录；不会自动重新生成",notSentVerified:false,submittedVerified:false,safeToRetry:false},recovery:{at:new Date().toISOString(),mode:"review_interrupted_attempts",previousState:job.state}});
        recovered+=1;continue;
      }
      taskStore.save({...job, state: "queued", account_id: null, error: null, recovery: {at: new Date().toISOString(), mode: "fresh_submission", previousState: job.state}});
      recovered += 1;
      continue;
    }
    if (job.state === "submitting") {
      // submitting 阶段尚未持久化“已提交证据”，为避免重复扣额度，不能自动重提。
      taskStore.save({...job, state: "submission_unknown", error: {code: "DOUBAO_SUBMISSION_UNKNOWN", message: "服务重启时任务正处于提交阶段，无法确认豆包是否已创建任务；为避免重复生成，请人工核对后恢复"}, recovery: {at: new Date().toISOString(), mode: "manual_confirmation", previousState: job.state}});
      recovered += 1;
      continue;
    }
    if (SUBMITTED_ON_RESTART_STATES.has(job.state)) {
      const conversationId = String(job.result?.conversationId || job.payload?.conversationId || "");
      const hasEvidence = Boolean(conversationId || job.result?.submittedEvidence || job.payload?.submittedEvidence);
      if (hasEvidence) {
          const evidence = job.result?.submittedEvidence || job.payload?.submittedEvidence || {};
          const payload = {...job.payload, preferredAccountId: job.account_id || "", accountLockRequired: true, resumeExisting: true, conversationId, userMessageId: String(job.payload?.userMessageId || evidence.userMessageId || ""), submittedAt: String(job.payload?.submittedAt || evidence.submittedAt || "")};
        taskStore.save({...job, state: "queued", payload, error: null, recovery: {at: new Date().toISOString(), mode: "resume_existing_submission", previousState: job.state}});
      } else {
        taskStore.save({...job, state: "submission_unknown", error: {code: "DOUBAO_SUBMISSION_UNKNOWN", message: "服务重启时任务已进入生成阶段，但没有保存可核对的豆包会话证据；为避免重复生成，请人工核对后恢复"}, recovery: {at: new Date().toISOString(), mode: "manual_confirmation", previousState: job.state}});
      }
      recovered += 1;
    }
  }
  return recovered;
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {"content-type": "application/json; charset=utf-8", "content-length": data.length, "cache-control": "no-store"});
  res.end(data);
}
function errorBody(error) {
  const body = {error: String(error?.message || error || "请求失败")};
  if (error?.code) body.code = String(error.code);
  return body;
}
function jobError(error, fallbackCode = "DOUBAO_WORKER_FAILED") {
  const output = {code: String(error?.code || fallbackCode), message: String(error?.message || error || "豆包任务失败")};
  for (const key of ["category", "retryMode", "userAction", "providerMessage", "providerMessageRaw", "evidence", "accountAction", "safeToRetry", "notSentVerified", "submittedVerified", "terminalFailureVerified", "quotaExhausted", "quotaConsumed", "monitorDiagnostic", "submissionUnknown", "providerTerminal", "verificationRequired", "conversationId", "userMessageId", "submittedAt", "promptDelivered"]) {
    if (error && error[key] !== undefined) output[key] = error[key];
  }
  return output;
}
function requestId() { return `req_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`; }
function readBody(req, limit = 55 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", chunk => { size += chunk.length; if (size > limit) { reject(Object.assign(new Error("请求体超过 50MB 限制"), {statusCode: 413})); req.destroy(); return; } chunks.push(chunk); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function parseDisposition(value) {
  const result = {};
  for (const match of String(value || "").matchAll(/([\w-]+)=(?:"([^"]*)"|([^;]*))/g)) result[match[1]] = match[2] ?? match[3];
  return result;
}
function parseMultipart(buffer, contentType, jobId) {
  const boundary = String(contentType).match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] || String(contentType).match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2];
  if (!boundary) throw Object.assign(new Error("multipart 请求缺少 boundary"), {statusCode: 400});
  const marker = Buffer.from(`--${boundary}`); const fields = {}; const imageAssets = []; let cursor = 0; let index = 0;
  while (true) {
    const start = buffer.indexOf(marker, cursor); if (start < 0) break;
    const headerStart = start + marker.length + 2; if (buffer.subarray(start + marker.length, start + marker.length + 2).toString() === "--") break;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), headerStart); if (headerEnd < 0) break;
    const headers = buffer.subarray(headerStart, headerEnd).toString("utf8"); const bodyStart = headerEnd + 4; const next = buffer.indexOf(marker, bodyStart); if (next < 0) break;
    const body = buffer.subarray(bodyStart, Math.max(bodyStart, next - 2));
    const disposition = headers.match(/content-disposition:\s*([^\r\n]+)/i)?.[1] || ""; const meta = parseDisposition(disposition); const field = String(meta.name || "");
    if (meta.filename) {
      const originalName = path.basename(meta.filename); const ext = path.extname(originalName).toLowerCase();
      if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext)) throw Object.assign(new Error(`不支持的图片格式：${originalName}`), {statusCode: 400});
      const filePath = path.join(TEMP_ROOT, `${jobId}_${index++}${ext}`); fs.writeFileSync(filePath, body);
      imageAssets.push({id: `${jobId}-image-${index}`, name: originalName, originalName, path: filePath, mime: headers.match(/content-type:\s*([^\r\n]+)/i)?.[1] || "image/*", size: body.length, order: imageAssets.length + 1});
    } else if (field) {
      const key = field.replace(/\[\]$/, "");
      const value = body.toString("utf8");
      if (!Object.prototype.hasOwnProperty.call(fields, key)) fields[key] = value;
      else fields[key] = Array.isArray(fields[key]) ? [...fields[key], value] : [fields[key], value];
    }
    cursor = next;
  }
  return {...fields, imageAssets: imageAssets.map(asset => ({...asset, ownedByService: true}))};
}
async function parseRequest(req, jobId) {
  const contentType = String(req.headers["content-type"] || ""); const body = await readBody(req);
  if (/^application\/json/i.test(contentType)) return body.length ? JSON.parse(body.toString("utf8")) : {};
  if (/^multipart\/form-data/i.test(contentType)) return parseMultipart(body, contentType, jobId);
  throw Object.assign(new Error("仅支持 application/json 或 multipart/form-data"), {statusCode: 415});
}
function normalizedPayload(input) {
  const payload = input && typeof input === "object" ? input : {};
  const prompt = String(payload.prompt || "").trim(); if (!prompt) throw Object.assign(new Error("prompt 不能为空"), {statusCode: 400});
  const imageAssets = Array.isArray(payload.imageAssets) ? payload.imageAssets : [];
  const remoteImageUrls = extractRemoteImageUrls(payload);
  const requestedTimeoutMs = Number(payload.timeoutMs || 20 * 60 * 1000);
  const timeoutMs = imageAssets.length || remoteImageUrls.length ? Math.max(requestedTimeoutMs, IMAGE_TASK_MAX_TIMEOUT_MS) : Math.max(requestedTimeoutMs, 30_000);
  const preferredAccountId = String(payload.preferredAccountId || "").trim();
  const accountLockRequired = payload.accountLockRequired === true || /^(?:1|true)$/i.test(String(payload.accountLockRequired || ""));
  const allowPaidQuota = payload.allowPaidQuota === true || /^(?:1|true)$/i.test(String(payload.allowPaidQuota || ""));
  if (accountLockRequired && !preferredAccountId) throw Object.assign(new Error("锁定账号时 preferredAccountId 不能为空"), {statusCode: 400, code: "DOUBAO_ACCOUNT_TARGET_REQUIRED"});
  const model = String(payload.model || payload.doubaoModel || "Seedance 2.0 Mini");
  const ratioValue = String(payload.ratio || "自动").replaceAll("：", ":").replace(/\s+/g, "").trim();
  const supportedRatios = new Set(["自动", "3:4", "4:3", "9:16", "16:9", "1:1", "21:9"]);
  if (!supportedRatios.has(ratioValue)) throw Object.assign(new Error("ratio 必须为 自动、3:4、4:3、9:16、16:9、1:1 或 21:9"), {statusCode:400,code:"DOUBAO_RATIO_UNSUPPORTED"});
  const requestedResolution = String(payload.resolution || "").trim();
  if (requestedResolution && requestedResolution !== "自动") {
    throw Object.assign(new Error("当前豆包页面没有分辨率控件，当前接口只支持画面比例和时长"), {statusCode:400,code:"DOUBAO_RESOLUTION_UNSUPPORTED"});
  }
  const duration = Number(payload.duration ?? 10);
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw Object.assign(new Error("duration 必须为 4 到 15 的整数秒数"), {statusCode:400,code:"DOUBAO_DURATION_UNSUPPORTED"});
  return {prompt, title: String(payload.title || payload.name || "").trim().slice(0, 200), model, ratio: ratioValue, duration, source: String(payload.source || "api").trim().slice(0, 32) || "api", timeoutMs, imageAssets, remoteImageUrls, preferredAccountId, accountLockRequired, allowPaidQuota};
}

const REMOTE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const REMOTE_IMAGE_TIMEOUT_MS = 30 * 1000;
const REMOTE_IMAGE_REDIRECTS = 3;

function extractRemoteImageUrls(payload = {}) {
  const values = [];
  const add = value => {
    if (Array.isArray(value)) { value.forEach(add); return; }
    if (value && typeof value === "object") { add(value.url || value.imageUrl || value.image_url); return; }
    const text = String(value || "").trim();
    if (!text) return;
    if ((text.startsWith("[") && text.endsWith("]")) || (text.startsWith("{") && text.endsWith("}"))) {
      try { add(JSON.parse(text)); return; } catch {}
    }
    // Chat clients sometimes copy a Markdown link into a form-data text field.
    // Accept its target URL while keeping the final HTTPS/SSRF validation below.
    const markdownUrl = text.match(/^\[[^\]]*\]\((https:\/\/[^)\s]+)\)$/i)?.[1];
    if (markdownUrl) { values.push(markdownUrl); return; }
    if (/^https:\/\//i.test(text)) values.push(text);
  };
  add(payload.files); add(payload.imageUrls); add(payload.imageUrl); add(payload.image_url);
  return [...new Set(values)];
}

function isPrivateIp(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const octets = address.split(".").map(Number);
    return octets[0] === 10 || octets[0] === 127 || octets[0] === 0 || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168);
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }
  return false;
}

async function assertSafeRemoteImageUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { throw Object.assign(new Error("网络图片 URL 无效"), {statusCode: 400, code: "DOUBAO_IMAGE_URL_INVALID"}); }
  if (parsed.protocol !== "https:") throw Object.assign(new Error("网络图片只支持 HTTPS URL"), {statusCode: 400, code: "DOUBAO_IMAGE_URL_PROTOCOL_UNSUPPORTED"});
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || isPrivateIp(hostname)) throw Object.assign(new Error("网络图片 URL 不允许访问本机或内网地址"), {statusCode: 400, code: "DOUBAO_IMAGE_URL_PRIVATE_BLOCKED"});
  let addresses;
  try { addresses = net.isIP(hostname) ? [hostname] : (await dns.lookup(hostname, {all: true})).map(item => item.address); }
  catch { throw Object.assign(new Error("网络图片域名解析失败"), {statusCode: 400, code: "DOUBAO_IMAGE_URL_DNS_FAILED"}); }
  if (!addresses.length || addresses.some(isPrivateIp)) throw Object.assign(new Error("网络图片 URL 解析到了本机或内网地址"), {statusCode: 400, code: "DOUBAO_IMAGE_URL_PRIVATE_BLOCKED"});
  return parsed;
}

function detectImageType(buffer, contentType = "") {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return {ext: ".png", mime: "image/png"};
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return {ext: ".jpg", mime: "image/jpeg"};
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return {ext: ".webp", mime: "image/webp"};
  const normalized = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (normalized === "image/png") return {ext: ".png", mime: normalized};
  if (normalized === "image/jpeg" || normalized === "image/jpg") return {ext: ".jpg", mime: "image/jpeg"};
  if (normalized === "image/webp") return {ext: ".webp", mime: normalized};
  return null;
}

async function readRemoteImageResponse(response) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > REMOTE_IMAGE_MAX_BYTES) throw Object.assign(new Error("网络图片超过 20MB 限制"), {statusCode: 413, code: "DOUBAO_IMAGE_URL_TOO_LARGE"});
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > REMOTE_IMAGE_MAX_BYTES) throw Object.assign(new Error("网络图片超过 20MB 限制"), {statusCode: 413, code: "DOUBAO_IMAGE_URL_TOO_LARGE"});
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function downloadRemoteImage(url, jobId, index) {
  let current = String(url || "").trim();
  for (let redirect = 0; redirect <= REMOTE_IMAGE_REDIRECTS; redirect += 1) {
    const parsed = await assertSafeRemoteImageUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_IMAGE_TIMEOUT_MS);
    let response;
    try {
    response = await fetch(parsed, {redirect: "manual", signal: controller.signal, headers: {accept: "image/png,image/jpeg,image/webp;q=0.9,*/*;q=0.1", "user-agent": "DoubaoVideoService/0.2"}});
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel();
      if (redirect >= REMOTE_IMAGE_REDIRECTS) throw Object.assign(new Error("网络图片重定向次数过多"), {statusCode: 502, code: "DOUBAO_IMAGE_URL_REDIRECT_LIMIT"});
      current = new URL(response.headers.get("location"), parsed).toString(); continue;
    }
    if (!response.ok) throw Object.assign(new Error(`网络图片下载返回 HTTP ${response.status}`), {statusCode: 502, code: "DOUBAO_IMAGE_URL_DOWNLOAD_FAILED"});
    const buffer = await readRemoteImageResponse(response);
    const type = detectImageType(buffer, response.headers.get("content-type"));
    if (!type) throw Object.assign(new Error("网络图片不是支持的 PNG/JPEG/WEBP 文件"), {statusCode: 415, code: "DOUBAO_IMAGE_URL_FORMAT_UNSUPPORTED"});
    const filePath = path.join(TEMP_ROOT, `${jobId}_url_${index}${type.ext}`);
    fs.writeFileSync(filePath, buffer);
    const name = path.basename(parsed.pathname) || `network-image-${index}${type.ext}`;
    return {id: `${jobId}-remote-image-${index}`, name, originalName: name, path: filePath, mime: type.mime, size: buffer.length, order: index + 1, ownedByService: true, sourceUrl: current};
    } catch (error) {
      if (String(error.code || "").startsWith("DOUBAO_")) throw error;
      throw Object.assign(new Error(`网络图片下载失败：${error.name === "AbortError" ? "请求超时" : error.message || error}`), {statusCode: 502, code: "DOUBAO_IMAGE_URL_DOWNLOAD_FAILED"});
    } finally { clearTimeout(timer); }
  }
  throw Object.assign(new Error("网络图片下载失败"), {statusCode: 502, code: "DOUBAO_IMAGE_URL_DOWNLOAD_FAILED"});
}

async function materializeRemoteImages(payload, jobId) {
  const urls = Array.isArray(payload?.remoteImageUrls) ? payload.remoteImageUrls : [];
  if (!urls.length) { const {remoteImageUrls, ...withoutUrls} = payload || {}; return withoutUrls; }
  const existing = Array.isArray(payload.imageAssets) ? payload.imageAssets : [];
  const downloaded = [];
  try {
    for (let index = 0; index < urls.length; index += 1) downloaded.push(await downloadRemoteImage(urls[index], jobId, existing.length + index));
    const {remoteImageUrls, ...withoutUrls} = payload;
    return {...withoutUrls, imageAssets: [...existing, ...downloaded]};
  } catch (error) {
    for (const asset of downloaded) { try { if (asset.path && fs.existsSync(asset.path)) fs.unlinkSync(asset.path); } catch {} }
    throw error;
  }
}
function publicJob(job) {
  const c = contextOf(job);
  return {requestId: job.id, accountId: job.account_id || null, createdAt: job.created_at, updatedAt: job.updated_at,
    model: job.payload?.model || null, ratio: job.payload?.ratio || "自动", duration: job.payload?.duration || 10,
    ...(job.result || {}), source: job.payload?.source || "api", title: job.payload?.title || "", promptPreview: String(job.payload?.prompt || "").slice(0, 180),
    conversationId: c.conversationId, timings: job.payload?.timings || {}, state: job.state,
    watermarkStatus:watermarkStatus(job),
    manualControl: job.manualControl || null, resultSelectionPending:job.state !== "completed" && !!job.resultReview?.candidates?.length, actions: taskActions.flags(job),
    canRecoverExistingResult: taskActions.recoverable(job), ...(job.error ? {error: job.error} : {})};
}
function jobDetail(job) { return {...publicJob(job), prompt: job.payload?.prompt || "", allowPaidQuota: job.payload?.allowPaidQuota === true, userMessageId: contextOf(job).userMessageId, submittedEvidence: job.payload?.submittedEvidence || null, actionHistory: job.actionHistory || [], lastReview: job.lastReview || null, recovery: job.recovery || null, resultReview:job.resultReview || null, lastRecoveryError:job.lastRecoveryError || null, resultRecoveryHistory:job.resultRecoveryHistory || [], pendingWatermarkResult:job.pendingWatermarkResult ? {id:job.pendingWatermarkResult.id,watermarkedUrl:job.pendingWatermarkResult.output.watermarkedUrl} : null,lastWatermarkError:job.lastWatermarkError || null}; }

function hasSubmissionEvidence(job) {
  const payload = job?.payload || {};
  const result = job?.result || {};
  const evidence = payload.submittedEvidence || result.submittedEvidence;
  return Boolean(
    evidence?.confirmed === true || evidence?.conversationId || evidence?.userMessageId ||
    payload.conversationId || payload.userMessageId || payload.submittedAt ||
    result.conversationId || result.videoVid
  );
}
function isAmbiguousPostSubmissionError(error) {
  if (!error) return false;
  if (error.providerTerminal === true || error.terminalFailureVerified === true || error.notSentVerified === true || error.quotaExhausted === true) return false;
  if (error.submittedVerified === true || error.submissionUnknown === true) return true;
  const code = String(error.code || "");
  const message = String(error.message || error);
  return [
    "DOUBAO_WORKER_FAILED", "DOUBAO_CONVERSATION_RESTORE_FAILED", "DOUBAO_VIDEO_RESULT_TIMEOUT",
    "DOUBAO_WORKER_TIMEOUT", "DOUBAO_BROWSER_START_FAILED", "ERR_FAILED", "TARGET_CLOSED",
    "DOUBAO_VIDEO_TASK_NOT_CREATED", "DOUBAO_CONFIRMATION_INPUT_NOT_READY",
  ].includes(code) || /Object has been destroyed|target closed|ERR_FAILED|页面加载失败|WebContents|browser.*closed|浏览器对象/i.test(message);
}
function shouldPreserveSubmittedJob(job, error) {
  if (!isAmbiguousPostSubmissionError(error)) return false;
  return hasSubmissionEvidence(job) || ["submitting", "generating", "downloading"].includes(String(job?.state || ""));
}
function submissionUnknownError(error) {
  const original = jobError(error, "DOUBAO_WORKER_FAILED");
  return {
    ...original,
    code: /^DOUBAO_(?:CONFIRMATION_|REPLY_|VIDEO_QUOTA_|QUOTA_|VIDEO_TASK_NOT_CREATED)/.test(original.code) ? original.code : "DOUBAO_SUBMISSION_UNKNOWN",
    category: "submission_recovery",
    message: "任务提交或结果状态待核实；有原会话证据时可补取，证据缺失时需人工核对，不会重新生成",
    originalError: original,
    safeToRetry: false,
    notSentVerified: false,
    submittedVerified: error?.submittedVerified === true,
    submissionUnknown: true,
    accountAction: "hold",
  };
}
function canRecoverExistingResult(job) {
  const error = job?.error || {};
  const evidence = job?.payload?.submittedEvidence || job?.result?.submittedEvidence || {};
  const delivery=error.monitorDiagnostic?.confirmation?.delivery||error.originalError?.monitorDiagnostic?.confirmation?.delivery;
  const confirmationDelivered=delivery?.delivered===true&&Boolean(delivery.userMessageId)&&delivery.conversationId===job?.payload?.conversationId&&delivery.userMessageId!==job?.payload?.userMessageId;
  if (error.providerTerminal === true || error.terminalFailureVerified === true || error.quotaExhausted === true || error.notSentVerified === true) return false;
  if (job?.state === "submission_unknown" && ["DOUBAO_CONFIRMATION_QUEUED", "DOUBAO_VIDEO_TASK_NOT_CREATED"].includes(String(error.code || "")) && !confirmationDelivered && evidence.scopedGenerating !== true && evidence.confirmed !== true && evidence.requestConfirmed !== true) return false;
  return Boolean(
    ["submission_unknown", "failed", "generating", "downloading"].includes(String(job?.state || "")) &&
    hasSubmissionEvidence(job) &&
    (job?.state === "submission_unknown" || shouldPreserveSubmittedJob(job, error))
  );
}
function isAccountSwitchable(result, error) {
  // After a prompt has been confirmed as sent, changing accounts can create a
  // duplicate paid generation. Keep the original conversation for recovery.
  if (result?.submittedVerified === true || error?.submittedVerified === true) return false;
  const code = String(result?.code || error?.code || "");
  return Boolean(isQuotaExhausted(result, error) || ["DOUBAO_LOGIN_REQUIRED", "DOUBAO_SERVICE_BUSY", "DOUBAO_BROWSER_START_FAILED", "DOUBAO_COMPOSER_NOT_READY", "DOUBAO_VIDEO_RESULT_TIMEOUT", "DOUBAO_VIDEO_NOT_CREATED", "DOUBAO_VIDEO_TASK_NOT_CREATED", "ERR_FAILED"].includes(code) || /登录|浏览器启动|调试端口|本机浏览器|找不到 Chrome|找不到.*浏览器|服务繁忙|网络异常|请求过多|输入框.*未加载|新对话页面未加载|未确认进入.*视频生成模式|视频生成模式.*未确认|Object has been destroyed|ERR_FAILED|页面加载失败/i.test(String(result?.message || error?.message || "")));
}
function isPreSubmissionFailure(result, error) {
  const value = result || error || {};
  const code = String(value.code || "");
  const category = String(value.category || "");
  if(value.submissionUnknown===true||value.submittedVerified===true||value.notSentVerified===false) return false;
  return [
    "DOUBAO_ASSET_UPLOAD_FAILED",
    "DOUBAO_PARAMETER_CONFIG_FAILED",
    "DOUBAO_PROMPT_NOT_READY",
    "DOUBAO_COMPOSER_NOT_READY",
  ].includes(code) || (category === "asset_upload" && value.terminalFailureVerified === true);
}
function isQuotaExhausted(result, error) {
  const code = String(result?.code || error?.code || "");
  return Boolean(result?.quotaExhausted === true || error?.quotaExhausted === true || ["DOUBAO_VIDEO_QUOTA_EXHAUSTED", "DOUBAO_QUOTA_EXHAUSTED"].includes(code));
}
function nextBeijingMidnight(now = Date.now()) {
  const offset = 8 * 60 * 60 * 1000;
  const shifted = new Date(Number(now) + offset);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1) - offset;
}
function disableAccountAfterFailure(account, result, error) {
  if (!account?.id) return null;
  if (!isQuotaExhausted(result, error)) { scheduler.disable(account); return null; }
  const details = quotaFailureDetails(result || error);
  const until = details.quotaRequiresRecheck ? null : nextBeijingMidnight();
  accountStore.setQuotaExhaustion(account.id, details, until);
  accounts = accountStore.list();
  scheduler.replaceAccounts(accounts);
  return until;
}
function reconcilePersistedQuotaCooldowns(now = Date.now()) {
  const day = beijingDay(now), until = nextBeijingMidnight(now), ids = new Set();
  const knownAccounts = new Map(accountStore.list().map(account => [account.id, account]));
  let changed = false;
  for (const job of store.recentJobs(1000)) {
    if (!job.account_id || !isQuotaExhausted(job.result, job.error)) continue;
    const at = new Date(job.updated_at || job.created_at).getTime();
    const account = knownAccounts.get(job.account_id);
    if (!account || !Number.isFinite(at) || at <= Number(account.quotaClearedAt || 0)) continue;
    const failure = isQuotaExhausted(job.result) ? job.result : job.error;
    const details = quotaFailureDetails(failure, at);
    if (!details.quotaRequiresRecheck && beijingDay(at) !== day) continue;
    ids.add(account.id);
    if (account.quotaRequiresRecheck || (!details.quotaRequiresRecheck && Number(account.quotaDisabledUntil || 0) >= until)) continue;
    knownAccounts.set(account.id, accountStore.setQuotaExhaustion(account.id, details, details.quotaRequiresRecheck ? null : until));
    changed = true;
  }
  if (changed) {
    accounts = accountStore.list();
    scheduler.replaceAccounts(accounts);
  }
  return {changed, accountIds: [...ids], until};
}

function hasVideoResult(result) {
  if (!result || result.ok !== true || result.state !== "completed") return false;
  const urls = [result.watermarkFreeUrl, result.watermarkedUrl, result.videoUrl, ...(Array.isArray(result.resultUrls) ? result.resultUrls : [])];
  return urls.some(value => /^(?:https?:\/\/|mock:\/\/)/i.test(String(value || "").trim()));
}
function withTimeout(promise, timeoutMs, message = "豆包任务执行超时") {
  const limit = Math.max(1000, Number(timeoutMs) || 1000);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), {code: "DOUBAO_WORKER_TIMEOUT", category: "timeout", safeToRetry: true})), limit);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function isResultWaitTimeout(error) {
  return error?.code === "DOUBAO_VIDEO_RESULT_TIMEOUT" || error?.code === "DOUBAO_WORKER_TIMEOUT";
}
function queueResultRecovery(job, account, error) {
  const current = store.get(job?.id);
  if (!current || !account?.id || !isResultWaitTimeout(error)) return false;
  const attempts = Number(current.payload?.resultRecoveryAttempts || 0);
  if (attempts >= RESULT_RECOVERY_MAX_ATTEMPTS) return false;
  const conversationId = String(error?.conversationId || current.payload?.conversationId || error?.monitorDiagnostic?.conversationId || "").trim();
  if (!conversationId) return false;
  const nextAttempt = attempts + 1;
  const payload = {
    ...current.payload,
    resumeExisting: true,
    accountLockRequired: true,
    preferredAccountId: account.id,
    conversationId,
    resultRecoveryAttempts: nextAttempt,
    timeoutMs: Math.max(Number(current.payload?.timeoutMs || 0), IMAGE_TASK_MAX_TIMEOUT_MS),
  };
  store.save({...current, state: "queued", account_id: account.id, payload, error: {
    code: "DOUBAO_RESULT_WAIT_RETRYING",
    category: "result_wait",
    submittedVerified: true,
    safeToRetry: false,
    notSentVerified: false,
    accountAction: "hold",
    message: `豆包任务已提交但读取视频地址超时，${Math.ceil(RESULT_RECOVERY_DELAY_MS / 1000)} 秒后继续读取原任务（第 ${nextAttempt}/${RESULT_RECOVERY_MAX_ATTEMPTS} 次，不会重复提交）`,
  }});
  const recoveryTimer = setTimeout(() => {
    const latest = store.get(current.id);
    if (!latest || latest.state !== "queued" || Number(latest.payload?.resultRecoveryAttempts || 0) !== nextAttempt) return;
    try { scheduleJob(latest); } catch {}
  }, RESULT_RECOVERY_DELAY_MS);
  recoveryTimer.unref?.();
  return true;
}
function executionCapacity() { return Math.max(1, accounts.length); }
function terminalState(state) { return ["completed", "failed", "cancelled", "submission_unknown", "awaiting_login", "awaiting_verification"].includes(state); }
function handleJobError(id, error) {
  const latest = store.get(id);
  if (latest && !terminalState(latest.state)) {
    cleanupJobTemp(TEMP_ROOT, id);
    const preserve = shouldPreserveSubmittedJob(latest, error);
    store.save(scrubJobAssets({
      ...latest,
      state: preserve ? "submission_unknown" : "failed",
      error: preserve ? submissionUnknownError(error) : jobError(error, "DOUBAO_JOB_FAILED"),
      recovery: preserve ? {at: new Date().toISOString(), mode: "preserve_submitted_after_uncaught_error", previousState: latest.state} : latest.recovery,
    }));
  }
}
function recordGenerationHealth(account, error, jobId) {
  if(!account) return;
  const current=accountStore.list().find(a=>a.id===account.id);
  if(!current) return;
  const next=nextGenerationHealth(current.generationHealth,error,jobId);
  if(JSON.stringify(next)===JSON.stringify(current.generationHealth)) return;
  accountStore.setGenerationHealth(account.id,next);
  accounts=accountStore.list();scheduler.replaceAccounts(accounts);
}
function reconcileGenerationHealth() {
  const jobs=store.recentJobs(1000).slice().sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)));
  for(const account of accounts) {
    let health=account.generationHealth||{}, cutoff=health.updatedAt||health.checkedAt||"";
    const events=[];
    for(const job of jobs) {
      for(const attempt of job.payload?.attemptHistory||[]) if(attempt.accountId===account.id) events.push({at:attempt.at,id:job.id,error:attempt});
      if(job.account_id===account.id&&(job.state==="completed"||job.error?.code==="DOUBAO_ASSET_AUTHORIZATION_REQUIRED")) {
        const at=job.recovery?.mode==="historical_evidence_review" ? (job.recovery.previousUpdatedAt||job.payload?.attemptHistory?.at(-1)?.at||job.created_at) : job.updated_at;
        events.push({at,id:job.id,error:job.state==="completed"?null:job.error});
      }
    }
    for(const event of events.sort((a,b)=>String(a.at).localeCompare(String(b.at)))) {
      if(!event.at||event.at<=cutoff) continue;
      const next=nextGenerationHealth(health,event.error,event.id);
      if(next!==health) health={...next,updatedAt:event.at};
    }
    if(JSON.stringify(health)!==JSON.stringify(account.generationHealth)) accountStore.setGenerationHealth(account.id,health);
  }
  accounts=accountStore.list();scheduler.replaceAccounts(accounts);
}
function preserveAttemptContext(job, value={}) {
  const payload={...job.payload};
  for(const key of ["conversationId","userMessageId","submittedAt"]) if(value[key]) payload[key]=String(value[key]);
  if(value.submittedEvidence) payload.submittedEvidence={...payload.submittedEvidence,...value.submittedEvidence};
  return {...job,payload};
}
function dispatchJobs() {
  if (browserRehearsalActive) return;
  while (running.size < executionCapacity() && waiting.size > 0) {
    const id = waiting.values().next().value;
    waiting.delete(id);
    const job = store.get(id);
    if (!job || terminalState(job.state)) continue;
    executeJob(job).catch(error => handleJobError(id, error)).finally(dispatchJobs);
  }
}
function scheduleJob(job) {
  if (!job?.id) throw new Error("任务缺少 requestId");
  if (job.manualControl?.active) return false;
  if (running.has(job.id) || waiting.has(job.id)) return false;
  if (running.size + waiting.size >= maxQueueSize) {
    throw Object.assign(new Error(`任务队列已满，当前最多接收 ${maxQueueSize} 个任务，请稍后重试`), {statusCode: 429, code: "DOUBAO_QUEUE_FULL"});
  }
  waiting.add(job.id);
  // Persist and acknowledge the request before starting synchronous worker
  // preparation. Queue capacity includes waiting jobs during this turn.
  setImmediate(dispatchJobs);
  return true;
}
function scheduleRecoveredJobs(taskStore = store, enqueue = scheduleJob) {
  let scheduled = 0;
  for (const job of taskStore.activeJobs()) {
    if (job.state !== "queued" || job.manualControl?.active) continue;
    if (enqueue(job) !== false) scheduled += 1;
  }
  return scheduled;
}
async function executeJob(job) {
  if (running.has(job.id)) return;
  running.set(job.id, true);
  let selected = null; const tried = new Set();
  const preferredAccountId = String(job.payload?.preferredAccountId || "");
  const accountLockRequired = job.payload?.accountLockRequired === true;
  try {
    store.save({...job, state: job.payload?.remoteImageUrls?.length ? "preparing_assets" : "selecting_account"});
    await requireLicense({force: true});
    if (job.payload?.remoteImageUrls?.length) {
      const payload = await materializeRemoteImages(job.payload, job.id);
      job = store.save({...store.get(job.id), payload, state: "selecting_account"});
    }
    while (tried.size < accounts.length) {
      selected = await scheduler.acquire(30 * 60 * 1000, tried.size === 0 ? preferredAccountId : "", tried, {monitorExisting: job.payload?.resumeExisting === true, allowPaidQuota: job.payload?.allowPaidQuota === true});
      await requireLicense();
      if (tried.has(selected.id)) { scheduler.release(selected); continue; }
      tried.add(selected.id); store.save({...store.get(job.id), state: "checking_login", account_id: selected.id});
      try {
        const detected = await worker.detect(selected, {background: true});
        saveDetectedAccountState(selected, detected);
        accounts = accountStore.list();
        scheduler.replaceAccounts(accounts);
        if (detected.verificationRequired) { scheduler.disable(selected, 5 * 60_000); store.save({...store.get(job.id), state: "awaiting_verification", account_id: selected.id, error: {code: "DOUBAO_VERIFICATION_REQUIRED", message: "该账号需要人工验证，请先在内置豆包窗口完成验证"}}); scheduler.release(selected); selected = null; break; }
        if (!detected.loggedIn) { scheduler.disable(selected, 60_000); store.save({...store.get(job.id), state: "awaiting_login", account_id: selected.id, error: {code: "DOUBAO_LOGIN_REQUIRED", message: "该账号尚未登录，请先完成首次可视化登录"}}); scheduler.release(selected); selected = null; if (accountLockRequired) break; continue; }
        // Keep the pre-submit phase visible; the worker will advance to
        // `generating` only after it has confirmed a real submission.
        const current = store.get(job.id); store.save({...current, state: "submitting", account_id: selected.id, error: null});
        // 任务终态由豆包明确完成/失败决定，不能用本地 timeoutMs 包住 worker，
        // 否则豆包仍在生成时会被服务提前标记为失败。
        // Bound only the pre-submission wait. Once the worker reports a real
        // submission and progress moves to `generating`, its long provider
        // monitor is allowed to continue without this guard.
        // Reference images are uploaded sequentially and each upload can take
        // up to 30s (with up to three attempts). The old fixed 180s guard
        // expired while a valid 7-image submission was still preparing, which
        // caused an unnecessary account switch and duplicate submission risk.
        const referenceCount = Array.isArray(job.payload?.imageAssets) ? job.payload.imageAssets.length : 0;
        const configuredSubmitTimeout = Number(process.env.DOUBAO_SUBMISSION_TIMEOUT_MS || 180_000);
        const imageSubmitBudget = 60_000 + referenceCount * 90_000;
        const submitTimeoutMs = Math.max(90_000, configuredSubmitTimeout, imageSubmitBudget);
        // Use a direct timer rather than a polling loop. A stuck Electron IPC
        // request must still unwind the API job instead of leaving it forever
        // in `submitting`.
        const submitGuard = new Promise((_, reject) => {
          const timer = setTimeout(() => reject(Object.assign(new Error(`豆包提交阶段超时（${Math.round(submitTimeoutMs / 1000)} 秒），宿主未返回提交结果`), {
            code: "DOUBAO_SUBMISSION_TIMEOUT",
            category: "submission",
            submissionUnknown: true,
            safeToRetry: false,
            notSentVerified: false,
            submittedVerified: false,
            terminalFailureVerified: false,
          })), submitTimeoutMs);
          submissionTimers.set(job.id, timer);
        });
        console.log(`submit-watchdog job=${job.id} account=${selected.id} timeoutMs=${submitTimeoutMs} references=${referenceCount}`);
        let result;
        try { await requireLicense({force: true}); result = await Promise.race([worker.generate({...current, account: selected}), submitGuard]); }
        finally { clearTimeout(submissionTimers.get(job.id)); submissionTimers.delete(job.id); }
        const latest = preserveAttemptContext(store.get(job.id), result);
        if (!hasVideoResult(result)) recordGenerationHealth(selected,result,job.id);
        if (result.loginRequired || result.verificationRequired || result.paused) {
          if (result.loginRequired && !accountLockRequired && tried.size < accounts.length) {
            scheduler.disable(selected, 60_000, "login_required");
            scheduler.release(selected); selected = null; continue;
          }
          const state = result.loginRequired ? "awaiting_login" : "awaiting_verification";
          scheduler.disable(selected, result.loginRequired ? 60_000 : 5 * 60_000, result.loginRequired ? "login_required" : "verification_required");
          store.save({...latest, state, account_id: selected.id, result: null, error: jobError({code: result.loginRequired ? "DOUBAO_LOGIN_REQUIRED" : "DOUBAO_VERIFICATION_REQUIRED", message: result.message || "需要人工处理后继续"})}); scheduler.release(selected); selected = null; break;
        }
        if (hasVideoResult(result)) {
          recordGenerationHealth(selected,null,job.id);
          const completed = store.get(job.id); const timings = {...(completed.payload?.timings || {}), providerCompletedAt: (completed.payload?.timings?.providerCompletedAt || new Date().toISOString()), resultReturnedAt: new Date().toISOString()};
          if (timings.submittedAt) timings.generationWaitMs = Math.max(0, Date.parse(timings.providerCompletedAt) - Date.parse(timings.submittedAt));
          store.save({...completed, state: "completed", account_id: selected.id, payload: {...completed.payload, timings}, result, error: null}); scheduler.release(selected); selected = null; break;
        }
        if (result.ok && result.state === "completed") {
          // A completed provider task must never be regenerated on another
          // account merely because its URL could not be extracted.
          const conversationId = String(result.conversationId || latest.payload?.conversationId || "");
          const missingUrl = {code: "DOUBAO_RESULT_URL_UNAVAILABLE", message: "豆包报告生成完成，但没有返回可用的视频地址；请核对原会话，不会重新生成", submittedVerified:true, safeToRetry:false, notSentVerified:false};
          store.save({...latest, state: "submission_unknown", payload:{...latest.payload, conversationId}, account_id: selected.id, error: missingUrl}); scheduler.release(selected); selected = null; break;
        }
        if (isPreSubmissionFailure(result)) {
          result.notSentVerified = true;
          result.submittedVerified = false;
          result.submissionUnknown = false;
        }
        const resultQuotaExhausted = isQuotaExhausted(result);
        if (resultQuotaExhausted) disableAccountAfterFailure(selected, result);
        if (((result.providerTerminal === true || result.terminalFailureVerified === true) && result.notSentVerified !== true) || (resultQuotaExhausted && hasSubmissionEvidence(latest))) {
          store.save({...latest,state:"failed",account_id:selected.id,error:jobError(result)});
          scheduler.release(selected); selected=null; break;
        }
        if (!isPreSubmissionFailure(result) && (result.submittedVerified === true || result.notSentVerified === false)) {
          store.save({...latest, state: "submission_unknown", account_id: selected.id, error: jobError(result, "DOUBAO_SUBMISSION_UNKNOWN")}); scheduler.release(selected); selected = null; break;
        }
        if (isAccountSwitchable(result)) {
          if (!resultQuotaExhausted) disableAccountAfterFailure(selected, result);
          if (!accountLockRequired) { scheduler.release(selected); selected = null; continue; }
        }
        store.save({...latest, state: "failed", account_id: selected.id, error: jobError(result, "DOUBAO_GENERATION_FAILED")}); scheduler.release(selected); selected = null; break;
      } catch (error) {
        const latest = preserveAttemptContext(store.get(job.id),error);
        recordGenerationHealth(selected,error,job.id);
        const attemptHistory = [...(latest.payload?.attemptHistory || []), {
          accountId: selected.id,
          at: new Date().toISOString(),
          code: String(error?.code || "DOUBAO_WORKER_FAILED"),
          message: String(error?.message || error || "任务失败"),
          phase: String(error?.category || latest.state || "unknown"),
          submittedVerified: error?.submittedVerified === true,
          notSentVerified: error?.notSentVerified === true,
          quotaConsumed: error?.quotaConsumed,
          conversationId: String(error?.conversationId || latest.payload?.conversationId || "") || null,
          userMessageId: String(error?.userMessageId || latest.payload?.userMessageId || "") || null,
          submittedAt: String(error?.submittedAt || latest.payload?.submittedAt || "") || null,
        }];
        latest.payload = {...latest.payload, attemptHistory};
        if(error.code==="DOUBAO_ASSET_AUTHORIZATION_REQUIRED") {
          store.save({...latest,state:"awaiting_verification",account_id:selected.id,error:jobError(error)});
          scheduler.release(selected);selected=null;break;
        }
        const recovered = isResultWaitTimeout(error) && error?.submittedVerified === true && queueResultRecovery(latest, selected, error);
        const preSubmissionFailure = isPreSubmissionFailure(null, error);
        if (preSubmissionFailure) {
          error.notSentVerified = true;
          error.submittedVerified = false;
          error.submissionUnknown = false;
        }
        const submittedEvidence = !preSubmissionFailure && (error?.submittedVerified === true || error?.notSentVerified === false);
        const preserveSubmitted = shouldPreserveSubmittedJob(latest, error);
        const submissionUnknown = !recovered && !preSubmissionFailure && (submittedEvidence || preserveSubmitted || error?.submissionUnknown === true || /提交状态未知|submission_unknown/i.test(String(error?.message || "")) || error?.code === "DOUBAO_SUBMISSION_UNKNOWN" || isResultWaitTimeout(error));
        // A quota failure can arrive after the provider has accepted the
        // conversation, which correctly becomes submission_unknown to avoid a
        // duplicate generation. That state must still cool down the account.
        const errorQuotaExhausted = isQuotaExhausted(null, error);
        if (errorQuotaExhausted) disableAccountAfterFailure(selected, null, error);
        if(((error.providerTerminal===true||error.terminalFailureVerified===true)&&error.notSentVerified!==true)||(errorQuotaExhausted&&hasSubmissionEvidence(latest))) {
          store.save({...latest,state:"failed",account_id:selected.id,error:jobError(error)});
          scheduler.release(selected);selected=null;break;
        }
        if (recovered) {
          scheduler.release(selected); selected = null; break;
        }
        if (submissionUnknown) {
          const payload = {...latest.payload};
          if (error?.conversationId) payload.conversationId = String(error.conversationId);
          if (error?.userMessageId) payload.userMessageId = String(error.userMessageId);
          if (error?.submittedAt) payload.submittedAt = String(error.submittedAt);
          if (error?.submittedEvidence) payload.submittedEvidence = error.submittedEvidence;
          store.save({...latest, state: "submission_unknown", payload: {...payload, attemptHistory}, account_id: selected.id, error: preserveSubmitted ? submissionUnknownError(error) : jobError(error, "DOUBAO_SUBMISSION_UNKNOWN"), recovery: {at: new Date().toISOString(), mode: "preserve_submitted_after_worker_error", previousState: latest.state}});
        }
        else {
          const switchable = isAccountSwitchable(null, error);
          if (switchable && !errorQuotaExhausted) disableAccountAfterFailure(selected, null, error);
          if (switchable && tried.size < accounts.length && !accountLockRequired) {
            // Preserve the failed account's evidence before trying another
            // account; otherwise every retry overwrites the prior diagnosis
            // and the final task appears to have no attempt history.
            store.save({...latest, state: "selecting_account", payload: {...latest.payload, attemptHistory}, account_id: selected.id, error: jobError(error)});
            scheduler.release(selected); selected = null; continue;
          }
          store.save({...latest, state: "failed", payload: {...latest.payload, attemptHistory}, account_id: selected.id, error: jobError(error)});
        }
        scheduler.release(selected); selected = null; break;
      }
    }
    const final = store.get(job.id);
    if (final?.state === "selecting_account") {
      store.save({...final, state: "failed", error: {code: "DOUBAO_NO_ACCOUNT_AVAILABLE", message: "没有可用的豆包账号"}});
    } else if (final && tried.size >= accounts.length && ["checking_login", "uploading", "configuring", "submitting", "generating", "downloading"].includes(final.state)) {
      store.save({...final, state: "failed", error: {code: "DOUBAO_ALL_ACCOUNTS_FAILED", message: `已尝试全部 ${accounts.length} 个豆包账号，均未返回视频地址`, attempts: final.payload?.attemptHistory || []}});
    }
  } finally {
    if (selected) scheduler.release(selected);
    running.delete(job.id);
    const final = store.get(job.id);
    // awaiting_login/awaiting_verification 仍可能需要原图恢复任务，其余结束状态立即清理。
    if (final && ["completed", "failed", "submission_unknown"].includes(final.state)) {
      cleanupJobTemp(TEMP_ROOT, final.id);
      const cleaned = scrubJobAssets(final);
      if (JSON.stringify(cleaned.payload?.imageAssets || []) !== JSON.stringify(final.payload?.imageAssets || [])) {
        try { store.save(cleaned); } catch {}
      }
    }
  }
}
async function resumeJob(id) {
  const job = store.get(id);
  if (job?.pendingWatermarkResult) throw Object.assign(new Error("视频已找回，请重试获取无水印或确认采用页面版本；不会重新生成"), {statusCode:409,code:"DOUBAO_WATERMARK_CHOICE_REQUIRED"});
  if (job) taskActions.assertNotManual(job);
  if (taskActions.locks.has(id)) throw Object.assign(new Error("该任务正在执行人工操作，请稍后再试"), {statusCode:409});
  if (job && canConfirm(job)) return (await taskActions.run(id, "continue-confirmation")).job;
  if (!job) throw Object.assign(new Error("任务不存在"), {statusCode: 404});
  if (!["awaiting_login", "awaiting_verification", "paused", "failed", "submission_unknown"].includes(job.state)) throw Object.assign(new Error(`当前任务状态不支持恢复：${job.state}`), {statusCode: 409});
  if ((job.error?.code==="DOUBAO_ASSET_AUTHORIZATION_REQUIRED" || /DOUBAO_CONFIRMATION_/.test(job.error?.code||"")) && !job.payload?.conversationId) throw Object.assign(new Error("请先处理原页面并核对任务；缺少原会话信息，不能自动重新提交"),{statusCode:409,code:"DOUBAO_SUBMISSION_CONTEXT_MISSING"});
  if (job.state === "submission_unknown" && !job.payload?.conversationId) throw Object.assign(new Error("该任务没有可核对的豆包会话证据，禁止自动恢复以避免重复生成"), {statusCode: 409, code: "DOUBAO_SUBMISSION_CONTEXT_MISSING"});
  if (running.has(job.id) || waiting.has(job.id)) throw Object.assign(new Error("该任务已经在队列中，不能重复恢复"), {statusCode: 409});
  // Older builds marked a live video as failed when its card echoed the prompt.
  // Recover that exact conversation; never spend another generation on retry.
  const misclassifiedSubmission = job.state === "failed" && hasSubmissionEvidence(job) && isAmbiguousPostSubmissionError(job.error);
  const resumeExisting = job.state === "awaiting_verification" || job.state === "submission_unknown" || misclassifiedSubmission;
  if (!resumeExisting && (job.payload?.imageAssets || []).some(asset => {
    try { return !asset?.path || !fs.statSync(asset.path).isFile(); } catch { return true; }
  })) throw Object.assign(new Error("原任务参考图片已清理或不存在，请重新上传图片并创建新任务；本次未重新提交生成"), {statusCode: 409, code: "DOUBAO_REFERENCE_REUPLOAD_REQUIRED"});
    const evidence = job.result?.submittedEvidence || job.payload?.submittedEvidence || {};
    const payload = {...job.payload, preferredAccountId: job.account_id || "", accountLockRequired: resumeExisting, resumeExisting, confirmPending: false, conversationId: job.result?.conversationId || job.payload?.conversationId || evidence.conversationId || "", userMessageId: String(job.payload?.userMessageId || evidence.userMessageId || ""), submittedAt: String(job.payload?.submittedAt || evidence.submittedAt || "")};
  scheduler.enable(job.account_id);
  const reset = store.save({...job, state: "queued", payload, error: null});
  scheduleJob(reset);
  return reset;
}
async function recoverExistingResult(id, input = {}) {
  return (await taskActions.run(id, "recover-result", input)).job;
}
async function refreshJobUrls(id) {
  const job = store.get(id);
  if (!job) throw Object.assign(new Error("任务不存在"), {statusCode: 404});
  if (job.state !== "completed" || !job.account_id) throw Object.assign(new Error("只有已完成且保留账号信息的任务支持刷新地址"), {statusCode: 409});
  const account = accounts.find(item => item.id === job.account_id);
  if (!account) throw Object.assign(new Error("任务绑定的账号已不存在"), {statusCode: 409});
  taskActions.assertNotManual(job);
  if (scheduler.busy.has(account.id)) throw Object.assign(new Error("原账号正在执行操作，请稍后刷新地址"), {statusCode:409});
  scheduler.busy.add(account.id);
  try {const result = await worker.refreshUrls({...job, account}); return store.save({...job, result});}
  finally {scheduler.release(account);}
}
function accountView(account) {
  const status = scheduler.status(account.id)[0] || {};
  const quota = currentAccountQuota(account);
  return {...status, ...quota, manualControl: taskActions.accountHeld(account.id), name: account.name, platform: account.platform, loginState: loginStates.get(account.id) || account.loginState || "unknown", membershipState: account.membershipState || "unknown", membershipLabel: account.membershipLabel || "", membershipSource: account.membershipSource || "", membershipCheckedAt: account.membershipCheckedAt || ""};
}
function saveDetectedAccountState(account, detected) {
  const state = detected?.verificationRequired ? "verification" : detected?.loggedIn ? "logged_in" : "not_logged_in";
  let saved = accountStore.setLoginState(account.id, state) || account;
  // An inconclusive/new logged-out check must not keep an old plan as current.
  saved = accountStore.setMembership(account.id, detected?.loggedIn ? detected : {}) || saved;
  return saved;
}
function reloadAccounts() {
  accounts = accountStore.list();
  scheduler.replaceAccounts(accounts);
  dispatchJobs();
  return accounts;
}
async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`); const parts = url.pathname.split("/").filter(Boolean);
  if (req.method === "POST" && url.pathname === "/api/v1/license/activate") {
    if (!/^application\/json(?:;|$)/i.test(String(req.headers["content-type"] || ""))) return json(res, 415, {error: "请使用 JSON 提交设备密钥"});
    const origin = req.headers.origin;
    if (origin && origin !== "null" && origin !== "http://127.0.0.1:8787") return json(res, 403, {error: "不允许跨站激活"});
    const input = JSON.parse((await readBody(req, 8192)).toString("utf8"));
    const activated = await activateLicense(input?.secret);
    return json(res, activated.valid ? 200 : 400, {ok: activated.valid, license: activated, ...(!activated.valid ? {code: activated.code, error: activated.message} : {})});
  }
  const license = await checkLicense({force: url.pathname === "/api/v1/license/status" && url.searchParams.get("refresh") === "1"});
  if (req.method === "GET" && url.pathname === "/api/v1/license/status") return json(res, 200, license);
  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, {ok: true, licensed: license.valid, license: license.valid ? license : {code: license.code, message: license.message}, service: "doubao-video-service", pid: process.pid, workerMode: process.env.DOUBAO_WORKER_RPC === "1" ? "electron-ipc" : "local", accounts: scheduler.status(), queue: {active: running.size, waiting: waiting.size, capacity: executionCapacity(), max: maxQueueSize}});
  if (!license.valid) return json(res, 403, {error: license.message, code: license.code, license});
  if (browserRehearsalActive && req.method !== "GET") return json(res, 409, {error: "真实页面预演进行中，请待测试结束后操作", code: "DOUBAO_REHEARSAL_BUSY"});
  if (req.method === "POST" && url.pathname === "/api/v1/diagnostics/browser-rehearsal") {
    const input = JSON.parse((await readBody(req, 8192)).toString("utf8") || "{}");
    const count = Number(input.accounts ?? 4);
    if (!Number.isInteger(count) || count < 1 || count > 10) return json(res, 400, {error: "accounts 必须为 1 到 10 的整数"});
    if (browserRehearsalActive || running.size || waiting.size || scheduler.busy.size) return json(res, 409, {error: "请等待当前任务完成后再运行页面预演"});
    const selected = accounts.filter(a => a.loginState === "logged_in").slice(0, count);
    if (selected.length < count) return json(res, 400, {error: `需要 ${count} 个已登录账号，当前只有 ${selected.length} 个`});
    const payload = normalizedPayload({prompt: "页面预演测试：一只橘猫坐在窗边。本段仅填写，不发送。", model: input.model, ratio: input.ratio || "16:9", duration: input.duration ?? 4});
    browserRehearsalActive = true;
    selected.forEach(a => scheduler.busy.add(a.id));
    try { return json(res, 200, await worker.rehearseBrowsers(selected, {...payload, doubaoModel: payload.model})); }
    finally { selected.forEach(a => scheduler.release(a)); browserRehearsalActive = false; dispatchJobs(); }
  }
  if (req.method !== "GET" && parts.slice(0,3).join("/") === "api/v1/accounts" && taskActions.accountHeld(parts[3])) return json(res,409,{error:"原账号处于人工接管，请先结束接管",code:"DOUBAO_MANUAL_CONTROL_ACTIVE"});
  if (req.method === "GET" && url.pathname === "/api/v1/accounts") { reconcilePersistedQuotaCooldowns(); return json(res, 200, {accounts: accounts.map(accountView)}); }
  if(req.method==="POST"&&parts.length===5&&parts.slice(0,3).join("/")==="api/v1/accounts"&&parts[4]==="check-generation") {
    const account=accounts.find(a=>a.id===parts[3]);
    if(!account) return json(res,404,{error:"账号不存在"});
    if(scheduler.busy.has(account.id)) return json(res,409,{error:"账号正在执行任务，请在结束后检查"});
    scheduler.busy.add(account.id);
    try {
      const result=await worker.checkGeneration(account);
      if(result.ok) recordGenerationHealth(account,null,"manual-check");
      return json(res,result.ok?200:409,{...result,...(!result.ok?{error:result.message}:{}),account:accountView(accounts.find(a=>a.id===account.id)||account)});
    } catch(error) {return json(res,409,{error:error.message,code:error.code||"DOUBAO_GENERATION_CHECK_FAILED"});}
    finally {scheduler.release(account);}
  }
  if (req.method === "POST" && url.pathname === "/api/v1/accounts") {
    readBody(req, 256 * 1024).then(body => {
      let input = {}; try { input = body.length ? JSON.parse(body.toString("utf8")) : {}; } catch { throw Object.assign(new Error("请求体必须是 JSON"), {statusCode: 400}); }
      const account = accountStore.add({name: input.name}); reloadAccounts(); loginStates.set(account.id, "not_logged_in"); json(res, 201, {account: accountView(account)});
    }).catch(error => json(res, Number(error.statusCode || 500), {error: error.message})); return;
  }
  if (req.method === "PATCH" && parts.length === 4 && parts[0] === "api" && parts[1] === "v1" && parts[2] === "accounts") {
    const id = parts[3]; readBody(req, 256 * 1024).then(body => {
      let input = {}; try { input = body.length ? JSON.parse(body.toString("utf8")) : {}; } catch { throw Object.assign(new Error("请求体必须是 JSON"), {statusCode: 400}); }
      let account = accountStore.list().find(item => item.id === id);
      if (!account) throw Object.assign(new Error("账号不存在"), {statusCode: 404});
      if (input.resetQuotaExhaustion === true) {
        if (scheduler.busy.has(id)) throw Object.assign(new Error("账号正在执行任务，暂不能重置额度限制"), {statusCode: 409});
        account = accountStore.clearQuotaExhaustion(id);
      }
      if (input.name !== undefined) account = accountStore.rename(id, input.name);
      if (input.dailyQuotaLimit !== undefined || input.quotaUsedToday !== undefined || input.miniCost !== undefined || input.fastCost !== undefined) {
        const current = currentAccountQuota(account);
        const limit = input.dailyQuotaLimit === undefined ? current.dailyQuotaLimit : Math.max(0, Math.floor(Number(input.dailyQuotaLimit) || 0));
        const used = input.quotaUsedToday === undefined ? current.quotaUsedToday : Math.max(0, Number(input.quotaUsedToday) || 0);
        const miniCost = input.miniCost === undefined ? current.miniCost : Math.max(1, Math.floor(Number(input.miniCost) || 1));
        const fastCost = input.fastCost === undefined ? current.fastCost : Math.max(1, Math.floor(Number(input.fastCost) || 1));
        account = accountStore.updateQuota(id, {dailyQuotaLimit: limit, miniCost, fastCost, quotaAdjustment: used - current.quotaRecordedToday, quotaAdjustmentDay: beijingDay()});
      }
      reloadAccounts(); json(res, 200, {account: accountView(account)});
    }).catch(error => json(res, Number(error.statusCode || 500), {error: error.message})); return;
  }
  if (req.method === "DELETE" && parts.length === 4 && parts[0] === "api" && parts[1] === "v1" && parts[2] === "accounts") {
    const id = parts[3]; if (scheduler.status().some(item => item.id === id && item.busy)) return json(res, 409, {error: "账号正在执行任务，暂时不能删除"});
    if (!accountStore.remove(id)) return json(res, 404, {error: "账号不存在"}); reloadAccounts(); loginStates.delete(id); return json(res, 200, {ok: true, accountId: id});
  }
  if (req.method === "GET" && url.pathname === "/api/v1/video/jobs") {
    const all = store.recentJobs(100000), today = all.filter(j => beijingDay(Date.parse(j.created_at)) === beijingDay());
    const attention = j => j.manualControl?.active || !!j.pendingWatermarkResult || (j.state !== "completed" && !!j.resultReview?.candidates?.length) || ["submission_unknown","awaiting_login","awaiting_verification","paused"].includes(j.state);
    return json(res, 200, {jobs: all.slice(0,500).map(publicJob), total: all.length, summary: {queued: all.filter(j=>j.state==="queued").length, active: running.size, attention: all.filter(attention).length, todayCompleted: today.filter(j=>j.state==="completed").length, todayCalls: today.length}});
  }
  if (req.method === "POST" && parts.length === 6 && parts.slice(0,4).join("/") === "api/v1/video/jobs" && ["open-session","takeover","end-takeover","recheck","continue-confirmation"].includes(parts[5])) {
    try { const value=await taskActions.run(parts[4],parts[5]); return json(res,200,{job:jobDetail(value.job),result:value.result}); }
    catch(error) { return json(res,Number(error.statusCode||500),errorBody(error)); }
  }
  if (req.method === "POST" && parts.length === 5 && parts[0] === "api" && parts[1] === "v1" && parts[2] === "accounts" && parts[4] === "login") {
    const account = accounts.find(item => item.id === parts[3]); if (!account) return json(res, 404, {error: "账号不存在"});
    worker.open(account).then(async result => {
      // Opening an existing session must not remove a logged-in account from
      // scheduling. Probe the actual page instead of unconditionally resetting it.
      let detected;
      try { detected = result?.loginChecked ? result : await worker.detect(account); }
      catch (error) {
        loginStates.set(account.id, "unknown"); accountStore.setLoginState(account.id, "unknown"); reloadAccounts();
        return json(res, 502, {error: `窗口已打开，但登录检测失败：${error.message}`, account: accountView(accounts.find(item => item.id === account.id) || account)});
      }
      const state = detected.verificationRequired ? "verification" : detected.loggedIn ? "logged_in" : "not_logged_in";
      loginStates.set(account.id, state); const saved = saveDetectedAccountState(account, detected); reloadAccounts();
      json(res, 200, {ok: true, accountId: account.id, account: accountView(saved || account), message: state === "logged_in" ? "已打开豆包窗口，账号已登录" : state === "verification" ? "已打开豆包窗口，请完成验证" : "已打开豆包窗口，请完成登录", result: {...result, ...detected}});
    }).catch(error => json(res, error.code === "DOUBAO_BROWSER_OPEN_SUPERSEDED" ? 409 : 500, {error: error.message, code: error.code})); return;
  }
  if (req.method === "POST" && parts.length === 5 && parts[0] === "api" && parts[1] === "v1" && parts[2] === "accounts" && parts[4] === "check-login") {
    const account = accounts.find(item => item.id === parts[3]); if (!account) return json(res, 404, {error: "账号不存在"});
    worker.detect(account).then(result => { const state = result.loggedIn && !result.verificationRequired ? "logged_in" : result.verificationRequired ? "verification" : "not_logged_in"; loginStates.set(account.id, state); const saved = saveDetectedAccountState(account, result); reloadAccounts(); json(res, 200, {account: accountView(saved || account), result}); }).catch(error => { loginStates.set(account.id, "unknown"); const saved = accountStore.setLoginState(account.id, "unknown"); reloadAccounts(); json(res, 502, {error: error.message, account: accountView(saved || account)}); }); return;
  }
  if (req.method === "GET" && parts.length === 5 && parts[0] === "api" && parts[1] === "v1" && parts[2] === "video" && parts[3] === "jobs") {
    const job = store.get(parts[4]); return job ? json(res, 200, jobDetail(job)) : json(res, 404, {error: "任务不存在"});
  }
  if (req.method === "POST" && parts.length === 6 && parts[0] === "api" && parts[1] === "v1" && parts[2] === "video" && parts[3] === "jobs" && ["recover-result","retry-watermark","accept-page-result"].includes(parts[5])) {
    try {
      const raw = (await readBody(req,8192)).toString("utf8");
      let input; try {input=JSON.parse(raw || "{}");} catch {return json(res,400,{error:"补取参数不是有效JSON"});}
      if (!input || typeof input !== "object" || Array.isArray(input) || [input.candidateId,input.reviewId].some(value => value !== undefined && typeof value !== "string")) return json(res,400,{error:"视频选择参数无效"});
      if (input.acceptWatermarked !== undefined && typeof input.acceptWatermarked !== "boolean") return json(res,400,{error:"页面版本采用确认参数无效"});
      const value=await taskActions.run(parts[4],parts[5],input);
      return json(res,value.job.state === "queued" ? 202 : 200,{...jobDetail(value.job),recoveryFeedback:value.result});
    } catch(error) {return json(res,Number(error.statusCode || 500),errorBody(error));}
  }
  if (req.method === "POST" && parts.length === 6 && parts[0] === "api" && parts[1] === "v1" && parts[2] === "video" && parts[3] === "jobs" && parts[5] === "resume") {
    resumeJob(parts[4]).then(job => json(res, 202, publicJob(job))).catch(error => json(res, Number(error.statusCode || 500), errorBody(error))); return;
  }
  if (req.method === "POST" && parts.length === 6 && parts[0] === "api" && parts[1] === "v1" && parts[2] === "video" && parts[3] === "jobs" && parts[5] === "refresh-url") {
    refreshJobUrls(parts[4]).then(job => json(res, 200, publicJob(job))).catch(error => json(res, Number(error.statusCode || 500), {error: error.message})); return;
  }
  if (req.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "v1" && parts[2] === "video" && parts[3] === "generate") {
    const id = requestId();
    parseRequest(req, id).then(async input => {
      const normalized = normalizedPayload(input);
      if (normalized.preferredAccountId && !accounts.some(account => account.id === normalized.preferredAccountId)) throw Object.assign(new Error(`指定的豆包账号不存在：${normalized.preferredAccountId}`), {statusCode: 400, code: "DOUBAO_ACCOUNT_NOT_FOUND"});
      if (running.size + waiting.size >= maxQueueSize) throw Object.assign(new Error(`任务队列已满，当前最多接收 ${maxQueueSize} 个任务，请稍后重试`), {statusCode: 429, code: "DOUBAO_QUEUE_FULL"});
      await requireLicense();
      // License verification may have yielded while another request filled
      // the queue. Check again before persisting an accepted job.
      if (browserRehearsalActive) throw Object.assign(new Error("真实页面预演进行中，请待测试结束后生成"), {statusCode: 409, code: "DOUBAO_REHEARSAL_BUSY"});
      if (running.size + waiting.size >= maxQueueSize) throw Object.assign(new Error("任务队列已满，请稍后重试"), {statusCode: 429, code: "DOUBAO_QUEUE_FULL"});
      const job = store.create(id, normalized);
      scheduleJob(job);
      const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const wait = String(requestUrl.searchParams.get("wait") || "") === "1";
      if (!wait) return json(res, 202, publicJob(job));
      // 默认一直等待到豆包明确完成或失败；只有调用方显式传 waitTimeoutMs
      // 才启用 HTTP 连接的等待上限，该上限不会改变任务本身状态。
      const waitTimeoutMs = Math.max(0, Number(requestUrl.searchParams.get("waitTimeoutMs") || 0));
      const deadline = waitTimeoutMs > 0 ? Date.now() + waitTimeoutMs : Number.POSITIVE_INFINITY;
      const timer = setInterval(() => {
        const current = store.get(id);
        if (!current) { clearInterval(timer); return json(res, 404, {error: "任务不存在"}); }
        if (terminalState(current.state) || Date.now() > deadline) {
          clearInterval(timer);
          if (Date.now() > deadline && !terminalState(current.state)) return json(res, 504, publicJob({...current, error: {code: "DOUBAO_HTTP_WAIT_TIMEOUT", message: "HTTP 等待超时，豆包任务仍在继续；请通过任务查询接口继续查看"}}));
          json(res, current.state === "completed" ? 200 : 409, publicJob(current));
        }
      }, 500);
      res.once("close", () => clearInterval(timer));
    }).catch(error => { cleanupJobTemp(TEMP_ROOT, id); json(res, Number(error.statusCode || 500), errorBody(error)); });
    return;
  }
  return json(res, 404, {error: "接口不存在"});
}
const server = http.createServer((req, res) => route(req, res).catch(error => {
  if (!res.headersSent) json(res, error instanceof SyntaxError ? 400 : Number(error.statusCode || 500), {error: error instanceof SyntaxError ? "请求 JSON 格式无效" : "请求处理失败", ...(error.code ? {code: error.code} : {})});
}));
function shutdown() { server.close(); worker.close(); store.close(); process.exit(0); }
require("./lan-listener.cjs").attachLanListener(server, process.env.DOUBAO_LAN_ADDRESS || "");
process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);

let recoveryInitialized=false;
function initializeRecovery() {
  if(recoveryInitialized) return {recovered:0,scheduled:0};
  const recovered=recoverInterruptedJobs();
  reconcilePersistedQuotaCooldowns();
  const scheduled=scheduleRecoveredJobs();
  recoveryInitialized=true;
  dispatchJobs();
  return {recovered,scheduled};
}

if (require.main === module) {
  const recovery = initializeRecovery();
  server.listen(PORT, HOST, () => {
    console.log(`豆包视频服务已启动：http://${HOST}:${PORT}（已核对 ${recovery.recovered} 个任务，重新调度 ${recovery.scheduled} 个）`);
  });
}

module.exports = {initializeRecovery, server, executeJob, scheduleJob, scheduleRecoveredJobs, dispatchJobs, normalizedPayload, extractRemoteImageUrls, assertSafeRemoteImageUrl, detectImageType, downloadRemoteImage, materializeRemoteImages, resumeJob, recoverExistingResult, refreshJobUrls, recoverInterruptedJobs, reconcilePersistedQuotaCooldowns, withTimeout, isResultWaitTimeout, queueResultRecovery, hasVideoResult, publicJob, errorBody, jobError, hasSubmissionEvidence, isAmbiguousPostSubmissionError, shouldPreserveSubmittedJob, canRecoverExistingResult, isAccountSwitchable, isPreSubmissionFailure, isQuotaExhausted, nextBeijingMidnight};

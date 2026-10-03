"use strict";
const {randomUUID} = require("node:crypto");

function contextOf(job) {
  const p = job?.payload || {}, e = p.submittedEvidence || job?.result?.submittedEvidence || {};
  const ids = [p.conversationId, job?.result?.conversationId, e.conversationId, job?.error?.conversationId].filter(Boolean).map(String);
  const conversationId = ids[0] || "";
  const accountId = String(job?.account_id || (p.accountLockRequired ? p.preferredAccountId : "") || "");
  return {accountId, conversationId, valid: Boolean(accountId && /^\d{5,30}$/.test(conversationId) && ids.every(id => id === conversationId)), userMessageId: String(p.userMessageId || e.userMessageId || ""), submittedAt: p.submittedAt || e.submittedAt || ""};
}
function canConfirm(job) {
  const error = job?.error || {}, diagnostic = error.monitorDiagnostic?.confirmation || error.originalError?.monitorDiagnostic?.confirmation;
  return contextOf(job).valid && !job.manualControl?.active && !job.payload?.confirmationAttempt &&
    ["submission_unknown", "awaiting_verification"].includes(job.state) &&
    !error.quotaExhausted && !error.providerTerminal && !error.submittedVerified &&
    !diagnostic?.delivery?.delivered && !job.payload?.submittedEvidence?.confirmed &&
    ["DOUBAO_CONFIRMATION_INPUT_NOT_READY", "DOUBAO_CONFIRMATION_SEND_FAILED", "DOUBAO_CONFIRMATION_QUEUED", "DOUBAO_VIDEO_TASK_NOT_CREATED"].includes(error.code) && diagnostic?.detected === true;
}
const actionError = (message, code = "DOUBAO_TASK_ACTION_CONFLICT", statusCode = 409) => Object.assign(new Error(message), {code, statusCode});
const videoUrl = value => {try {return ["http:","https:"].includes(new URL(value).protocol);} catch {return false;}};
function watermarkStatus(job) {
  const output = job.pendingWatermarkResult?.output || job.result;
  return {videoFound:videoUrl(output?.watermarkFreeUrl) || videoUrl(output?.watermarkedUrl), watermarkFreeObtained:videoUrl(output?.watermarkFreeUrl), pageVersionPending:!!job.pendingWatermarkResult, pageVersionAccepted:!!output?.pageVersionAcceptedAt};
}

class TaskActions {
  constructor({store, scheduler, worker, accounts, running, waiting, scheduleJob, canRecover}) {
    Object.assign(this, {store, scheduler, worker, accounts, running, waiting, scheduleJob, canRecover});
    this.locks = new Set();
    this.manual = new Map();
    for (const job of store.recentJobs(100000)) if (job.manualControl?.active && contextOf(job).accountId) {
      this.manual.set(contextOf(job).accountId, job.id);
      scheduler.busy.add(contextOf(job).accountId);
    }
  }
  accountHeld(id) { return this.manual.has(id); }
  assertNotManual(job) { if (this.accountHeld(contextOf(job).accountId)) throw actionError("原账号处于人工接管，请先结束接管并核对"); }
  get(id) {
    const job = this.store.get(id);
    if (!job) throw actionError("任务不存在", "DOUBAO_TASK_NOT_FOUND", 404);
    return job;
  }
  binding(job) {
    const context = contextOf(job);
    if (!context.valid) throw actionError("尚未关联可核对的原账号与豆包会话，请查看详情；不会猜测或替换会话", "DOUBAO_SUBMISSION_CONTEXT_MISSING");
    const account = this.accounts().find(a => a.id === context.accountId);
    if (!account) throw actionError("原账号已不存在，不能替换其他账号打开任务", "DOUBAO_ORIGINAL_ACCOUNT_MISSING");
    return {...context, account};
  }
  isActive(job) { return this.running.has(job.id) || this.waiting.has(job.id); }
  recoverable(job) { return job.state !== "completed" && (this.canRecover(job) || !!job.manualControl?.startedAt || !!job.resultReview?.candidates?.length); }
  flags(job) {
    const c = contextOf(job), exists = this.accounts().some(a => a.id === c.accountId);
    const manual = this.manual.get(c.accountId), busy = this.scheduler.busy.has(c.accountId), active = this.isActive(job);
    const ready = c.valid && exists;
    return {canOpen: ready, canTakeover: ready && !active && (!busy || manual === job.id), canEndTakeover: manual === job.id,
      canRecheck: ready && !busy && !active, canConfirm: ready && !busy && !active && canConfirm(job),
      canRecover: ready && !busy && !active && this.recoverable(job),
      canRetryWatermark: ready && !busy && !manual && !active && watermarkStatus(job).videoFound && !watermarkStatus(job).watermarkFreeObtained,
      canAcceptPageResult: ready && !busy && !manual && !active && !!job.pendingWatermarkResult,
      reason: !c.valid ? "尚未关联豆包会话" : !exists ? "原账号已不存在" : manual ? "原账号处于人工接管" : busy || active ? "自动操作进行中；可只读查看，结束后可接管" : ""};
  }
  record(job, action, status, message = "") {
    const latest = this.get(job.id);
    return this.store.save({...latest, actionHistory: [...(latest.actionHistory || []), {action, status, message, at: new Date().toISOString()}].slice(-100)});
  }
  saveRecoveredResult(job, output, evidence) {
    const latest = this.get(job.id), at = new Date().toISOString();
    return this.store.save({...latest,state:"completed",error:null,result:output,lastRecoveryError:null,lastWatermarkError:null,resultReview:null,pendingWatermarkResult:null,payload:{...latest.payload,timings:{...latest.payload?.timings,providerCompletedAt:output.recoveredAt || at,resultReturnedAt:at}},resultRecoveryHistory:[...(latest.resultRecoveryHistory || []),evidence].slice(-30)});
  }
  pendingWatermarkFeedback(job) {
    return {job,result:{message:"视频已找回，无水印尚未取得。可重试获取无水印，或确认采用页面版本（可能带水印）。",needsWatermarkChoice:true,needsAttention:true}};
  }
  async run(id, action, input = {}) {
    if (this.locks.has(id)) throw actionError("该任务的操作正在执行，请勿重复点击");
    this.locks.add(id);
    let reserved = false, account;
    try {
      let job = this.get(id); const binding = this.binding(job); account = binding.account;
      if (action === "recover-result" && job.state === "completed") return {job, result:{message:"原任务已有视频结果，无需重复补取"}};
      let selection;
      if (action === "recover-result" && (input.candidateId || input.reviewId)) {
        selection = job.resultReview?.candidates?.find(item => item.id === input.candidateId);
        if (action !== "recover-result" || !selection || input.reviewId !== job.resultReview.id || job.resultReview.accountId !== binding.accountId || job.resultReview.conversationId !== binding.conversationId) throw actionError("候选列表已更新，请重新核对后选择", "DOUBAO_RESULT_SELECTION_STALE");
      }
      const owner = this.manual.get(account.id);
      if (action === "open-session") {
        const result = await this.worker.openTask({...job, account, taskContext: binding});
        this.record(job, action, "completed"); return {job: this.get(id), result};
      }
      if (action === "end-takeover" && owner !== id) throw actionError("该任务当前没有人工接管");
      if (this.isActive(job) || (this.scheduler.busy.has(account.id) && owner !== id)) throw actionError("原账号正在自动操作，暂不能接管或核对；请先只读查看");
      if (owner && (owner !== id || !["takeover", "end-takeover"].includes(action))) throw actionError("请先结束原任务的人工接管");
      this.scheduler.busy.add(account.id); reserved = !owner;
      if (action === "takeover") {
        this.manual.set(account.id, id);
        job = this.store.save({...job, manualControl: {active: true, startedAt: job.manualControl?.startedAt || new Date().toISOString()}});
        // Keep the lease even if opening fails; the user can retry opening or end it explicitly.
        reserved = false;
        const result = await this.worker.takeoverTask({...job, account, taskContext: binding});
        this.record(job, action, "completed"); return {job: this.get(id), result};
      }
      if (["retry-watermark","accept-page-result"].includes(action)) {
        const pending = job.pendingWatermarkResult, original = pending?.output || job.result;
        if (!watermarkStatus(job).videoFound || (pending && (pending.accountId !== account.id || pending.conversationId !== binding.conversationId))) throw actionError("没有绑定到原任务的可处理视频", "DOUBAO_RESULT_BINDING_INVALID");
        if (action === "accept-page-result") {
          if (input.acceptWatermarked !== true) throw actionError("请明确确认采用页面版本，该版本可能带水印");
          if (!pending || input.reviewId !== pending.id) throw actionError("待采用的视频已更新，请重新查看后确认", "DOUBAO_RESULT_SELECTION_STALE");
          const output = {...original,pageVersionAcceptedAt:new Date().toISOString()};
          job = this.saveRecoveredResult(job,output,pending.evidence);
          const message = "已按确认采用页面版本（可能带水印）并保存到原任务";
          this.record(job,action,"completed",message);return {job:this.get(id),result:{message}};
        }
        if (videoUrl(original.watermarkFreeUrl)) return {job,result:{message:"无水印已取得，无需重复获取"}};
        const output = await this.worker.retryWatermarkFree({...job,account,taskContext:binding,result:original});
        if (!videoUrl(output?.watermarkFreeUrl) || output?.ok !== true || output.state !== "completed" || output.conversationId !== binding.conversationId || (original.videoVid && output.videoVid !== original.videoVid) || output.resultMessageId !== original.resultMessageId) throw actionError("无水印结果与原视频绑定校验失败，已保留原结果", "DOUBAO_RESULT_BINDING_INVALID");
        job = pending ? this.saveRecoveredResult(job,output,pending.evidence) : this.store.save({...this.get(id),result:output,lastWatermarkError:null});
        const message = "无水印已取得并更新原任务；创作平台若已下载旧版本，需要在平台更新素材";
        this.record(job,action,"completed",message);return {job:this.get(id),result:{message}};
      }
      if (action === "continue-confirmation") {
        if (!canConfirm(job)) throw actionError("没有尚未送达的普通确认依据；请重新核对，不会重复发送");
        // Durable single attempt: a restart or repeated request cannot send again.
        job = this.store.save({...job, payload: {...job.payload, confirmationAttempt: {at: new Date().toISOString(), source: "task-action"}}});
        this.record(job, action, "accepted");
        return {job: this.enqueueExisting(this.get(id), binding, true)};
      }
      if (!["recheck", "end-takeover", "recover-result"].includes(action)) throw actionError("不支持的任务操作");
      if (action === "recover-result" && !this.recoverable(job)) throw actionError("请先在原会话人工处理并结束接管，再核对已有视频", "DOUBAO_RESULT_RECOVERY_CONTEXT_MISSING");
      if (action === "end-takeover") {
        // Freeze user input before the first browser probe. A failure retains the lease.
        await this.worker.freezeTakeover({...job, account, taskContext: binding});
      }
      if (job.pendingWatermarkResult) {
        if (action === "end-takeover") {
          this.manual.delete(account.id);reserved=true;
          job=this.store.save({...job,manualControl:{...job.manualControl,active:false,endedAt:new Date().toISOString()}});
        }
        return this.pendingWatermarkFeedback(job);
      }
      const result = await this.worker.inspectTask({...job, account, taskContext: binding});
      if (action === "end-takeover") {
        this.manual.delete(account.id); reserved = true;
        job = this.store.save({...this.get(id), manualControl: {...job.manualControl, active: false, endedAt: new Date().toISOString()}});
      }
      if (job.state !== "completed" && result.conversationMatches && result.candidates?.some(item => item.ready)) {
        const candidates = result.candidates.filter(item => item.ready);
        const chosen = selection ? candidates.find(item => item.id === selection.id && item.fingerprint === selection.fingerprint && !item.ambiguous) : candidates.length === 1 && candidates[0].anchored && !candidates[0].ambiguous ? candidates[0] : null;
        if (selection && !chosen) throw actionError("所选视频已变化或不在原会话，请重新核对后选择", "DOUBAO_RESULT_SELECTION_STALE");
        const at = new Date().toISOString();
        job = this.store.save({...this.get(id), lastRecoveryError:null, lastReview:{at,...result}, resultReview:{id:randomUUID(),at,conversationId:binding.conversationId,accountId:account.id,candidates}});
        if (chosen) {
          const output = await this.worker.recoverTaskResult({...job,account,taskContext:binding}, chosen);
          const urls = [output?.watermarkFreeUrl, output?.watermarkedUrl];
          const valid = urls.some(value => {try {return ["http:","https:"].includes(new URL(value).protocol);} catch {return false;}});
          if (!valid || output?.ok !== true || output.state !== "completed" || output.conversationId !== binding.conversationId || output.resultMessageId !== chosen.messageId) throw actionError("结果地址或原会话绑定校验失败，未写回任务", "DOUBAO_RESULT_BINDING_INVALID");
          const latest = this.get(id);
          const evidence = {at:new Date().toISOString(),accountId:account.id,conversationId:binding.conversationId,originalUserMessageId:binding.userMessageId,resultMessageId:chosen.messageId,candidateId:chosen.id,selectedBy:selection?"user":"unique-bound-result",previousState:job.state,previousError:job.error || null};
          if (!videoUrl(output.watermarkFreeUrl)) {
            job=this.store.save({...latest,state:"paused",resultReview:null,pendingWatermarkResult:{id:randomUUID(),accountId:account.id,conversationId:binding.conversationId,output,evidence},lastWatermarkError:{at,code:"DOUBAO_WATERMARK_FREE_UNAVAILABLE",message:output.watermarkFreeError || "尚未取得可确认的无水印地址"}});
            const feedback=this.pendingWatermarkFeedback(job);this.record(job,action,"needs_attention",feedback.result.message);return {...feedback,job:this.get(id)};
          }
          job = this.saveRecoveredResult(job,output,evidence);
          const message = "视频已找回，无水印已取得并保存到原任务；创作平台同步状态请在平台核对";
          this.record(job,action,"completed",message);
          return {job:this.get(id),result:{message}};
        }
        const message = candidates.length > 1 ? "发现多个视频，请在任务详情选择需要回传的视频" : "已找到视频，但原消息未能可靠关联；请在任务详情确认采用此视频";
        this.record(job,action,"needs_selection",message);
        return {job:this.get(id),result:{message,needsSelection:true}};
      }
      if (selection) throw actionError("所选视频已不在当前候选列表，请重新核对", "DOUBAO_RESULT_SELECTION_STALE");
      job = this.store.save({...this.get(id), resultReview:null, lastRecoveryError:null});
      job = this.applyInspection(job, result, binding);
      const needsAttention = job.state !== "completed" && job.state !== "queued";
      const message = job.state === "queued" ? "已恢复原任务只读监听；未发送生成消息" : job.state === "completed" ? "原任务已有视频结果" : job.error?.message || result.message || "未发现可补取的视频";
      this.record(job, action, needsAttention ? "needs_attention" : "completed", message);
      return {job: this.get(id), result:{...result,message,needsAttention}};
    } catch (error) {
      if (action === "retry-watermark" && this.store.get(id)) this.store.save({...this.get(id),lastWatermarkError:{at:new Date().toISOString(),code:error.code || "DOUBAO_WATERMARK_FREE_UNAVAILABLE",message:error.message}});
      if (["recover-result","end-takeover","recheck"].includes(action) && this.store.get(id)) this.store.save({...this.get(id),lastRecoveryError:{at:new Date().toISOString(),code:error.code || "DOUBAO_RECOVERY_FAILED",message:error.message}});
      if (this.store.get(id)) this.record(this.get(id), action, "failed", error.message);
      throw error;
    } finally {
      if (reserved && account) this.scheduler.release(account);
      this.locks.delete(id);
    }
  }
  enqueueExisting(job, c, confirmPending = false) {
    const next = this.store.save({...job, state: "queued", error: null, payload: {...job.payload, preferredAccountId: c.accountId, accountLockRequired: true, conversationId: c.conversationId, userMessageId: c.userMessageId, submittedAt: c.submittedAt, resumeExisting: true, confirmPending, imageAssets: []}, recovery: {at: new Date().toISOString(), mode: confirmPending ? "continue_confirmation_once" : "inspect_existing_result", previousState: job.state, previousError: job.error}});
    this.scheduleJob(next); return next;
  }
  applyInspection(job, probe, c) {
    const latest = this.get(job.id), review = {at: new Date().toISOString(), ...probe};
    if (latest.state === "completed") return this.store.save({...latest, lastReview: review});
    let error, state = "submission_unknown";
    if (!probe.conversationMatches || !probe.matched) error = {code: "DOUBAO_SUBMISSION_CONTEXT_MISSING", message: "未能核对原会话中的任务消息，请人工查看；未发送消息"};
    else if (probe.assetAuthorization) {state = "awaiting_verification"; error = {code: "DOUBAO_ASSET_AUTHORIZATION_REQUIRED", message: "请在原页面处理素材授权后再次核对"};}
    else if (probe.loginRequired || probe.verification) {state = probe.loginRequired ? "awaiting_login" : "awaiting_verification"; error = {code: probe.loginRequired ? "DOUBAO_LOGIN_REQUIRED" : "DOUBAO_VERIFICATION_REQUIRED", message: "请在原账号页面完成登录或验证后核对"};}
    else if (probe.quotaExhausted || (probe.paidQuotaConfirmation && !latest.payload?.allowPaidQuota)) {state = "failed"; error = {code: "DOUBAO_VIDEO_QUOTA_EXHAUSTED", message: probe.message || "豆包要求付费，任务不允许付费；未继续", quotaExhausted: true, safeToRetry: false};}
    else if (probe.providerTerminal) {state = "failed"; error = {...probe.failure, code: probe.failure?.code || "DOUBAO_GENERATION_FAILED", message: probe.failure?.providerMessageRaw || probe.message || "豆包明确返回失败", providerTerminal: true, terminalFailureVerified: true, accountAction: "release"};}
    else if (probe.scopedGenerating || probe.videoTaskCard) return this.enqueueExisting(this.store.save({...latest, lastReview: review}), c, false);
    else if (probe.planningConfirmation && !probe.confirmationDelivered) error = {code: "DOUBAO_VIDEO_TASK_NOT_CREATED", message: "原会话等待普通生成确认", monitorDiagnostic: {confirmation: {detected: true, delivery: {delivered: false}}}};
    else error = {code: probe.confirmationDelivered ? "DOUBAO_CONFIRMATION_DELIVERED_WAITING" : "DOUBAO_SUBMISSION_UNKNOWN", message: probe.confirmationDelivered ? "确认已送达，等待豆包响应；不会重复发送" : "尚无可靠生成或结果证据，请查看原会话"};
    return this.store.save({...latest, state, error: {...error, notSentVerified: false, safeToRetry: false}, lastReview: review});
  }
}
module.exports = {TaskActions, contextOf, canConfirm, watermarkStatus};

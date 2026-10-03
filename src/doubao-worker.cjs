"use strict";

const fs = require("fs");
const path = require("path");
const {BrowserController, normalizeVideoParameters} = require("./source-bridge.cjs");
const {probeExistingVideos} = require("./vendor/existing-video-recovery.cjs");

class DoubaoWorker {
  constructor({profileRoot, tempRoot, sourceRoot, embeddedBrowserProvider = null, onProgress = null}) {
    this.profileRoot = profileRoot;
    this.tempRoot = tempRoot;
    this.closeAfterResult = process.env.DOUBAO_CLOSE_BROWSER_AFTER_RESULT !== "0";
    this.controller = new BrowserController({
      profileRootProvider: () => profileRoot,
      downloadRootProvider: () => path.join(tempRoot, "downloads"),
      browserExe: process.env.DOUBAO_BROWSER_EXE || "",
      embeddedBrowserProvider: embeddedBrowserProvider || (() => globalThis.__doubaoEmbeddedBrowserManager || null),
      testMode: process.env.DOUBAO_TEST_MODE === "1",
    });
    this.onProgress = typeof onProgress === "function" ? onProgress : null;
    this.controller.onProgress = progress => this.reportProgress(progress);
  }
  setProgressHandler(handler) { this.onProgress = typeof handler === "function" ? handler : null; }
  async reportProgress(progress) { if (this.onProgress) await this.onProgress(progress); }
  async open(account) {
    const manager = this.controller.embeddedBrowserProvider?.();
    if (!manager?.open) return this.controller.execute({action: "open", account, id: `open-${account.id}`});
    const opened = await manager.open(account, {focus: true});
    const item = opened.manualActionRequired ? manager.automationSessions.get(account.id) : manager.sessions.get(account.id);
    if (!manager.alive(item)) throw manager.openSuperseded();
    const detected = await manager.detect(account, item);
    return {...opened, ...detected, loginChecked: true};
  }
  async detect(account, {background = false} = {}) {
    if (process.env.DOUBAO_TEST_MODE === "1") return {loggedIn: true, verificationRequired: false, testMode: true};
    const manager = this.controller.embeddedBrowserProvider?.();
    const visible = manager?.sessions?.get(account.id);
    // Opening a visible login page must not create a second hidden page just
    // to check it. Generation continues to use its isolated hidden session.
    if (!background && manager?.alive?.(visible)) return manager.detect(account, visible);
    const release = manager?.retainAutomation?.(account);
    try { return await this.controller.execute({action: "detect", account, id: `detect-${account.id}`}); }
    finally {
      release?.();
      manager?.releaseIdleAutomation?.(account, () => {
        const session = this.controller.sessions?.get(account.id);
        return (!session || session.phase === "idle") && !session?.pendingSubmission;
      }, manager?.alive?.(manager.sessions?.get(account.id)) ? 0 : 10_000);
    }
  }
  async generate(job) {
    // API tasks use one isolated hidden BrowserWindow per account. Retain the
    // automation lease so idle cleanup cannot close a background task while
    // it is submitting or monitoring. Manual account pages remain independent.
    const release = this.controller.embeddedBrowserProvider?.()?.retainAutomation?.(job.account);
    try { return await this.generateInSession(job); }
    finally { release?.(); }
  }
  async generateInSession(job) {
    const account = job.account;
    const params = normalizeVideoParameters({doubaoModel: job.payload.model, ratio: job.payload.ratio, duration: job.payload.duration});
    const resumeExisting = job.payload.resumeExisting === true;
    const submittedEvidence = job.payload.submittedEvidence || {};
    const command = {action: resumeExisting ? "resume_monitor" : "generate", id: job.id, account, payload: {jobId: job.id, prompt: job.payload.prompt, conversationId: job.payload.conversationId || submittedEvidence.conversationId || "", userMessageId: job.payload.userMessageId || submittedEvidence.userMessageId || "", submittedAt: job.payload.submittedAt || submittedEvidence.submittedAt || "", confirmPending: job.payload.confirmPending === true, allowPaidQuota: job.payload.allowPaidQuota === true, doubaoModel: params.model, ratio: params.ratio, duration: params.duration, imageAssets: resumeExisting ? [] : (job.payload.imageAssets || [])}};
    let submitted;
    try {
      submitted = await this.controller.execute(command);
    } catch (error) {
      // A pre-submission page/configuration failure can poison the SPA state.
      // Recreate that account's page before the scheduler tries another account;
      // never close a session whose submission state is already uncertain.
      // Only destroy/recreate a browser context when the controller explicitly
      // proved that nothing was sent. Ambiguous WebContents errors after a
      // send must keep the original context available for result recovery.
      if (error?.code !== "DOUBAO_ASSET_AUTHORIZATION_REQUIRED" && (error?.notSentVerified === true || (error?.submissionUnknown !== true && error?.submittedVerified !== true && ["parameters", "asset_upload", "authentication"].includes(String(error?.category || ""))))) {
        try { this.controller.closeAccount(account,{force:true,reason:"verified_before_send_failure"}); } catch {}
      }
      throw error;
    }
    if (submitted.loginRequired || submitted.verificationRequired || submitted.paused) return submitted;
    if (!submitted.generating) return submitted;
    await this.reportProgress({
      jobId: job.id,
      accountId: account.id,
      state: "generating",
      conversationId: String(submitted.conversationId || ""),
      submittedEvidence: submitted.submittedEvidence || null,
    });
    // 以豆包明确完成/失败为判定标准；本地监听有上限，超时只恢复读取原会话。
    const timeoutMs = Math.max(60_000, Number(process.env.DOUBAO_MONITOR_TIMEOUT_MS || 20 * 60 * 1000));
    let session;
    let resource;
    try {
      // Submission evidence already exists at this point. Opening the same
      // account's browser context can fail when an embedded WebContents is
      // destroyed during account switching; that is a result-monitor failure,
      // never permission to submit the prompt on another account.
      session = await this.controller.open(account);
      resource = await this.controller.waitForVideo(session, {jobId: job.id, conversationId: submitted.conversationId || "", prompt: job.payload.prompt || "", userMessageId: submitted.submittedEvidence?.userMessageId || "", submittedAt: submitted.submittedEvidence?.submittedAt || "", timeoutMs});
    } catch (error) {
      // Provider 已明确报告额度/审核/生成失败时，允许调度器切换账号；
      // 只有“提交后未读到结果”的纯监听超时才进入 submission_unknown。
      if (error?.providerTerminal || error?.quotaExhausted || error?.verificationRequired) throw error;
      // Submission was already confirmed before monitoring started. Do not let the
      // API classify a monitor timeout as a fresh-generation failure and resubmit.
      Object.assign(error, {
        code: "DOUBAO_VIDEO_RESULT_TIMEOUT",
        category: error.category || "result_wait",
        submissionUnknown: true,
        submittedVerified: true,
        safeToRetry: false,
        notSentVerified: false,
        conversationId: String(submitted.conversationId || ""),
        submittedEvidence: submitted.submittedEvidence,
        monitorDiagnostic: error.monitorDiagnostic,
        userAction: "豆包已确认提交，但暂未读取到视频地址；请人工核对原会话后恢复监听，不要重新提交。",
      });
      throw error;
    }
    const videoVid = String(resource.videoVid || this.controller.latestVideoVid(session, {jobId: job.id, conversationId: resource.conversationId || submitted.conversationId || ""}) || "");
    let watermarkFreeUrl = null;
    let watermarkFreeError = "";
    if (videoVid && !session.testMode) {
      try {
        const resolved = await this.controller.resolveWatermarkFreeVideo(session, {videoVid, conversationId: resource.conversationId || submitted.conversationId || ""});
        watermarkFreeUrl = String(resolved?.mainUrl || resolved?.backupUrl || "") || null;
      } catch (error) { watermarkFreeError = String(error?.message || error); }
    }
    const watermarkedUrl = String(resource.url || "") || null;
    const output = {
      ok: true,
      state: "completed",
      videoVid,
      conversationId: String(resource.conversationId || submitted.conversationId || ""),
      watermarkFreeUrl,
      watermarkedUrl,
      watermarkFreeAvailable: Boolean(watermarkFreeUrl),
      watermarkFreeError: watermarkFreeError || null,
      source: resource.source || "doubao-page",
    };
    if (this.closeAfterResult) this.controller.closeAccount(account,{force:true,reason:"result_saved"});
    return output;
  }
  async refreshUrls(job) {
    const account = job.account;
    const result = job.result || {};
    const session = await this.controller.open(account);
    const videoVid = String(result.videoVid || "");
    if (!videoVid) throw Object.assign(new Error("任务没有保存 videoVid，无法刷新地址"), {code: "DOUBAO_VIDEO_VID_MISSING"});
    let watermarkFreeUrl = null;
    let watermarkFreeError = "";
    try {
      const resolved = await this.controller.resolveWatermarkFreeVideo(session, {videoVid, conversationId: result.conversationId || ""});
      watermarkFreeUrl = String(resolved?.mainUrl || resolved?.backupUrl || "") || null;
    } catch (error) { watermarkFreeError = String(error?.message || error); }
    const output = {...result, watermarkFreeUrl, watermarkFreeAvailable: Boolean(watermarkFreeUrl), watermarkFreeError: watermarkFreeError || null};
    if (this.closeAfterResult) this.controller.closeAccount(account);
    return output;
  }
  close() { this.controller.closeAll(); }
  taskManager() {
    const manager = this.controller.embeddedBrowserProvider?.();
    if (!manager?.openTask) throw Object.assign(new Error("任务窗口需要在桌面客户端中打开"), {statusCode: 409, code: "DOUBAO_DESKTOP_REQUIRED"});
    return manager;
  }
  openTask(job) { return this.taskManager().openTask(job); }
  takeoverTask(job) { return this.taskManager().takeoverTask(job); }
  freezeTakeover(job) { return this.taskManager().freezeTakeover(job); }
  async inspectTask(job) {
    const release = this.controller.embeddedBrowserProvider?.()?.retainAutomation?.(job.account);
    try { return await this.inspectTaskInSession(job); } finally { release?.(); }
  }
  async probeTaskVideos(session, job, options = {}) {
    const c = job.taskContext;
    return this.controller.evaluate(session, `(${probeExistingVideos.toString()})(${JSON.stringify({conversationId:c.conversationId, originalUserMessageId:c.userMessageId, prompt:job.payload.prompt, allowContinuation:!!job.manualControl?.startedAt, ...options})})`);
  }
  async inspectTaskInSession(job) {
    const c = job.taskContext, session = await this.controller.open(job.account);
    const login = await this.controller.detect(job.account);
    if (!login.loggedIn || login.verificationRequired) return {conversationMatches: true, matched: true, loginRequired: !login.loggedIn, verification: !!login.verificationRequired, message: "请在原账号完成登录或验证"};
    const target = this.taskManager().taskUrl(job.account, c.conversationId);
    const current = await this.controller.evaluate(session, "location.href");
    if (String(current).split(/[?#]/)[0].replace(/\/$/, "") !== target.replace(/\/$/, "")) await this.controller.navigateSession(session, target);
    const {probePageBlocker} = require("./vendor/page-blockers.cjs");
    const blocker = await this.controller.evaluate(session, `(${probePageBlocker.toString()})()`);
    if (blocker?.kind === "asset_authorization") return {conversationMatches: true, matched: true, assetAuthorization: true, message: "原页面等待素材授权"};
    let videos;
    const deadline = Date.now() + 5000;
    do {
      videos = await this.probeTaskVideos(session, job);
      if (videos?.conversationMatches && (videos.originalMatched || videos.candidates?.length)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    // A read-only inspection must not report submission progress for a previous job.
    const previousJobId = session.currentJobId;
    let state;
    try {
      session.currentJobId = "";
      state = await this.controller.readSubmissionState(session, job.payload.prompt, c.userMessageId, c.conversationId, c.submittedAt);
    } finally { session.currentJobId = previousJobId; }
    const turn = await this.controller.readConversationTurn(session, "不需要，直接帮我生成视频。");
    return {conversationMatches: state.conversationMatches === true, matched: !!(state.userMessage || state.promptPresentInCurrentConversation || state.scopedGenerating),
      conversationId: state.conversationId, candidates: videos?.conversationMatches ? videos.candidates : [], planningConfirmation: !!state.planningConfirmation, paidQuotaConfirmation: !!state.paidQuotaConfirmation,
      confirmationDelivered: turn?.delivered === true && turn.conversationId === c.conversationId && turn.userMessageId !== c.userMessageId,
      scopedGenerating: !!state.scopedGenerating, videoTaskCard: !!state.videoTaskCard, verification: !!state.verification,
      quotaExhausted: !!state.quotaExhausted, providerTerminal: !!state.providerTerminal,
      failure: state.providerTerminal ? {code:state.code,category:state.category,retryMode:state.retryMode,userAction:state.userAction,providerMessage:state.providerMessage,providerMessageRaw:state.providerMessageRaw,evidence:state.evidence,quotaConsumed:state.quotaConsumed,providerTerminal:true,terminalFailureVerified:true,accountAction:"release"} : null,
      message: state.providerMessageRaw || state.providerMessage || state.quotaMessage || "原会话核对完成；未发送消息"};
  }
  async recoverTaskResult(job, candidate) {
    const release = this.controller.embeddedBrowserProvider?.()?.retainAutomation?.(job.account);
    const fail = (message, code = "DOUBAO_RESULT_SELECTION_STALE") => Object.assign(new Error(message), {code, statusCode:409, safeToRetry:false, notSentVerified:false});
    try {
      const session = await this.controller.open(job.account), c = job.taskContext;
      let activated = false, fingerprint = candidate.fingerprint;
      const read = async options => {
        const probe = await this.probeTaskVideos(session, job, options);
        const found = probe?.candidates?.find(item => item.id === candidate.id);
        // Opening this exact card may populate its previously absent resource.
        const hydrated = activated && fingerprint === candidate.fingerprint && !candidate.url && !candidate.videoVid && candidate.contentFingerprint && found?.contentFingerprint === candidate.contentFingerprint;
        if (!probe?.conversationMatches || !found || (found.fingerprint !== fingerprint && !hydrated) || found.ambiguous) throw fail("视频候选或原会话已变化，请重新核对后选择；未写回结果");
        fingerprint = found.fingerprint;
        return found;
      };
      await this.controller.checkPageBlocker(session);
      let found = await read(), watermarkFreeUrl = null, watermarkFreeError = "";
      const resolveUrl = async () => {
        try {
          const resolved = await this.controller.resolveWatermarkFreeVideo(session, {videoVid:found.videoVid, conversationId:c.conversationId});
          watermarkFreeUrl = resolved?.mainUrl || resolved?.backupUrl || null;
        } catch (error) { watermarkFreeError = String(error.message || error); }
      };
      if (found.videoVid) await resolveUrl();
      if (!watermarkFreeUrl && !found.url) {
        const manager=this.controller.embeddedBrowserProvider?.();
        const activate=()=>read({selectedId:candidate.id, activate:true});
        if(manager?.withTaskResultPlayback)await manager.withTaskResultPlayback(job,candidate,activate);
        else await activate();
        activated = true;
        const deadline = Date.now() + 8000;
        do {
          await new Promise(resolve => setTimeout(resolve, 250));
          found = await read();
          if (found.url || found.videoVid) break;
        } while (Date.now() < deadline);
        if (!watermarkFreeUrl && found.videoVid && found.videoVid !== candidate.videoVid) await resolveUrl();
      }
      await read();
      const valid = value => {try {const url=new URL(String(value||"")); return ["http:","https:"].includes(url.protocol) ? url.href : null;} catch {return null;}};
      watermarkFreeUrl = valid(watermarkFreeUrl);
      const watermarkedUrl = valid(found.url);
      if (!watermarkFreeUrl && !watermarkedUrl) throw fail("已找到视频卡片，但尚未取得有效视频地址；请在原会话打开该视频后再次核对", "DOUBAO_RESULT_URL_NOT_READY");
      return {ok:true,state:"completed",conversationId:c.conversationId,videoVid:found.videoVid || "",watermarkFreeUrl,watermarkedUrl,watermarkFreeAvailable:!!watermarkFreeUrl,watermarkFreeError:watermarkFreeError || null,source:"original-conversation-selected-video",resultMessageId:found.messageId,recoveredAt:new Date().toISOString()};
    } finally { release?.(); }
  }
  async retryWatermarkFree(job) {
    const release = this.controller.embeddedBrowserProvider?.()?.retainAutomation?.(job.account);
    try {
      const c = job.taskContext, result = job.result || {};
      if (!c?.conversationId || result.conversationId !== c.conversationId) throw Object.assign(new Error("原视频与任务会话绑定不一致"), {code:"DOUBAO_RESULT_BINDING_INVALID"});
      const session = await this.controller.open(job.account);
      const login = await this.controller.detect(job.account);
      if (!login.loggedIn || login.verificationRequired) throw new Error("请在原账号完成登录或验证后重试获取无水印");
      const target = this.taskManager().taskUrl(job.account,c.conversationId);
      const current = await this.controller.evaluate(session,"location.href");
      if (String(current).split(/[?#]/)[0].replace(/\/$/,"") !== target.replace(/\/$/,"")) await this.controller.navigateSession(session,target);
      await this.controller.checkPageBlocker(session);
      let videoVid = result.videoVid;
      if (!videoVid && result.resultMessageId) {
        const probe = await this.probeTaskVideos(session,job);
        const resourceKey = url => {try {const value=new URL(url);return value.origin+value.pathname;} catch {return "";}};
        const expectedResource = resourceKey(result.watermarkedUrl);
        const candidates = probe?.conversationMatches ? probe.candidates.filter(item=>item.messageId === result.resultMessageId && !item.ambiguous && item.videoVid && expectedResource && resourceKey(item.url) === expectedResource) : [];
        if (candidates.length === 1) videoVid = candidates[0].videoVid;
      }
      if (!videoVid) throw new Error("原视频编号尚未读取到，请在原会话打开该视频后重试；不会重新生成");
      const resolved = await this.controller.resolveWatermarkFreeVideo(session,{videoVid,conversationId:c.conversationId});
      const watermarkFreeUrl = String(resolved?.mainUrl || resolved?.backupUrl || "");
      if (!watermarkFreeUrl) throw new Error("豆包尚未返回无水印地址，已保留原视频");
      return {...result,videoVid,watermarkFreeUrl,watermarkFreeAvailable:true,watermarkFreeError:null,watermarkFreeRetrievedAt:new Date().toISOString()};
    } finally {release?.();}
  }
  async checkGeneration(account) {
    const manager=this.controller.embeddedBrowserProvider?.(), release=manager?.retainAutomation?.(account);
    try {
      const session=await this.controller.open(account);
      const login=await this.controller.detect(account);
      if(!login.loggedIn||login.verificationRequired) return {ok:false,message:"请先完成原账号登录或验证"};
      await this.controller.checkPageBlocker(session,{dismissPromotion:true});
      if(account.generationHealth?.kind==="video_mode") await this.controller.ensureVideoMode(session);
      const {probeComposer}=require("./vendor/composer-guard.cjs");
      const composer=await this.controller.evaluate(session,`(${probeComposer.toString()})("","",false,false)`);
      if(!composer||composer.reason==="composer-not-found") return {ok:false,message:"原页面输入框仍不可用",composer};
      const item=manager?.automationSessions.get(account.id);
      if(item) item.blockedForUser=false;
      return {ok:true,message:"页面检查通过，可以重新分配新任务；未发送消息或生成视频"};
    } finally {release?.();}
  }
  rehearseBrowsers(accounts, payload) { return require("./browser-rehearsal.cjs").rehearseBrowsers(this, accounts, payload); }
}

module.exports = {DoubaoWorker};

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "references", "failure-handling.json"), "utf8"));
const {DoubaoWorker} = require(path.join(__dirname, "..", "src", "doubao-worker.cjs"));
const {classifyDoubaoFailureMessage, shouldRequestGenerationConfirmation} = require(path.join(__dirname, "..", "src", "vendor", "browser-controller.cjs"));
const {jobError, isPreSubmissionFailure, hasSubmissionEvidence, isAmbiguousPostSubmissionError, shouldPreserveSubmittedJob, canRecoverExistingResult} = require(path.join(__dirname, "..", "src", "server.cjs"));

(async () => {
  const promptOnly = classifyDoubaoFailureMessage(fixture.promptOnlyReply.message);
  assert.equal(promptOnly.providerTerminal, true);
  assert.equal(promptOnly.code, fixture.promptOnlyReply.expectedCode);
  assert.equal(promptOnly.retryMode, fixture.promptOnlyReply.expectedRetryMode);
  assert.equal(promptOnly.safeToRetry, true);

  const copyrightRejected = classifyDoubaoFailureMessage("生成的视频可能涉及版权限制，请更换输入内容后重试");
  assert.equal(copyrightRejected.providerTerminal, true);
  assert.equal(copyrightRejected.code, "DOUBAO_COPYRIGHT_CONTENT_REJECTED");
  assert.equal(copyrightRejected.retryMode, "edit_prompt");
  assert.match(copyrightRejected.userAction, /更换.*输入内容|提示词/);

  const copyrightAssetRejected = classifyDoubaoFailureMessage("参考图 1 统一冷绿室内光影，并还原两名人。该参考素材可能涉及版权，请更换后重试。");
  assert.equal(copyrightAssetRejected.code, "DOUBAO_COPYRIGHT_ASSET_REJECTED");
  assert.equal(copyrightAssetRejected.providerMessageRaw, "参考图 1 统一冷绿室内光影，并还原两名人。该参考素材可能涉及版权，请更换后重试。");
  const serializedCopyright = jobError({
    code: copyrightAssetRejected.code,
    message: copyrightAssetRejected.providerMessageRaw,
    ...copyrightAssetRejected,
  });
  assert.equal(serializedCopyright.message, copyrightAssetRejected.providerMessageRaw);
  assert.equal(serializedCopyright.providerMessageRaw, copyrightAssetRejected.providerMessageRaw);
  assert.equal(isPreSubmissionFailure({code: "DOUBAO_ASSET_UPLOAD_FAILED", category: "asset_upload", terminalFailureVerified: true}), true);
  assert.equal(isPreSubmissionFailure({code: "DOUBAO_PARAMETER_CONFIG_FAILED", category: "parameters"}), true);
  assert.equal(isPreSubmissionFailure({code: "DOUBAO_VIDEO_RESULT_TIMEOUT", category: "result_wait", submittedVerified: true}), false);
  const submittedJob = {
    state: "failed",
    account_id: "account-001",
    payload: {conversationId: "conv-1", submittedEvidence: {conversationId: "conv-1", userMessageId: "msg-1"}},
    error: {code: "DOUBAO_WORKER_FAILED", message: "Object has been destroyed"},
  };
  assert.equal(hasSubmissionEvidence(submittedJob), true);
  assert.equal(isAmbiguousPostSubmissionError(submittedJob.error), true);
  assert.equal(shouldPreserveSubmittedJob(submittedJob, submittedJob.error), true);
  assert.equal(canRecoverExistingResult(submittedJob), true);
  assert.equal(isAmbiguousPostSubmissionError({code: "DOUBAO_VIDEO_QUOTA_EXHAUSTED", quotaExhausted: true}), false);
  for (const prose of [
    "参考图中的室内空间氛围与三名人物保持一致，正在生成视频。",
    "素材： 图 1 锁定室内空间与冷绿光影；图 2、图 3 锁定两名人物。",
    "参考图 1 统一冷绿室内光影，并还原两名人物。",
    "参考图使用自有版权素材，正在生成视频。",
    "请更换输入内容后重试",
  ]) assert.equal(classifyDoubaoFailureMessage(prose).providerTerminal, false, prose);
  assert.equal(classifyDoubaoFailureMessage("参考图包含公众人物，暂不支持生成，请更换素材").code, "DOUBAO_COPYRIGHT_ASSET_REJECTED");

  const generationInstruction = shouldRequestGenerationConfirmation(fixture.generationInstructionReply.message);
  assert.equal(generationInstruction, fixture.generationInstructionReply.expectedConfirmation);
  const confirmationPrompt = "参数已确认，请立即创建视频任务并开始生成，不要继续输出提示词、分镜或参数说明。";
  assert.equal(confirmationPrompt, fixture.generationInstructionReply.expectedPrompt);

  const worker = Object.create(DoubaoWorker.prototype);
  worker.closeAfterResult = false;
  worker.onProgress = null;
  let resumeCommand;
  let closedAccount = false;
  worker.controller = {
    execute: async command => { resumeCommand = command; return ({ok: true, generating: true, conversationId: fixture.monitorTimeout.conversationId}); },
    open: async () => ({testMode: false}),
    waitForVideo: async () => { throw new Error(fixture.monitorTimeout.message); },
    closeAccount: () => { closedAccount = true; },
  };
  await assert.rejects(() => worker.generate({id: "failure-test", account: {id: "account-001"}, payload: {prompt: "测试", model: "Seedance 2.0 Mini", ratio: "9:16", duration: 10, timeoutMs: 600000, imageAssets: []}}), error => {
    assert.equal(error.code, fixture.monitorTimeout.expectedCode);
    assert.equal(error.category, fixture.monitorTimeout.expectedCategory);
    assert.equal(error.submissionUnknown, true);
    assert.equal(error.submittedVerified, true);
    assert.equal(error.safeToRetry, false);
    assert.equal(error.conversationId, fixture.monitorTimeout.conversationId);
    return true;
  });
  await assert.rejects(() => worker.generate({id: "resume-test", account: {id: "account-001"}, payload: {prompt: "测试", model: "Seedance 2.0 Mini", ratio: "9:16", duration: 10, timeoutMs: 600000, resumeExisting: true, conversationId: fixture.monitorTimeout.conversationId, imageAssets: [{path: "C:/deleted-after-submit.png"}]}}));
  assert.equal(resumeCommand.action, "resume_monitor");
  assert.deepEqual(resumeCommand.payload.imageAssets, []);
  assert.equal(closedAccount, false);

  const postSubmitOpenFailureWorker = Object.create(DoubaoWorker.prototype);
  postSubmitOpenFailureWorker.closeAfterResult = false;
  postSubmitOpenFailureWorker.onProgress = null;
  postSubmitOpenFailureWorker.controller = {
    execute: async () => ({ok: true, generating: true, conversationId: "conv-open-destroyed", submittedEvidence: {conversationId: "conv-open-destroyed", userMessageId: "msg-open-destroyed", submittedAt: "2026-09-26T00:00:00.000Z"}}),
    open: async () => { throw new Error("Object has been destroyed"); },
    closeAccount: () => {},
  };
  await assert.rejects(() => postSubmitOpenFailureWorker.generate({id: "post-submit-open-failure", account: {id: "account-001"}, payload: {prompt: "测试", model: "Seedance 2.0 Mini", ratio: "9:16", duration: 10, imageAssets: []}}), error => {
    assert.equal(error.code, "DOUBAO_VIDEO_RESULT_TIMEOUT");
    assert.equal(error.submissionUnknown, true);
    assert.equal(error.submittedVerified, true);
    assert.equal(error.conversationId, "conv-open-destroyed");
    return true;
  });
  const structured = jobError(fixture.structuredError);
  assert.deepEqual(structured, fixture.structuredError);
  console.log("failure handling ok (prompt-only terminal detected; submitted timeout is non-duplicating; error metadata preserved)");
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

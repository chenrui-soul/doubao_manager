"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {BrowserController} = require("../src/vendor/browser-controller.cjs");

const imagePath = path.join(__dirname, "..", "assets", "20260911-gu-yanzhen", "06-start-frame.jpg");

async function makeController(log, {promptReady = true} = {}) {
  const controller = Object.create(BrowserController.prototype);
  const session = {testMode: false, assetUploadRequests: [], submissionRequests: []};
  controller.open = async () => session;
  controller.connect = async () => ({send: async () => ({})});
  controller.detect = async () => ({loggedIn: true, verificationRequired: false});
  controller.evaluate = async (_session, expression) => {
    if (/安全验证|人工验证|captcha/.test(expression)) return {verification: false};
    if (/location\.pathname\.match/.test(expression)) return "123456789012345";
    return true;
  };
  controller.prepareFreshConversation = async () => { log.push("fresh"); };
  controller.ensureVideoMode = async () => { log.push("mode"); };
  controller.setVideoParameters = async () => { log.push("params"); };
  controller.closeVideoParameterPanel = async () => { log.push("close-params"); };
  controller.waitForComposer = async () => { log.push("composer"); };
  controller.uploadReferenceImages = async () => {
    log.push("upload");
    return {requestedCount: 1, uploadedCount: 1, verified: true, items: [{verified: true}]};
  };
  controller.reassertVideoSubmissionReady = async () => { log.push("reassert"); };
  controller.fillComposer = async () => { log.push("fill"); return promptReady; };
  controller.clickComposerSend = async () => { log.push("send"); return true; };
  controller.readSubmissionState = async () => ({
    conversationId: "123456789012345",
    conversationMatches: true,
    userMessage: true,
    userMessageId: "user-1",
    promptPresentInCurrentConversation: true,
    scopedGenerating: true,
    videoTaskCard: true,
    pageTaskCard: true,
    providerSignal: "视频生成中",
  });
  return {controller, session};
}

(async () => {
  const log = [];
  const {controller} = await makeController(log);
  const result = await controller.runGeneration({
    action: "generate",
    id: "sequence-test",
    account: {id: "account-test", platform: "豆包"},
    payload: {
      jobId: "sequence-test",
      prompt: "完整提示词",
      model: "Seedance 2.0 Mini",
      ratio: "9:16",
      duration: 10,
      imageAssets: [{id: "asset-1", name: "06-start-frame.jpg", path: imagePath}],
    },
  });
  assert.equal(result.generating, true);
  assert.deepEqual(log, ["fresh", "mode", "params", "close-params", "composer", "upload", "reassert", "fill", "send"], "generation stages must remain ordered and close parameter popover before composing");

  const blocked = [];
  const {controller: blockedController} = await makeController(blocked, {promptReady: false});
  await assert.rejects(
    () => blockedController.runGeneration({
      action: "generate",
      id: "sequence-blocked",
      account: {id: "account-test", platform: "豆包"},
      payload: {jobId: "sequence-blocked", prompt: "未稳定提示词", imageAssets: [{id: "asset-1", name: "06-start-frame.jpg", path: imagePath}]},
    }),
    error => error?.code === "DOUBAO_PROMPT_NOT_READY" && error?.notSentVerified === true,
  );
  assert.deepEqual(blocked.at(-1), "fill", "send must not run when the prompt is not stable");
  assert.equal(blocked.includes("send"), false, "prompt guard must block the send click");

  // A planning reply needs one short confirmation. That reply must reuse the
  // already configured video session; reopening the parameter panel here used
  // to cover the composer and leave the confirmation stuck in the editor.
  const confirmationLog = [];
  const {controller: confirmationController} = await makeController(confirmationLog);
  let stateReads = 0;
  confirmationController.readSubmissionState = async () => {
    stateReads += 1;
    if (stateReads <= 2) return {conversationId: "123456789012345", conversationMatches: true, userMessage: true, userMessageId: "user-1", promptPresentInCurrentConversation: true, planningConfirmation: true, scopedGenerating: false, videoTaskCard: false, pageTaskCard: false, providerSignal: "视频生成参数确认"};
    return {conversationId: "123456789012345", conversationMatches: true, userMessage: true, userMessageId: "user-2", promptPresentInCurrentConversation: true, scopedGenerating: true, videoTaskCard: true, pageTaskCard: true, providerSignal: "视频生成中"};
  };
  confirmationController.readConversationTurn = async () => ({known: true, responding: false, queued: false, delivered: true, conversationId: "123456789012345", userMessageId: "confirm-1"});
  confirmationController.waitForAssistantReply = async () => {};
  confirmationController.waitForConfirmationDelivery = async () => ({delivered: true, conversationId: "123456789012345", userMessageId: "confirm-1"});
  const confirmationResult = await confirmationController.runGeneration({
    action: "generate", id: "confirmation-sequence", account: {id: "account-test", platform: "豆包"},
    payload: {jobId: "confirmation-sequence", prompt: "完整提示词", model: "Seedance 2.0 Mini", ratio: "9:16", duration: 10, imageAssets: [{id: "asset-1", name: "06-start-frame.jpg", path: imagePath}]},
  });
  assert.equal(confirmationResult.generating, true);
  assert.equal(confirmationLog.filter(value => value === "reassert").length, 1, "confirmation must not reopen parameter controls");

  console.log("generation sequence ok (mode -> params -> close-params -> composer -> upload -> reassert -> fill -> send)");
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

"use strict";
const assert = require("node:assert/strict");
const {BrowserController} = require("../src/vendor/browser-controller.cjs");
(async () => {
  const controller = Object.create(BrowserController.prototype);
  const session = {captures:[], consumedCaptures:new Set()};
  controller.connect = async () => ({});
  controller.readSubmissionState = async () => ({planningConfirmation:true, scopedGenerating:false, videoTaskCard:false});
  controller.evaluate = async () => ({url:"https://example.invalid/generated.mp4",videoVid:"real-video-id"});
  const result = await controller.waitForVideo(session,{jobId:"submitted-task",conversationId:"123456789",prompt:"时间轴 连续性硬约束 视频",timeoutMs:1000});
  assert.equal(result.url,"https://example.invalid/generated.mp4","prompt echoes during generation must not terminate result collection");
  controller.readSubmissionState = async () => ({providerTerminal:true,providerMessage:"生成失败",code:"PROVIDER_FAILED"});
  await assert.rejects(controller.waitForVideo(session,{prompt:"视频",timeoutMs:1000}),{code:"PROVIDER_FAILED"});
  console.log("video planning transition: echoed prompt preserves monitoring; real provider failure still stops");
})().catch(error=>{console.error(error);process.exitCode=1;});

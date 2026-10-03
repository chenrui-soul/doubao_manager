"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {BrowserController, classifySubmissionEvidence} = require("../src/vendor/browser-controller.cjs");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../assets/20260911-gu-yanzhen/account-001-reassertion-result.json"), "utf8"));
const response = fixture.error.monitorDiagnostic.after.providerSignal;
const latestResponse = response.slice(response.lastIndexOf("已生成代码"));
const controller = Object.create(BrowserController.prototype);
const node = (text, user = false, video = false) => ({
  className: user ? "justify-end" : "assistant", innerText: text,
  getBoundingClientRect: () => ({width: 100, height: 30}), getAttribute: () => null,
  querySelector: selector => video && selector === "video" ? {currentSrc: "https://example.invalid/test.mp4"} : null,
});
let messages = [];
const root = {get innerText() {return messages.map(m => m.innerText).join(" ");}, querySelectorAll: () => messages};
const context = {location: {pathname: "/chat/123456789"}, getComputedStyle: () => ({display: "block", visibility: "visible", position: "static"}), document: {body: root, querySelector: () => root, querySelectorAll: () => []}};
controller.evaluate = async (_session, expression) => vm.runInNewContext(expression, context);
(async () => {
  messages = [node("测试视频 Seedance 2.0 Mini 16:9 10s", true), node(latestResponse)];
  let state = await controller.readSubmissionState({}, "测试视频");
  assert.equal(state.codeOnlyVideoResponse, true, "captured account-001 code response must be diagnosed");
  assert.equal(state.videoTaskCard, false, "model/ratio/duration in prose are not a task card");
  assert.equal(classifySubmissionEvidence({after: state, request: {videoGenerationRequest: true}}).confirmed, false);
  messages.push(node("不需要，直接帮我生成视频。", true), node("已生成代码 视频生成中，预计等待 5 分钟。Seedance 2.0 Mini"));
  state = await controller.readSubmissionState({}, "测试视频");
  assert.equal(state.scopedGenerating, false, "code render claims must not enter generating");
  messages.push(node("你的视频生成好了。", false, true));
  state = await controller.readSubmissionState({}, "测试视频");
  assert.equal(state.codeOnlyVideoResponse, false, "old code must not mask a later real video");
  assert.equal(state.videoTaskCard, true);
  assert.equal(classifySubmissionEvidence({after: state}).confirmed, true);
  messages = [node("测试视频", true), node("视频生成中，请稍候")];
  state = await controller.readSubmissionState({}, "测试视频");
  assert.equal(state.scopedGenerating, true, "existing provider progress remains supported");
  messages = [node("测试视频", true), node("生成视频 Seedance 2.0 Mini 16:9 10s 已提交任务，请等待渲染完成")];
  state = await controller.readSubmissionState({}, "测试视频");
  assert.equal(state.videoTaskCard, false, "text-only parameter summary cannot impersonate a task card");
  messages = [node("测试视频", true), node(latestResponse)];
  controller.connect = async () => ({});
  await assert.rejects(
    controller.waitForVideo({}, {jobId: "unit-code-only", conversationId: "123456789", prompt: "测试视频", timeoutMs: 1000}),
    error => error.code === "DOUBAO_VIDEO_TASK_NOT_CREATED" && error.submissionUnknown === true && error.safeToRetry === false,
    "monitoring an old code-only response must stop without retrying or claiming quota was unconsumed",
  );
  console.log("code-only video response regression passed (captured failure, false progress, later real video)");
})().catch(error => {console.error(error); process.exitCode = 1;});

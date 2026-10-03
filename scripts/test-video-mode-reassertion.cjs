"use strict";

const assert = require("node:assert/strict");
const {BrowserController} = require("../src/vendor/browser-controller.cjs");

(async () => {
  const controller = Object.create(BrowserController.prototype);
  const calls = [];
  const states = [
    {previewCount: 7, fileCount: 0, fileNames: []},
    {previewCount: 7, fileCount: 0, fileNames: []},
  ];
  controller.readReferenceUploadState = async () => states.shift();
  controller.ensureVideoMode = async () => { calls.push("mode"); return true; };
  controller.setVideoParameters = async (_session, payload) => { calls.push(`params:${payload.ratio}:${payload.duration}`); };
  controller.waitForComposer = async () => { calls.push("composer"); return true; };

  const result = await controller.reassertVideoSubmissionReady(
    {testMode: false},
    {ratio: "16:9", duration: 10},
    {requestedCount: 7, uploadedCount: 7, verified: true},
  );
  assert.deepEqual(calls, ["mode", "params:16:9:10", "composer"]);
  assert.equal(result.referenceCountBefore, 7);
  assert.equal(result.referenceCountAfter, 7);

  const losingController = Object.create(BrowserController.prototype);
  const losingStates = [
    {previewCount: 7, fileCount: 0, fileNames: []},
    {previewCount: 0, fileCount: 0, fileNames: []},
  ];
  losingController.readReferenceUploadState = async () => losingStates.shift();
  losingController.ensureVideoMode = async () => true;
  losingController.setVideoParameters = async () => true;
  losingController.waitForComposer = async () => true;
  await assert.rejects(
    () => losingController.reassertVideoSubmissionReady(
      {testMode: false, referenceVerificationTimeoutMs: 50},
      {ratio: "16:9", duration: 10},
      {requestedCount: 7, uploadedCount: 7, verified: true},
    ),
    error => error?.code === "DOUBAO_ASSET_UPLOAD_FAILED" && error?.notSentVerified === true,
  );

  const missingBeforeController = Object.create(BrowserController.prototype);
  const missingBeforeStates = [
    {previewCount: 0, fileCount: 0, fileNames: []},
    {previewCount: 0, fileCount: 0, fileNames: []},
  ];
  missingBeforeController.readReferenceUploadState = async () => missingBeforeStates.shift() || {previewCount: 0, fileCount: 0, fileNames: []};
  missingBeforeController.ensureVideoMode = async () => true;
  missingBeforeController.setVideoParameters = async () => true;
  missingBeforeController.waitForComposer = async () => true;
  await assert.rejects(
    () => missingBeforeController.reassertVideoSubmissionReady(
      {testMode: false, referenceVerificationTimeoutMs: 50},
      {ratio: "16:9", duration: 10},
      {requestedCount: 2, uploadedCount: 2, verified: true},
    ),
    error => error?.code === "DOUBAO_ASSET_UPLOAD_FAILED" && /未确认全部参考图/.test(error.message) && error?.notSentVerified === true,
    "0 -> 0 attachment probes must block prompt submission",
  );

  console.log("video mode reassertion ok (mode/params restored and attachment loss blocked)");
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

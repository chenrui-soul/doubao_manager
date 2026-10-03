"use strict";
const assert = require("assert");
const {BrowserController} = require("../src/vendor/browser-controller.cjs");

(async () => {
  const controller = Object.create(BrowserController.prototype);
  let setCalls = 0, resetCalls = 0, stateCalls = 0;
  controller.readReferenceUploadState = async () => {
    stateCalls += 1;
    return stateCalls <= 2 ? {previewCount: 0, pending: false, failure: ""} : {previewCount: 1, pending: false, failure: ""};
  };
  controller.setReferenceFile = async () => {
    setCalls += 1;
    if (setCalls === 1) throw Object.assign(new Error("transient upload"), {code: "DOUBAO_ASSET_UPLOAD_FAILED", uploadState: {pending: true}});
  };
  controller.resetReferenceFileInput = async () => { resetCalls += 1; };
  const session = {testMode: false, assetUploadRequests: []};
  const result = await controller.uploadReferenceImages(session, {imageAssets: [{id: "asset-1", name: "06-start-frame.jpg", path: require("path").join(__dirname, "..", "assets", "20260911-gu-yanzhen", "06-start-frame.jpg")}]});
  assert.equal(result.uploadedCount, 1);
  assert.equal(result.items[0].attempt, 2);
  assert.equal(setCalls, 2);
  assert.equal(resetCalls, 1);
  console.log("upload retry ok (first attempt failed, second succeeded with input reset)");
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "references", "worker-timeout.json"), "utf8"));
const {withTimeout} = require(path.join(__dirname, "..", "src", "server.cjs"));

(async () => {
  try {
    await withTimeout(new Promise(resolve => setTimeout(resolve, 1500)), fixture.timeoutMs, "测试任务超时");
    throw new Error("expected timeout");
  } catch (error) {
    assert.equal(error.code, fixture.expectedCode);
  }
  console.log("worker timeout ok");
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

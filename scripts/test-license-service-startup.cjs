"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../desktop/main.cjs"), "utf8");
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  let resolveStartup, rejectStartup, calls = 0, closed = 0;
  const startup = new Promise((resolve, reject) => { resolveStartup = resolve; rejectStartup = reject; });
  const handlers = new Map();
  let status = {valid: true, permanent: true};
  const app = {commandLine: {appendSwitch() {}}, disableHardwareAcceleration() {}, setPath() {}, getPath: () => "fixture", requestSingleInstanceLock: () => true, on() {}, whenReady: () => new Promise(() => {})};
  const context = {
    require: name => {
      if (name === "electron") return {app, ipcMain: {handle: (name, fn) => handlers.set(name, fn)}};
      if (["path", "fs", "child_process"].includes(name)) return require(name);
      return {};
    },
    __dirname: path.join(__dirname, "../desktop"), process: {env: {}}, console, AbortSignal,
    fetch: async () => { calls++; return {ok: true, json: async () => status}; },
  };
  vm.runInNewContext(source + `\nglobalThis.configureStartup = promise => { serviceStartup = promise; embeddedBrowser = {setLicenseValid: valid => { if (!valid) globalThis.onClose(); }}; };`, context);
  context.onClose = () => { closed++; };
  context.configureStartup(startup);
  return {check: () => handlers.get("license:status")({}, false), resolveStartup, rejectStartup, calls: () => calls, closed: () => closed, setStatus: value => { status = value; }};
}

(async () => {
  const slow = fixture();
  let finished = false;
  const first = slow.check().then(value => { finished = true; return value; });
  const second = slow.check();
  await settle();
  assert.equal(slow.calls(), 0, "license requests must wait for local service startup");
  assert.equal(finished, false, "startup must remain loading, not render an error");
  assert.equal(slow.closed(), 0);
  slow.resolveStartup();
  assert.equal((await first).valid, true);
  assert.equal((await second).valid, true);
  slow.setStatus({valid: false, code: "DOUBAO_LICENSE_EXPIRED"});
  assert.equal((await slow.check()).code, "DOUBAO_LICENSE_EXPIRED");
  assert.equal(slow.closed(), 1, "expired license still blocks browser access");
  const failed = fixture();
  const result = failed.check();
  failed.rejectStartup(new Error("fixture startup failure"));
  assert.equal((await result).code, "DOUBAO_LICENSE_SERVICE_UNAVAILABLE");
  assert.equal(failed.calls(), 0);
  console.log("License service startup passed: delayed startup, concurrent requests, startup failure, expiry enforcement");
})().catch(error => { console.error(error); process.exitCode = 1; });

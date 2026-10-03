"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../desktop/license-ui.js"), "utf8");
const settle = () => new Promise(resolve => setImmediate(resolve));
async function fixture(initial, options = {}) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {value: "", open: false, handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; }, show() { this.open = true; }, showModal() { this.open = true; }, close() { this.open = false; this.handlers.close?.(); }});
    return nodes.get(id);
  };
  node(".app-shell").hidden = true;
  node(".app-shell").inert = true;
  let state = initial, tick, accountReads = 0, taskReads = 0;
  vm.runInNewContext(source, {
    document: {querySelector: id => node(id), getElementById: id => node("#" + id)},
    window: {doubaoDesktop: {licenseStatus: async () => { if (state instanceof Error) throw state; return state; }, licenseSecret: async () => { if (options.secretFails) throw new Error("unavailable"); return "test-only"; }, showLicense: async () => {}}},
    refreshAccounts: () => { accountReads++; }, refreshTasks: () => { taskReads++; },
    setInterval: fn => { tick = fn; },
  });
  await settle();
  return {node, reads: () => [accountReads, taskReads], async update(value) { state = value; tick(); await settle(); }};
}
(async () => {
  const disabled = await fixture({valid: true, verificationDisabled: true, expiresAt: null}, {secretFails: true});
  assert.equal(disabled.node(".app-shell").hidden, false);
  assert.equal(disabled.node(".app-shell").inert, false);
  assert.equal(disabled.node("#openLicense").hidden, true);
  assert.equal(disabled.node("#licenseSummary").textContent, "授权验证已暂时停用");
  assert.equal(disabled.node("#licenseSecret").value, "");
  await disabled.node("#openLicense").handlers.click();
  assert.equal(disabled.node("#licenseDialog").open, false);
  const valid = {valid: true, permanent: true};
  const ui = await fixture({valid: false, message: "授权服务未连接，请稍后重试"});
  assert.equal(ui.node("#licenseDialog").open, false, "startup connection delay must not show activation");
  assert.equal(ui.node(".app-shell").hidden, true);
  assert.equal(ui.node("#startupScreen").hidden, false);
  assert.deepEqual(ui.reads(), [0, 0]);
  await ui.update(valid);
  assert.equal(ui.node("#licenseDialog").open, false, "automatic startup dialog must close when authorization succeeds");
  assert.equal(ui.node("#startupScreen").hidden, true);
  assert.equal(ui.node(".app-shell").hidden, false);
  assert.deepEqual(ui.reads(), [1, 1]);
  await ui.node("#openLicense").handlers.click();
  await ui.update(valid);
  assert.equal(ui.node("#licenseDialog").open, true, "manual license management stays open");
  const fresh = await fixture(valid);
  assert.equal(fresh.node("#licenseDialog").open, false);
  await fresh.update({valid: false, code: "DOUBAO_LICENSE_EXPIRED"});
  assert.equal(fresh.node("#licenseDialog").open, true);
  assert.equal(fresh.node(".app-shell").inert, true);
  let prevented = false;
  fresh.node("#licenseDialog").handlers.cancel({preventDefault() { prevented = true; }});
  assert.equal(prevented, true);
  await fresh.update(valid);
  assert.equal(fresh.node("#licenseDialog").open, false);
  assert.equal(fresh.node(".app-shell").inert, false);
  const unlicensed = await fixture({valid: false, code: "DOUBAO_LICENSE_REQUIRED"});
  assert.equal(unlicensed.node("#licenseDialog").open, true);
  assert.equal(unlicensed.node(".app-shell").hidden, true);
  unlicensed.node("#licenseSecret").value = "key-being-entered";
  await unlicensed.update({valid: false, code: "DOUBAO_LICENSE_REQUIRED"});
  assert.equal(unlicensed.node("#licenseSecret").value, "key-being-entered");
  for (const status of [new Error("IPC disconnected"), {valid: false, code: "DOUBAO_LICENSE_UNAVAILABLE"}]) {
    const offline = await fixture(status);
    assert.equal(offline.node("#licenseDialog").open, false);
    assert.equal(offline.node("#retryStartup").hidden, false);
    assert.equal(offline.node(".app-shell").inert, true);
    await offline.update(valid);
    assert.equal(offline.node(".app-shell").hidden, false);
  }
  const secretFailure = await fixture(valid, {secretFails: true});
  assert.equal(secretFailure.node(".app-shell").hidden, false, "displaying stored key must not gate verified access");
  console.log("License startup: loading gate, service/network recovery, manual management, activation, expiry and secret display passed");
})().catch(error => { console.error(error); process.exitCode = 1; });

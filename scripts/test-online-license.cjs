"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {OnlineLicense, parseVerification, VERIFY_URL} = require("../src/license.cjs");
const {getDeviceCode, protect} = require("../src/license-device.cjs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-license-test-"));
const file = path.join(dir, "online-license.json");
let now = Date.parse("2030-01-01T00:00:00Z"), tick = 0, calls = 0, unavailable = false;
let body = {success: true, data: {valid: true, status: "active", expires_at: "2030-01-01T00:10:00Z", device_code: "DB-TEST"}};
const options = {
  file, device: () => "DB-TEST", wall: () => now, monotonic: () => tick,
  vault: async (value, decrypt) => decrypt ? Buffer.from(value, "base64").toString() : Buffer.from(value).toString("base64"),
  fetcher: async (url, opts) => {
    calls++;
    assert.equal(url, VERIFY_URL); assert.equal(opts.redirect, "error");
    assert.deepEqual(JSON.parse(opts.body), {secret: "test-only-secret", device_code: "DB-TEST"});
    if (unavailable) throw new Error("network");
    return {ok: true, json: async () => body};
  },
};
(async () => {
  const manager = new OnlineLicense(options);
  assert.equal((await manager.check()).valid, false);
  assert.equal(calls, 0);
  assert.equal((await manager.activate(" ")).code, "DOUBAO_LICENSE_INPUT");
  assert.equal((await manager.activate("test-only-secret")).valid, true);
  const saved = fs.readFileSync(file, "utf8");
  assert.ok(!saved.includes("test-only-secret"));
  const before = calls;
  await Promise.all(Array.from({length: 8}, () => manager.check({force: true})));
  assert.equal(calls, before + 1, "concurrent verification must coalesce");
  body = {success: false, error: {message: "test-only-secret"}};
  const bad = await manager.activate("test-only-secret");
  assert.equal(bad.valid, false); assert.ok(!JSON.stringify(bad).includes("test-only-secret"));
  assert.equal(fs.readFileSync(file, "utf8"), saved, "invalid activation must preserve saved key");
  assert.equal((await manager.check({force: true})).valid, false, "revocation must invalidate cache");
  body = {success: true, data: {valid: true, status: "active", expires_at: "2030-01-01T00:10:00Z"}};
  assert.equal((await manager.check({force: true})).valid, true);
  unavailable = true;
  assert.equal((await manager.check({force: true})).code, "DOUBAO_LICENSE_UNAVAILABLE");
  unavailable = false;
  const restarted = new OnlineLicense(options);
  assert.equal(restarted.status().valid, false, "restart cannot trust disk authorization");
  assert.equal((await restarted.check()).valid, true);
  now -= 86400000; tick += 600001;
  assert.equal(restarted.status().valid, false, "moving wall clock back cannot extend in-memory expiry");
  now = Date.parse("2030-01-01T00:00:00Z");
  for (const invalid of [null, {}, {success: "true"}, {success: true}, {success: true, data: {}}, {success: true, data: {expires_at: "2031-01-01"}}, {success: true, data: {expires_at: "2029-01-01T00:00:00Z"}}, {success: true, data: {expires_at: "2031-01-01T00:00:00Z", valid: false}}, {success: true, data: {expires_at: "2031-01-01T00:00:00Z", device_code: "OTHER"}}]) {
    assert.equal(parseVerification(invalid, true, "DB-TEST", now).valid, false);
  }
  assert.equal(parseVerification(body, false, "DB-TEST", now).valid, false);
  body = {success: true, data: {valid: true, status: "active"}};
  const permanent = new OnlineLicense(options);
  assert.equal((await permanent.activate("test-only-secret")).permanent, true);
  assert.equal(permanent.status().expiresAt, null);
  now += 365 * 86400000; tick += 365 * 86400000;
  assert.equal(permanent.status().valid, true, "long-term license has no local expiry");
  const beforePermanentCheck = calls;
  assert.equal((await permanent.check()).valid, true);
  assert.equal(calls, beforePermanentCheck + 1, "long-term licenses still revalidate after cache TTL");
  const permanentRestart = new OnlineLicense(options);
  assert.equal(permanentRestart.status().valid, false);
  assert.equal((await permanentRestart.check()).permanent, true, "restart verifies long-term key online");
  unavailable = true;
  assert.equal((await permanentRestart.check({force: true})).valid, false, "offline long-term key must fail closed");
  unavailable = false;
  assert.equal((await permanentRestart.check({force: true})).valid, true);
  body = {success: true, data: {valid: false, status: "revoked"}};
  assert.equal((await permanentRestart.check({force: true})).valid, false, "revocation blocks long-term key");
  for (const expiry of [null, undefined]) {
    assert.equal(parseVerification({success: true, data: {valid: true, status: "active", expires_at: expiry}}, true, "DB-TEST", now).permanent, true);
  }
  for (const data of [{valid: false, status: "active"}, {valid: true, status: "revoked"}, {valid: true}, {status: "active"}, {valid: "true", status: "active"}, {valid: true, status: "active", device_code: "OTHER"}, ...["", "bad", 0, false, "2031-01-01"].map(expires_at => ({valid: true, status: "active", expires_at}))]) {
    assert.equal(parseVerification({success: true, data}, true, "DB-TEST", now).valid, false, "malformed or rejected response cannot grant long-term access");
  }
  body = {success: true, data: {valid: true, status: "active", expires_at: "2032-01-01T00:00:00Z"}};
  assert.equal((await permanentRestart.check({force: true})).valid, true);
  assert.ok(!permanentRestart.status().permanent, "switching to timed key clears permanent status");
  now = Date.parse("2032-01-01T00:00:00Z");
  assert.equal(permanentRestart.status().valid, false, "timed key still expires after long-term activation");
  if (process.platform === "win32") {
    assert.equal(getDeviceCode(), getDeviceCode());
    assert.match(getDeviceCode(), /^DB-[0-9A-F]{64}$/);
    const ciphertext = await protect("DPAPI-test-only-中文");
    assert.equal(await protect(ciphertext, true), "DPAPI-test-only-中文");
    await assert.rejects(protect("invalid-ciphertext", true));
  }
  console.log("Online license: timed/long-term activation, expiry, revocation, offline, concurrency, restart, privacy, malformed responses, device code and DPAPI passed");
})().catch(error => { console.error(error); process.exitCode = 1; });

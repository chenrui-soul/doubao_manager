"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-license-disabled-"));
process.env.DOUBAO_DATA_ROOT = dir;
process.env.DOUBAO_ACCOUNTS_FILE = path.join(dir, "accounts.json");
process.env.DOUBAO_LICENSE_VERIFICATION = "0"; // Exercise the off branch independently of the release default.
fs.writeFileSync(process.env.DOUBAO_ACCOUNTS_FILE, JSON.stringify({accounts: [{id: "account-001", loginState: "logged_in"}]}));
const nativeFetch = global.fetch;
let externalRequests = 0;
global.fetch = (...args) => {
  if (new URL(args[0]).hostname !== "127.0.0.1") {
    externalRequests++;
    throw new Error("External network is disabled in this test");
  }
  return nativeFetch(...args);
};
const license = require("../src/license.cjs");
let submissions = 0;
globalThis.__doubaoInProcessWorker = {
  setProgressHandler() {}, close() {},
  detect: async () => ({loggedIn: true}),
  generate: async () => { submissions++; return {ok: true, state: "completed", videoVid: "fixture", watermarkedUrl: "mock://video"}; },
};
const service = require("../src/server.cjs");
delete globalThis.__doubaoInProcessWorker;
(async () => {
  try {
    assert.equal(license.isLicenseVerificationEnabled(), false);
    assert.equal((await license.requireLicense({force: true})).verificationDisabled, true);
    const stored = path.join(dir, "online-license.json");
    fs.writeFileSync(stored, "invalid-license-fixture");
    assert.equal((await license.checkLicense({force: true})).valid, true);
    assert.equal(await license.getStoredLicenseSecret(stored), "");
    await new Promise(resolve => service.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${service.server.address().port}`;
    for (const route of ["/health", "/api/v1/accounts", "/api/v1/license/status?refresh=1"]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200);
      if (route.includes("license/status")) assert.equal((await response.json()).verificationDisabled, true);
    }
    const activation = await fetch(base + "/api/v1/license/activate", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({secret: "unused-test-secret"})});
    assert.equal((await activation.json()).license.verificationDisabled, true);
    assert.equal(fs.readFileSync(stored, "utf8"), "invalid-license-fixture", "disabled activation must preserve stored license");
    const generated = await fetch(base + "/api/v1/video/generate?wait=1&waitTimeoutMs=3000", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({prompt: "fixture only", preferredAccountId: "account-001", accountLockRequired: true})});
    assert.equal(generated.status, 200);
    assert.equal((await generated.json()).state, "completed");
    assert.equal(submissions, 1);
    process.env.DOUBAO_LICENSE_VERIFICATION = "1";
    assert.equal(license.isLicenseVerificationEnabled(), true);
    await assert.rejects(license.requireLicense({force: true}), {statusCode: 403});
    assert.equal((await fetch(base + "/api/v1/accounts")).status, 403);
    process.env.DOUBAO_LICENSE_VERIFICATION = "0";
    assert.equal((await fetch(base + "/api/v1/accounts")).status, 200);
    assert.equal(externalRequests, 0, "no authorization-center requests allowed");
    console.log("License disabled: API, mock generation, saved-key preservation and re-enable checks passed; zero external requests");
  } finally {
    global.fetch = nativeFetch;
    if (service.server.listening) await new Promise(resolve => service.server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

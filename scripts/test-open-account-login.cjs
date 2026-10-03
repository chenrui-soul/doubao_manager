"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-open-login-"));
process.env.DOUBAO_DATA_ROOT = runtime;
process.env.DOUBAO_PROFILE_ROOT = path.join(runtime, "profiles");
process.env.DOUBAO_TEMP_ROOT = path.join(runtime, "temp");
process.env.DOUBAO_ACCOUNTS_FILE = path.join(runtime, "accounts.json");
fs.writeFileSync(process.env.DOUBAO_ACCOUNTS_FILE, JSON.stringify({accounts: [{id: "account-001", name: "test", loginState: "logged_in"}]}));
let login = {loggedIn: true, verificationRequired: false};
let inlineDetection = false, detectCalls = 0;
const license = require("../src/license.cjs");
license.checkLicense = license.requireLicense = async () => ({valid: true});
globalThis.__doubaoInProcessWorker = {
  open: async () => inlineDetection ? {ok: true, loginChecked: true, loggedIn: true} : {ok: true},
  detect: async () => { detectCalls++; if (login instanceof Error) throw login; return login; },
};
const {server} = require("../src/server.cjs");
delete globalThis.__doubaoInProcessWorker;
(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [probe, expected, status] of [
      [{loggedIn: true, verificationRequired: false}, "logged_in", 200],
      [{loggedIn: false, verificationRequired: false}, "not_logged_in", 200],
      [{loggedIn: true, verificationRequired: true}, "verification", 200],
      [new Error("probe unavailable"), "unknown", 502],
    ]) {
      login = probe;
      const response = await fetch(`${base}/api/v1/accounts/account-001/login`, {method: "POST"});
      assert.equal(response.status, status);
      await response.json();
      const stored = JSON.parse(fs.readFileSync(process.env.DOUBAO_ACCOUNTS_FILE)).accounts[0];
      assert.equal(stored.loginState, expected, "opening an account must use its actual login state");
      const listed = await (await fetch(`${base}/api/v1/accounts`)).json();
      assert.equal(listed.accounts[0].loginState, expected);
    }
    inlineDetection = true;
    const callsBefore = detectCalls;
    const opened = await fetch(`${base}/api/v1/accounts/account-001/login`, {method: "POST"});
    assert.equal(opened.status, 200);
    assert.equal((await opened.json()).account.loginState, "logged_in");
    assert.equal(detectCalls, callsBefore, "opening with a completed inline probe must not open another browser for detection");
    console.log("open account login state: logged in, expired, verification and probe failure passed");
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });

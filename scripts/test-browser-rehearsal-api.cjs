"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "rehearsal-api-"));
process.env.DOUBAO_DATA_ROOT = runtime; process.env.DOUBAO_ACCOUNTS_FILE = path.join(runtime, "accounts.json");
fs.writeFileSync(process.env.DOUBAO_ACCOUNTS_FILE, JSON.stringify({accounts: [{id: "a", loginState: "logged_in"}]}));
const license = require("../src/license.cjs"); license.checkLicense = license.requireLicense = async () => ({valid: true});
let release, entered; const started = new Promise(r => { entered = r; }); const hold = new Promise(r => { release = r; });
globalThis.__doubaoInProcessWorker = {rehearseBrowsers: async accounts => { assert.equal(accounts.length, 1); entered(); await hold; return {ok: true}; }, generate: () => { throw new Error("unexpected generation"); }};
const {server} = require("../src/server.cjs");
(async () => {
  try {
    await new Promise(r => server.listen(0, "127.0.0.1", r)); const base = `http://127.0.0.1:${server.address().port}`;
    const post = (route, body) => fetch(base + route, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)});
    assert.equal((await post("/api/v1/diagnostics/browser-rehearsal", {accounts: 0})).status, 400);
    const pending = post("/api/v1/diagnostics/browser-rehearsal", {accounts: 1}); await started;
    assert.equal((await post("/api/v1/diagnostics/browser-rehearsal", {accounts: 1})).status, 409);
    assert.equal((await post("/api/v1/video/generate", {prompt: "do not submit"})).status, 409);
    assert.equal((await (await fetch(base + "/health")).json()).accounts[0].busy, true);
    release(); assert.equal((await pending).status, 200);
    assert.equal((await (await fetch(base + "/health")).json()).accounts[0].busy, false);
    assert.equal((await (await fetch(base + "/api/v1/video/jobs")).json()).jobs.length, 0);
    console.log("browser rehearsal API passed: exclusive run, generation blocked, account released, no jobs created");
  } finally { release(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });

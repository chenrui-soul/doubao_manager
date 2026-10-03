"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const data = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-resume-assets-"));
process.env.DOUBAO_DATA_ROOT = data;
process.env.DOUBAO_ACCOUNTS_FILE = path.join(data, "accounts.json");
fs.writeFileSync(process.env.DOUBAO_ACCOUNTS_FILE, JSON.stringify({accounts:[]}));
let calls = 0;
globalThis.__doubaoInProcessWorker = {setProgressHandler() {}, generate() { calls++; throw new Error("must not submit"); }};
const {resumeJob, errorBody} = require("../src/server.cjs");
const {TaskStore} = require("../src/task-store.cjs");
const store = new TaskStore(path.join(data, "jobs.json"));
(async () => {
  for (const [id, asset] of [["scrubbed", {name:"a.png"}], ["deleted", {path:path.join(data,"missing.png")}], ["directory", {path:data}]]) {
    const job = store.create(id, {prompt:"fixture",imageAssets:[asset]});
    store.save({...job,state:"failed",error:{code:"PREVIOUS_FAILURE",message:"original"}});
    await assert.rejects(resumeJob(id), error => {
      assert.equal(error.statusCode,409);
      assert.equal(errorBody(error).code,"DOUBAO_REFERENCE_REUPLOAD_REQUIRED");
      return true;
    });
    assert.equal(store.get(id).state,"failed");
    assert.equal(store.get(id).error.code,"PREVIOUS_FAILURE");
  }
  assert.equal(calls,0);
  console.log("Missing reference recovery blocked before queue/account acquisition; original failure preserved");
})().catch(error => { console.error(error); process.exitCode=1; });

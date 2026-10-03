"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {AccountScheduler} = require(path.join(__dirname, "..", "src", "account-scheduler.cjs"));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "references", "scheduler-exclusion.json"), "utf8"));
const accounts = Array.from({length: fixture.accountCount}, (_, index) => ({id: `account-${String(index + 1).padStart(3, "0")}`, loginState: "logged_in"}));
const scheduler = new AccountScheduler(accounts);
const startedAt = Date.now();
scheduler.acquire(fixture.timeoutMs, "", fixture.excluded).then(() => { throw new Error("排除全部账号后不应获得账号"); }).catch(error => {
  assert.equal(error.code, fixture.expectedCode);
  assert.ok(Date.now() - startedAt < 2000, "排除全部账号后不应长时间等待");
  console.log("scheduler exclusion ok");
}).catch(error => { console.error(error.stack || error); process.exitCode = 1; });

"use strict";

const assert = require("assert");
const {normalizedPayload} = require("../src/server.cjs");
const {accountQuota} = require("../src/quota-summary.cjs");

const payload = normalizedPayload({prompt: "一只猫在窗边看雨", duration: 12, imageAssets: []});
assert.equal(payload.prompt, "一只猫在窗边看雨");
assert.equal(payload.duration, 12);
assert.equal(normalizedPayload({prompt: "竖屏测试", ratio: "9 ： 16"}).ratio, "9:16");
assert.throws(() => normalizedPayload({prompt: "错误规格", resolution: "1080p"}), /没有分辨率控件/);
const quota = accountQuota({id: "account-001", dailyQuotaLimit: 10}, [{id: "job-1", account_id: "account-001", state: "completed", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), payload: {model: "Seedance 2.0 Mini"}}]);
assert.equal(quota.quotaUsedToday, 2);
assert.equal(quota.quotaRemaining, 8);
console.log("smoke ok");

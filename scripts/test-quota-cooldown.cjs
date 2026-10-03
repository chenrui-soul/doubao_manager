"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {AccountStore} = require(path.join(__dirname, "..", "src", "account-store.cjs"));
const {AccountScheduler} = require(path.join(__dirname, "..", "src", "account-scheduler.cjs"));
const {isQuotaExhausted, nextBeijingMidnight} = require(path.join(__dirname, "..", "src", "server.cjs"));
const {detectTrustedQuotaMessage} = require(path.join(__dirname, "..", "src", "vendor", "browser-controller.cjs"));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "references", "quota-cooldown.json"), "utf8"));

for (const item of fixture.timeCases) {
  assert.equal(new Date(nextBeijingMidnight(Date.parse(item.now))).toISOString(), item.expected);
}
for (const signal of fixture.trustedQuotaSignals) assert.equal(isQuotaExhausted(signal), true, JSON.stringify(signal));
for (const message of fixture.untrustedPlainMessages) assert.equal(isQuotaExhausted({message}), false, message);
for (const item of fixture.scopedDetectionCases) assert.equal(detectTrustedQuotaMessage(item.trustedTexts), item.expected, item.name);
for (const message of ["今日可免费生成视频的次数已用完", "视频生成次数已达上限", "剩余视频生成额度为0"]) {
  assert.ok(detectTrustedQuotaMessage([message]), `quota detector should recognize: ${message}`);
}
assert.equal(isQuotaExhausted(null, {quotaExhausted: true}), true);

const runtime = path.join(__dirname, "..", "data", "test-quota-cooldown-runtime");
fs.rmSync(runtime, {recursive: true, force: true});
fs.mkdirSync(runtime, {recursive: true});
const file = path.join(runtime, "accounts.json");
fs.writeFileSync(file, JSON.stringify({accounts: [{id: "account-001", name: "额度测试账号", platform: "豆包", loginState: "logged_in"}]}));
const accountStore = new AccountStore(file);
const quotaDisabledUntil = Date.now() + 60_000;
accountStore.setQuotaDisabledUntil("account-001", quotaDisabledUntil);

const persistedAccount = new AccountStore(file).list()[0];
assert.equal(persistedAccount.quotaDisabledUntil, quotaDisabledUntil);
const restoredScheduler = new AccountScheduler([persistedAccount]);
assert.equal(restoredScheduler.available().length, 0);
assert.equal(restoredScheduler.available({allowPaidQuota: true}).length, 1, "显式付费额度授权才允许选择额度冷却账号");
assert.equal(restoredScheduler.status()[0].disabledReason, "quota_exhausted");
assert.equal(restoredScheduler.enable("account-001"), false);
assert.equal(restoredScheduler.available().length, 0);

accountStore.setQuotaDisabledUntil("account-001", Date.now() - 1);
const nextDayScheduler = new AccountScheduler(accountStore.list());
assert.equal(nextDayScheduler.available().length, 1);
assert.equal(nextDayScheduler.status()[0].disabledUntil, null);
assert.equal(nextDayScheduler.status()[0].disabledReason, null);

const estimatedScheduler = new AccountScheduler([{id: "account-estimated", name: "本地估算测试", loginState: "logged_in"}], {
  quotaProvider: () => ({quotaSource: "local_estimate", quotaRemaining: 0}),
});
assert.equal(estimatedScheduler.available().length, 1, "本地估算归零不代表豆包额度耗尽，仍允许免费任务");
assert.equal(estimatedScheduler.status()[0].quotaEstimatedExhausted, true);
assert.equal(estimatedScheduler.status()[0].dispatchBlockedReason, null);
(async () => {
  const selected = await estimatedScheduler.acquire(1_000);
  assert.equal(selected.id, "account-estimated");
  assert.equal(estimatedScheduler.available().length, 0, "估算不能影响同账号并发锁");
  estimatedScheduler.release(selected);
  estimatedScheduler.disable(selected, 60_000, "quota_exhausted");
  await assert.rejects(() => estimatedScheduler.acquire(1_000), error => error.code === "DOUBAO_ACCOUNTS_QUOTA_EXHAUSTED" && error.notSentVerified && error.quotaConsumed === false);
  const monitor = await estimatedScheduler.acquire(1_000, selected.id, [], {monitorExisting: true});
  assert.equal(monitor.id, selected.id, "额度耗尽仍允许读取原任务");
  estimatedScheduler.release(monitor);
  console.log("quota cooldown ok (persisted until Beijing midnight)");
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

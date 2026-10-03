"use strict";

const assert = require("node:assert/strict");
process.env.DOUBAO_TEST_MODE = "1";
const {normalizedPayload, isAccountSwitchable} = require("../src/server.cjs");

const locked = normalizedPayload({
  prompt: "锁定账号测试",
  preferredAccountId: "account-001",
  accountLockRequired: "true",
});
assert.equal(locked.preferredAccountId, "account-001");
assert.equal(locked.accountLockRequired, true);

const unlocked = normalizedPayload({prompt: "普通任务"});
assert.equal(unlocked.preferredAccountId, "");
assert.equal(unlocked.accountLockRequired, false);

assert.throws(
  () => normalizedPayload({prompt: "缺少账号", accountLockRequired: true}),
  error => error?.code === "DOUBAO_ACCOUNT_TARGET_REQUIRED" && error?.statusCode === 400,
);

const fastDuration = normalizedPayload({prompt: "Fast 页面时长校验", model: "Seedance 2.0 Fast", duration: 15});
assert.equal(fastDuration.duration, 15, "服务端保留 4-15 秒范围，由页面实际控件确认可用值");
assert.equal(normalizedPayload({prompt: "付费额度授权", allowPaidQuota: true}).allowPaidQuota, true);
assert.equal(isAccountSwitchable(null, {code: "DOUBAO_PARAMETER_CONFIG_FAILED", notSentVerified: true}), false, "确定性的参数错误不能切换账号");
assert.equal(isAccountSwitchable(null, {code: "DOUBAO_VIDEO_QUOTA_EXHAUSTED", quotaExhausted: true}), true, "额度错误仍可安全切换账号");
assert.equal(isAccountSwitchable(null, {code: "DOUBAO_VIDEO_QUOTA_EXHAUSTED", quotaExhausted: true, submittedVerified: true}), false, "提交后额度错误不能换号重复提交");

console.log("account targeting normalization passed");

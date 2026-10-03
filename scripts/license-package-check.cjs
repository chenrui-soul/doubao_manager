"use strict";
const assert = require("node:assert/strict");
function readPolicy(text) {
  const policy = JSON.parse(String(text));
  assert.equal(typeof policy?.verificationEnabled, "boolean", "license-policy.json 必须明确设置布尔 verificationEnabled");
  return policy;
}
function checkPackage(readFile, expected) {
  const policy = readPolicy(readFile("config/license-policy.json"));
  assert.equal(policy.verificationEnabled, expected, "成品授权开关与本次构建策略不一致");
  const accounts = JSON.parse(String(readFile("config/accounts.json")));
  assert.deepEqual(accounts, {accounts: []}, "交付包不能预置真实账号");
  return {verificationEnabled: policy.verificationEnabled, defaultAccounts: 0};
}
module.exports = {readPolicy, checkPackage};

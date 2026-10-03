"use strict";
const assert = require("node:assert/strict");
const {readPolicy,checkPackage} = require("./license-package-check.cjs");
for (const value of ["{}", "null", "broken", '{"verificationEnabled":"false"}', '{"verificationEnabled":0}']) assert.throws(() => readPolicy(value));
for (const enabled of [true,false]) {
  const files = {"config/license-policy.json":JSON.stringify({verificationEnabled:enabled}),"config/accounts.json":'{"accounts":[]}'};
  const read = file => { if (!(file in files)) throw new Error("missing " + file); return files[file]; };
  assert.equal(checkPackage(read,enabled).verificationEnabled,enabled);
  assert.throws(() => checkPackage(read,!enabled));
  files["config/accounts.json"]='{"accounts":[{"id":"forbidden"}]}';
  assert.throws(() => checkPackage(read,enabled));
  delete files["config/license-policy.json"];
  assert.throws(() => checkPackage(read,enabled));
}
console.log("License package gate passed: missing/malformed policy, both modes, mode mismatch, bundled accounts");

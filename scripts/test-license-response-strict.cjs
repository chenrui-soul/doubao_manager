"use strict";
const assert = require("node:assert/strict");
const {parseVerification} = require("../src/license.cjs");
const now = Date.parse("2030-01-01T00:00:00Z");
const check = data => parseVerification({success: true, data}, true, "DB-TEST", now);
for (const expires_at of ["2031-01-01T00:00:00Z", null]) {
  for (const valid of [undefined, "false", "true", 0, 1, null, false]) {
    assert.equal(check({valid, status: "active", expires_at}).valid, false, `invalid approval type: ${String(valid)}`);
  }
  for (const status of [undefined, null, "", "revoked", true]) {
    assert.equal(check({valid: true, status, expires_at}).valid, false, `invalid active status: ${String(status)}`);
  }
  assert.equal(check({valid: true, status: "active", expires_at}).valid, true);
}
assert.equal(check({valid:true,status:"active",expires_at:"2030-01-01T00:00:00Z"}).valid,false);
assert.equal(check({valid:true,status:"active",device_code:"OTHER"}).valid,false);
console.log("Strict license response passed: timed/permanent approval types, status, exact expiry, device mismatch");

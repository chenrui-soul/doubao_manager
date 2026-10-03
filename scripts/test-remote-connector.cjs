"use strict";

const assert = require("node:assert/strict");
const {RemoteConnector, allowed, executeJob, validateProfile} = require("../src/remote-connector.cjs");

assert.equal(allowed("GET", "/health"), true);
assert.equal(allowed("GET", "/api/v1/video/jobs/req_abc-123"), true);
assert.equal(allowed("POST", "/api/v1/video/generate"), true);
assert.equal(allowed("POST", "/api/v1/accounts"), false);
assert.equal(allowed("GET", "/api/v1/video/jobs/../../accounts"), false);

assert.deepEqual(validateProfile({server: "https://comic-drama.nexusapi.center", token: "secret"}), {
  server: "https://comic-drama.nexusapi.center",
  token: "secret",
  localOrigin: "http://127.0.0.1:8787",
});
assert.deepEqual(validateProfile({server: "http://192.168.0.102:3014", token: "secret"}), {
  server: "http://192.168.0.102:3014",
  token: "secret",
  localOrigin: "http://127.0.0.1:8787",
});
const credential = `doubao-local-v1.${Buffer.from(JSON.stringify({
  version: 1,
  server: "https://comic-drama.nexusapi.center",
  token: "a".repeat(43),
}), "utf8").toString("base64url")}`;
assert.deepEqual(validateProfile({server: "https://comic-drama.nexusapi.center", token: credential}), {
  server: "https://comic-drama.nexusapi.center",
  token: "a".repeat(43),
  localOrigin: "http://127.0.0.1:8787",
});
assert.throws(() => validateProfile({server: "https://example.com", token: credential}), /不一致/);
assert.throws(() => validateProfile({server: "http://example.com", token: "secret"}), /HTTPS/);
assert.throws(() => validateProfile({server: "https://example.com", token: ""}), /令牌/);
assert.throws(() => validateProfile({server: "https://example.com", token: "secret", localOrigin: "http://192.168.1.2:8787"}), /localhost/);

(async () => {
let called;
const result = await executeJob(
  {localOrigin: "http://127.0.0.1:8787"},
  {method: "POST", path: "/api/v1/video/generate", contentType: "application/json", body: Buffer.from('{"prompt":"test"}').toString("base64")},
  async () => true,
  AbortSignal.timeout(1000),
  async (url, options) => {
    called = {url, options};
    return new Response('{"requestId":"req_test"}', {status: 202, headers: {"content-type": "application/json"}});
  },
);
assert.deepEqual(result, {status: 202, body: '{"requestId":"req_test"}'});
assert.equal(called.url, "http://127.0.0.1:8787/api/v1/video/generate");
assert.equal(called.options.method, "POST");
assert.equal(await new Response(called.options.body).text(), '{"prompt":"test"}');

console.log("remote connector protocol passed");

let calls = 0;
const connector = new RemoteConnector(
  {server: "https://example.com", token: "secret"},
  {
    retryDelayMs: 1,
    fetchImpl: async () => {
      calls += 1;
      return new Response("{\"error\":\"busy\"}", {status: 409});
    },
  },
);
await assert.rejects(() => connector.api("/poll"), error => error.conflict === true && error.retryAfterMs === 50_000);
assert.equal(calls, 1);
console.log("remote connector lease retry passed");
})().catch(error => { console.error(error); process.exitCode = 1; });

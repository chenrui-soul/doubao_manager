"use strict";

// Child-process API tests use the mock worker and must not read or contact a
// real device license. Production server code still enforces the license;
// this harness only replaces the license module before server.cjs loads.
const license = require("../src/license.cjs");
const state = {valid: true, permanent: true, message: "测试授权"};
license.checkLicense = async () => state;
license.requireLicense = async () => state;
const service = require("../src/server.cjs");
const port = Number(process.env.DOUBAO_SERVICE_PORT || 8787);
const host = process.env.DOUBAO_SERVICE_HOST || "127.0.0.1";
const recovered = service.recoverInterruptedJobs();
service.server.listen(port, host, () => {
  service.scheduleRecoveredJobs();
  service.dispatchJobs();
  process.stdout.write(`test server listening on http://${host}:${port} (recovered ${recovered})\n`);
});

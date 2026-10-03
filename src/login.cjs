"use strict";

const {PROFILE_ROOT, TEMP_ROOT, loadAccounts} = require("./config.cjs");
const {DoubaoWorker} = require("./doubao-worker.cjs");
const {requireLicense} = require("./license.cjs");

const accountId = String(process.argv[2] || "").trim();
const account = loadAccounts().find(item => item.id === accountId);
if (!account) { console.error("用法：npm run login -- account-001"); process.exit(1); }

const worker = new DoubaoWorker({profileRoot: PROFILE_ROOT, tempRoot: TEMP_ROOT});
requireLicense({force: true}).then(() => worker.open(account)).then(async () => {
  console.log(`已打开 ${account.name} 的豆包窗口，请手动登录。按 Ctrl+C 退出。`);
  let confirmed = false;
  const timer = setInterval(async () => {
    try { await requireLicense(); const state = await worker.detect(account); if (!confirmed && state.loggedIn && !state.verificationRequired) { confirmed = true; console.log("登录状态已确认，浏览器 Profile 已保存。可以按 Ctrl+C 退出。"); } } catch (error) { console.error(error.message); if (String(error.code || "").startsWith("DOUBAO_LICENSE")) { clearInterval(timer); worker.close(); } }
  }, 3000);
  process.once("SIGINT", () => { clearInterval(timer); worker.close(); process.exit(0); });
}).catch(error => { console.error(error.stack || error.message); process.exit(1); });

"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const {performance} = require("node:perf_hooks");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../references/concurrency.json"), "utf8"));
const args = process.argv.slice(2);
function option(name, fallback, min, max) {
  const i = args.indexOf(`--${name}`), value = i < 0 ? fallback : Number(args[i + 1]);
  assert.ok(Number.isInteger(value) && value >= min && value <= max, `${name} 必须是 ${min}–${max} 的整数`);
  return value;
}
for (let i = 0; i < args.length; i += 2) assert.ok(["--tasks", "--accounts", "--delay"].includes(args[i]), `未知参数：${args[i]}`);
const taskCount = option("tasks", fixture.taskCount, 1, 500), accountCount = option("accounts", fixture.accountCount, 1, 50);
const delayMs = option("delay", fixture.testDelayMs, 50, 60_000);
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-mock-concurrency-"));
Object.assign(process.env, {
  DOUBAO_TEST_MODE: "1", DOUBAO_WORKER_RPC: "0", DOUBAO_TEST_DELAY_MS: String(delayMs),
  DOUBAO_MAX_QUEUE: String(Math.max(100, taskCount)), DOUBAO_SERVICE_HOST: "127.0.0.1",
  DOUBAO_DATA_ROOT: runtime, DOUBAO_PROFILE_ROOT: path.join(runtime, "profiles"),
  DOUBAO_TEMP_ROOT: path.join(runtime, "temp"), DOUBAO_ACCOUNTS_FILE: path.join(runtime, "accounts.json"),
});
fs.writeFileSync(process.env.DOUBAO_ACCOUNTS_FILE, JSON.stringify({accounts: Array.from({length: accountCount}, (_, i) => ({id: `mock-${i + 1}`, name: `模拟账号 ${i + 1}`, loginState: "logged_in", dailyQuotaLimit: 0}))}));
const license = require("../src/license.cjs");
license.checkLicense = license.requireLicense = async () => ({valid: true, message: "隔离模拟测试"});
const {DoubaoWorker} = require("../src/doubao-worker.cjs");
const worker = new DoubaoWorker({profileRoot: process.env.DOUBAO_PROFILE_ROOT, tempRoot: process.env.DOUBAO_TEMP_ROOT});
assert.equal(worker.controller.testMode, true);
const generate = worker.generate.bind(worker), accountActive = new Set(), calls = new Map();
let active = 0, maxGenerating = 0, accountOverlap = 0;
worker.generate = async job => {
  const id = job.account.id;
  if (accountActive.has(id)) accountOverlap++;
  accountActive.add(id); maxGenerating = Math.max(maxGenerating, ++active);
  calls.set(id, (calls.get(id) || 0) + 1);
  try { return await generate(job); }
  finally { active--; accountActive.delete(id); }
};
globalThis.__doubaoInProcessWorker = worker;
const {server} = require("../src/server.cjs");
const {TaskStore} = require("../src/task-store.cjs");
const taskStore = new TaskStore(path.join(runtime, "jobs.json"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = n => Math.round(n * 100) / 100;
const logFile = path.join(__dirname, "log/concurrency-results.json");
const report = {mode: "mock-only", taskCount, accountCount, simulatedGenerationMs: delayMs, runtime};
(async () => {
  const started = performance.now();
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;
    console.log(`模拟测试：${taskCount} 个请求 / ${accountCount} 个模拟账号 / 每次模拟耗时 ${delayMs} ms`);
    console.log("使用独立临时数据和随机本地端口，不访问豆包、不生成视频、不消耗额度。");
    const responses = await Promise.all(Array.from({length: taskCount}, async (_, i) => {
      const at = performance.now();
      const r = await fetch(`${base}/api/v1/video/generate`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({prompt: `模拟并发测试 ${i + 1}`, model: "Seedance 2.0 Mini", ratio: "16:9", duration: 4, allowPaidQuota: false})});
      return {status: r.status, body: await r.json(), ms: performance.now() - at};
    }));
    assert.ok(responses.every(r => r.status === 202), "每个请求都应返回 202");
    assert.equal(new Set(responses.map(r => r.body.requestId)).size, taskCount, "每个请求都有唯一任务编号");
    const times = responses.map(r => r.ms).sort((a, b) => a - b);
    report.acceptanceMs = {p50: round(times[Math.ceil(times.length * .5) - 1]), p95: round(times[Math.ceil(times.length * .95) - 1]), max: round(times.at(-1))};
    const deadline = performance.now() + Math.ceil(taskCount / accountCount) * (delayMs + 1000) + 15_000;
    let jobs = [], nextProgressAt = 0;
    while (performance.now() < deadline) {
      // The public list only returns its most recent 50 tasks. Inspect all
      // isolated records for progress, then verify every result via its API.
      jobs = taskStore.recentJobs(taskCount);
      const completed = jobs.filter(j => j.state === "completed").length;
      if (performance.now() >= nextProgressAt) { console.log(`进度 ${completed}/${taskCount}，正在模拟生成 ${active}，峰值 ${maxGenerating}`); nextProgressAt = performance.now() + 2000; }
      if (jobs.length === taskCount && jobs.every(j => ["completed", "failed", "submission_unknown"].includes(j.state))) break;
      await sleep(40);
    }
    report.completed = jobs.filter(j => j.state === "completed").length;
    report.maxGenerating = maxGenerating; report.accountOverlap = accountOverlap;
    report.accountCalls = Object.fromEntries(calls); report.totalMs = round(performance.now() - started);
    assert.equal(report.completed, taskCount, "所有任务都必须完成");
    assert.equal(maxGenerating, Math.min(accountCount, taskCount), "达到设定并发数且不超出账号数");
    assert.equal(accountOverlap, 0, "同账号不得同时生成多个任务");
    assert.equal([...calls.values()].reduce((a, b) => a + b, 0), taskCount, "不得重复提交");
    jobs = await Promise.all(responses.map(async r => (await fetch(`${base}/api/v1/video/jobs/${r.body.requestId}`)).json()));
    assert.ok(jobs.every(j => j.state === "completed"), "每个任务查询接口都应返回完成状态");
    assert.ok(jobs.every(j => /^mock:\/\//.test(j.watermarkedUrl)), "只能返回模拟结果");
    assert.equal((await (await fetch(`${base}/health`)).json()).queue.active, 0);
    report.passed = true;
    console.log(`通过：${report.completed}/${taskCount} 完成，最大并行 ${maxGenerating}，同账号并发冲突 ${accountOverlap}。`);
    console.log(`接口响应 P50 ${report.acceptanceMs.p50} ms / P95 ${report.acceptanceMs.p95} ms；总耗时 ${round(report.totalMs / 1000)} 秒。`);
  } catch (error) {
    report.passed = false; report.error = error.message;
    console.error(error.stack || error); process.exitCode = 1;
  } finally {
    fs.mkdirSync(path.dirname(logFile), {recursive: true}); fs.writeFileSync(logFile, JSON.stringify(report, null, 2));
    console.log(`测试报告：${logFile}`);
    worker.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (!report.passed) process.exit(1);
  }
})();

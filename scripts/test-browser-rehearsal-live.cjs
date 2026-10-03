"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const args = process.argv.slice(2), index = args.indexOf("--accounts"), count = index < 0 ? 4 : Number(args[index + 1]);
assert.ok(Number.isInteger(count) && count >= 1 && count <= 10, "--accounts 必须为 1 到 10 的整数");
const base = "http://127.0.0.1:8787";
async function call(route, options) { const r = await fetch(base + route, options); const value = await r.json(); if (!r.ok) throw new Error(value.error || `HTTP ${r.status}`); return value; }
(async () => {
  const before = (await call("/api/v1/video/jobs")).jobs.map(j => j.requestId);
  console.log(`真实页面预演：${count} 个账号并行，隐藏打开豆包、选择参数、填写提示词，停止在发送前。`);
  console.log("预演不创建生成任务；结束后保存截图、耗时及内存采样报告。");
  const timer = setInterval(() => console.log("页面预演仍在进行，请保持桌面程序运行…"), 15000);
  let report;
  try { report = await call("/api/v1/diagnostics/browser-rehearsal", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({accounts: count, model: "Seedance 2.0 Mini", ratio: "16:9", duration: 4}), signal: AbortSignal.timeout(240000)}); }
  finally { clearInterval(timer); }
  const assetDir = path.resolve(__dirname, "../assets/browser-rehearsal", report.startedAt.replace(/[:.]/g, "-"));
  fs.mkdirSync(assetDir, {recursive: true});
  for (const result of report.results) {
    if (result.screenshot && fs.existsSync(result.screenshot)) {
      const dest = path.join(assetDir, path.basename(result.screenshot)); fs.copyFileSync(result.screenshot, dest); result.screenshot = dest;
    }
  }
  const after = (await call("/api/v1/video/jobs")).jobs.map(j => j.requestId);
  report.newTaskIds = after.filter(id => !before.includes(id));
  const log = path.join(__dirname, `log/browser-rehearsal-${count}.json`); fs.mkdirSync(path.dirname(log), {recursive: true});
  fs.writeFileSync(log, JSON.stringify(report, null, 2));
  console.table(report.results.map(r => ({account: r.accountId, passed: r.ok, seconds: (r.totalMs / 1000).toFixed(2), failedStep: r.steps.find(s => !s.ok)?.name || "", error: r.error?.message || ""})));
  console.log(`峰值工作集 ${report.peakWorkingSetMB} MB；${report.cpuMetricAvailable ? `CPU 峰值 ${report.peakCpuPercent}%（渲染进程 ${report.peakRendererCpuPercent}%）` : "当前 Electron 未提供 CPU 采样"}；后台页面峰值 ${report.peakAutomationPages}；可见生成窗口峰值 ${report.maxVisibleAutomationPages}。`);
  console.log(`报告：${log}`);
  assert.equal(report.newTaskIds.length, 0, "预演不能创建视频任务");
  assert.equal(report.maxVisibleAutomationPages, 0, "预演页面必须保持隐藏");
  assert.ok(report.results.every(r => r.ok && r.stoppedBeforeSend), "部分页面预演未通过，详见报告");
})().catch(error => { console.error(error.message); process.exitCode = 1; });

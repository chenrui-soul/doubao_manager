"use strict";
const api = "http://127.0.0.1:8787";
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? "").replace(/[&<>\"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[char]));
const stateLabel = item => item.manualControl ? "人工接管中" : item.busy ? "执行中" : item.generationHealth?.blocked ? "生成流程需检查" : item.disabledReason === "quota_exhausted" ? quotaExhaustionLabel(item) : item.disabledReason ? "暂不可用" : ({logged_in:"已登录",awaiting_login:"等待登录",verification:"需要验证",not_logged_in:"未登录",unknown:"未检查"}[item.loginState] || "未检查");
const membershipLabel = item => ({standard_member:"标准套餐",enhanced_member:"加强套餐",premium_member:"高级套餐",no_member:"普通账号"}[item.membershipState] || (item.membershipCheckedAt ? "套餐待确认" : "套餐未检测"));
const quotaExhaustionLabel = item => item.quotaWindowDays ? `近${item.quotaWindowDays}天免费额度已用完` : "豆包确认额度耗尽";
const taskLabel = item => item.manualControl?.active ? "人工接管中" : item.watermarkStatus?.pageVersionPending ? "视频已找回，待确认版本" : item.resultSelectionPending ? "待选择视频" : item.error?.code === "DOUBAO_CONFIRMATION_DELIVERED_WAITING" ? "确认已送达，等待响应" : item.actions?.canConfirm ? "等待生成确认" : item.error?.code === "DOUBAO_ASSET_AUTHORIZATION_REQUIRED" ? "等待安全确认" : item.error?.quotaExhausted ? "额度不足，未继续" : taskStateLabels[item.state] || item.state;
const taskStateLabels = {queued:"排队中",preparing_assets:"准备参考图",selecting_account:"分配账号",checking_login:"检查登录",uploading:"上传参考图",configuring:"配置参数",submitting:"提交中",generating:"生成中",downloading:"读取结果",completed:"已完成",failed:"失败",cancelled:"已取消",submission_unknown:"待人工核对",awaiting_login:"等待登录",awaiting_verification:"等待验证"};
let dashboardAccounts = [], dashboardJobs = [], dashboardHealth = null;
let accountsRefreshing = false, tasksRefreshing = false;
let dashboardPollTimer;
let openingAccountId = "", accountOpenSequence = 0;

function setHtml(selector, html) {
  const node = $(selector);
  if (!node) return false;
  if (node.dataset.renderedHtml === html) return false;
  const scrollTop = node.scrollTop;
  node.innerHTML = html;
  node.scrollTop = scrollTop;
  node.dataset.renderedHtml = html;
  return true;
}
function notify(message, error = false) { $("#windowMeta").textContent = String(message || ""); $("#windowMeta").style.color = error ? "var(--danger)" : ""; }
function openApiDocs() {
  const dialog = $("#apiDocsDialog");
  if (!dialog) return;
  if (dialog.open) return;
  if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
}
async function copyApiText(value, button) {
  const text = String(value || "");
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const input = document.createElement("textarea"); input.value = text; input.style.position = "fixed"; input.style.opacity = "0";
      document.body.appendChild(input); input.select(); document.execCommand("copy"); input.remove();
    }
    const status = $("#apiDocsCopyStatus"); if (status) status.textContent = "已复制到剪贴板";
    if (button) { const original = button.textContent; button.textContent = "已复制"; setTimeout(() => { button.textContent = original; }, 1400); }
  } catch { const status = $("#apiDocsCopyStatus"); if (status) status.textContent = "复制失败，请手动选择文本"; }
}
async function getJson(url, options = {}) { const response = await fetch(`${api}${url}`, options); const value = await response.json().catch(() => ({})); if (!response.ok) throw Object.assign(new Error(value.error || `HTTP ${response.status}`), {code: value.code}); return value; }
const isToday = value => { if (!value) return false; const date = new Date(value), now = new Date(); return date.toDateString() === now.toDateString(); };
const sourceLabel = value => ({desktop:"桌面快速生成",mcp:"MCP",api:"HTTP API"}[value] || value || "HTTP API");
async function refreshAccounts() {
  if ($(".app-shell").hidden || accountsRefreshing) return;
  accountsRefreshing = true;
  try {
    const [value, health] = await Promise.all([getJson("/api/v1/accounts"), getJson("/health")]);
    const allItems = value.accounts || [];
    dashboardAccounts = allItems; dashboardHealth = health; renderDashboard();
    renderAccounts();
    $("#serviceStatus").textContent = "服务运行中"; $(".status-dot").style.background = "var(--green)";
  } catch (error) { $("#serviceStatus").textContent = String(error.code || "").startsWith("DOUBAO_LICENSE") ? "服务运行中 · 请激活授权" : "服务未连接"; $(".status-dot").style.background = "var(--danger)"; setHtml("#accounts", `<div class="empty">${esc(error.message)}</div>`); }
  finally { accountsRefreshing = false; }
}
function renderAccounts() {
    const query = String($("#accountSearch")?.value || "").trim().toLowerCase(), items = dashboardAccounts.filter(item => accountMatches(item, $("#accountFilter").value)).filter(item => !query || `${item.name} ${item.id}`.toLowerCase().includes(query));
    const changed = setHtml("#accounts", items.length ? items.map(item => {
      const limit = Number(item.dailyQuotaLimit || 0), used = Number(item.quotaUsedToday || 0), percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
      return `<div class="account-row"><div class="account-meta"><div class="account-avatar">豆</div><div><div class="account-name-row"><div class="account-name">${esc(item.name)}</div><span title="${esc(item.membershipCheckedAt ? `检测时间：${new Date(item.membershipCheckedAt).toLocaleString()}；套餐状态不代表视频余额` : "尚未检测套餐")}" class="membership-badge membership-${esc(item.membershipState || "unknown")}">${esc(membershipLabel(item))}</span></div><div class="account-id">${esc(item.id)}</div></div></div><div class="account-quota"><div><span>${item.quotaWindowDays ? "免费额度状态" : "实际剩余额度"}</span><strong>${item.quotaExhausted ? "已耗尽" : "待确认"}</strong></div><div class="account-quota-track" title="本地估算用量，仅供参考"><span style="width:${percent}%"></span></div><small>${item.quotaExhausted ? `${esc(quotaExhaustionLabel(item))} · ${item.generationHealth?.blocked ? `<button class="button subtle" data-check-generation="${esc(item.id)}" title="处理原页面问题后检查；不会生成视频">检查生成</button>` : ""}${item.quotaRequiresRecheck ? "恢复时间待确认，暂停调度" : "暂停调度"}` : `估算合计 ${esc(used)} / ${esc(limit)}，含待核实预留 ${esc(item.quotaReservedToday || 0)} · 已完成 ${esc(item.completedToday || 0)} 条`}</small></div><div class="account-actions"><span class="state-text">● ${stateLabel(item)}</span><button class="login-btn" data-open="${esc(item.id)}">打开</button><button class="button subtle" data-check="${esc(item.id)}">检测</button><button class="button subtle" data-quota="${esc(item.id)}" data-used="${esc(used)}" data-limit="${esc(limit)}">校正估算</button>${item.quotaRequiresRecheck ? `<button class="button subtle" data-reset-quota="${esc(item.id)}" title="在豆包页面确认额度已恢复后，允许该账号再次尝试；这不会增加豆包余额">已恢复，重新尝试</button>` : ""}${item.generationHealth?.blocked && !item.quotaExhausted ? `<button class="button subtle" data-check-generation="${esc(item.id)}">检查生成</button>` : ""}<button class="remove-btn" data-remove="${esc(item.id)}">删除</button></div></div>`;
    }).join("") : `<div class="empty">${query ? "没有匹配的账号" : "还没有账号"}</div>`);
    if (!changed) return;
    document.querySelectorAll("[data-open]").forEach(button => button.addEventListener("click", () => openAccount(button.dataset.open)));
    document.querySelectorAll("[data-check]").forEach(button => button.addEventListener("click", () => checkLogin(button.dataset.check)));
    document.querySelectorAll("[data-quota]").forEach(button => button.addEventListener("click", () => adjustQuota(button.dataset.quota, button.dataset.used, button.dataset.limit)));
    document.querySelectorAll("[data-reset-quota]").forEach(button => button.addEventListener("click", () => resetQuotaExhaustion(button.dataset.resetQuota)));
    document.querySelectorAll("[data-check-generation]").forEach(button => button.addEventListener("click", async () => { button.disabled=true; try { const r=await getJson(`/api/v1/accounts/${encodeURIComponent(button.dataset.checkGeneration)}/check-generation`,{method:"POST"}); notify(r.message); await refreshAccounts(); } catch(e) {notify(e.message,true);} finally {button.disabled=false;} }));
    document.querySelectorAll("[data-remove]").forEach(button => button.addEventListener("click", () => removeAccount(button.dataset.remove)));
}
async function openAccount(id) {
  if (openingAccountId === id) return;
  openingAccountId = id;
  const sequence = ++accountOpenSequence;
  const button = document.querySelector(`[data-open="${CSS.escape(id)}"]`);
  if (button) { button.disabled = true; button.textContent = "打开中…"; }
  notify(`${id} · 正在加载豆包页面…`);
  try {
    await getJson(`/api/v1/accounts/${encodeURIComponent(id)}/login`, {method:"POST"});
    if (sequence !== accountOpenSequence) return;
    notify(`${id} · 内嵌窗口已打开`);

  } catch (error) { if (sequence === accountOpenSequence) notify(`打开窗口失败：${error.message}`, true); }
  finally {
    if (sequence === accountOpenSequence) openingAccountId = "";
    if (openingAccountId !== id && button) { button.disabled = false; button.textContent = "打开"; }
    void refreshAccounts();
  }
}
async function checkLogin(id) { const button = document.querySelector(`[data-check="${CSS.escape(id)}"]`); if (button) { button.disabled = true; button.textContent = "检测中"; } try { const value = await getJson(`/api/v1/accounts/${encodeURIComponent(id)}/check-login`, {method:"POST"}); notify(`${id} · ${stateLabel(value.account)}`); } catch (error) { notify(`检测失败：${error.message}`, true); } finally { refreshAccounts(); } }
async function removeAccount(id) { try { await getJson(`/api/v1/accounts/${encodeURIComponent(id)}`, {method:"DELETE"}); notify(`${id} 已删除`); refreshAccounts(); } catch (error) { notify(`删除失败：${error.message}`, true); } }
async function adjustQuota(id, currentUsed, currentLimit) {
  const used = window.prompt(`校正 ${id} 的本地估算用量（当前 ${currentUsed}，参考总量 ${currentLimit}，仅用于统计）`, currentUsed);
  if (used === null) return;
  const value = Number(used);
  if (!Number.isFinite(value) || value < 0) { notify("额度必须是大于等于 0 的数字", true); return; }
  try { await getJson(`/api/v1/accounts/${encodeURIComponent(id)}`, {method:"PATCH", headers:{"content-type":"application/json"}, body:JSON.stringify({quotaUsedToday:value})}); notify(`${id} 的本地额度已校正`); await refreshAccounts(); }
  catch (error) { notify(`额度校正失败：${error.message}`, true); }
}
async function resetQuotaExhaustion(id) {
  try {
    await getJson(`/api/v1/accounts/${encodeURIComponent(id)}`, {method:"PATCH", headers:{"content-type":"application/json"}, body:JSON.stringify({resetQuotaExhaustion:true})});
    notify(`${id} 已允许重新尝试；真实额度仍以豆包为准`);
    await refreshAccounts();
  } catch (error) { notify(`重置额度限制失败：${error.message}`, true); }
}
async function addAccount() { try { const value = await getJson("/api/v1/accounts", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({})}); notify(`${value.account.id} 已新增，正在打开登录窗口`); await refreshAccounts(); await openAccount(value.account.id); } catch (error) { notify(`新增账号失败：${error.message}`, true); } }
function taskSpec(item) { return `${item.ratio || "自动"} · ${item.duration || 10}s`; }
async function refreshTasks() {
  if ($(".app-shell").hidden || tasksRefreshing) return;
  tasksRefreshing = true;
  try {
    const value = await getJson("/api/v1/video/jobs"), items = value.jobs || [];
    dashboardJobs = items; taskSummary = value.summary || {}; renderDashboard(); renderTasks();
    if ($("#taskDetailDialog").open && detailId) await refreshDetail();
  } catch { if (!dashboardJobs.length) setHtml("#tasks", `<div class="empty">任务接口尚未连接</div>`); }
  finally { tasksRefreshing = false; }
}
function scheduleDashboardPoll(delay) {
  clearTimeout(dashboardPollTimer);
  dashboardPollTimer = setTimeout(async () => {
    if (!document.hidden) await Promise.all([refreshAccounts(), refreshTasks()]);
    const active = dashboardJobs.some(item => ["queued", "preparing_assets", "selecting_account", "checking_login", "uploading", "configuring", "submitting", "generating", "downloading"].includes(item.state));
    scheduleDashboardPoll(active ? 2000 : 8000);
  }, delay);
}

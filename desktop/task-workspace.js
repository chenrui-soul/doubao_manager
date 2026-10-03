"use strict";
let taskFilter = "all", taskQuery = "", taskSummary = {}, detailId = "", detailSequence = 0, detailItem = null;
const pendingActions = new Set();
const activeStates = new Set(["queued","preparing_assets","selecting_account","checking_login","uploading","configuring","submitting","generating","downloading"]);
const needsAttention = item => item.manualControl?.active || item.watermarkStatus?.pageVersionPending || item.resultSelectionPending || ["submission_unknown","awaiting_login","awaiting_verification","paused"].includes(item.state);
function accountMatches(item, filter) {
  if (filter === "available") return item.loginState === "logged_in" && !item.busy && !item.disabledReason && !item.generationHealth?.blocked && !item.manualControl;
  if (filter === "quota") return item.disabledReason === "quota_exhausted";
  if (filter === "check") return item.loginState !== "logged_in" || item.generationHealth?.blocked || item.manualControl;
  return true;
}
function renderDashboard() {
  $("#overviewQueued").textContent = taskSummary.queued ?? dashboardJobs.filter(i=>i.state==="queued").length;
  $("#overviewBusy").textContent = taskSummary.active ?? dashboardHealth?.queue?.active ?? 0;
  $("#overviewAttention").textContent = taskSummary.attention ?? dashboardJobs.filter(needsAttention).length;
  $("#overviewCompleted").textContent = taskSummary.todayCompleted ?? dashboardJobs.filter(i=>i.state==="completed"&&isToday(i.createdAt)).length;
  const count = key => dashboardAccounts.filter(i=>accountMatches(i,key)).length;
  $("#quotaAvailable").textContent=count("available"); $("#quotaLimited").textContent=count("quota"); $("#quotaCheck").textContent=count("check");
  $("#quotaSummary").textContent=dashboardAccounts.length ? `共 ${dashboardAccounts.length} 个账号 · 点击分类查看左侧账号` : "还没有账号，请从左侧添加";
  $("#quotaBadge").textContent=count("quota") ? "有额度受限账号" : "实际余额待确认";
  $("#quotaBadge").className=`dashboard-badge${count("quota") ? " warning" : ""}`;
  renderApiRecords();
}
function matchesTask(item) {
  const matches = taskFilter==="all" || taskFilter==="active" && activeStates.has(item.state) || taskFilter==="attention" && needsAttention(item) ||
    taskFilter==="running" && activeStates.has(item.state) && item.state!=="queued" || taskFilter==="queued" && item.state==="queued" || taskFilter==="today" && item.state==="completed" && isToday(item.createdAt) || item.state===taskFilter;
  return matches && (!taskQuery || [item.requestId,item.title,item.promptPreview,item.accountId].join(" ").toLowerCase().includes(taskQuery));
}
const titleOf=item=>item.title||item.promptPreview||item.requestId;
const toneOf=item=>needsAttention(item)?"attention":item.state==="completed"?"success":item.state==="failed"?"failed":"";
const formatTime=value=>value?new Date(value).toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}):"—";
function actionButton(item,action,label,className="button subtle") {
  return `<button type="button" class="${className}" data-action="${action}" data-id="${esc(item.requestId)}" ${pendingActions.has(item.requestId)?"disabled":""}>${label}</button>`;
}
function renderTasks() {
  const items=dashboardJobs.filter(matchesTask);
  $("#taskCount").textContent=`${items.length} / ${dashboardJobs.length} 条${dashboardJobs.length===500?"（最近 500 条）":""}`;
  document.querySelectorAll(".task-filters [data-filter]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.filter===taskFilter)));
  setHtml("#tasks",items.length?`<div class="job-row job-head"><div>任务 / 账号</div><div>视频规格</div><div>当前阶段</div><div>更新时间</div><div>操作</div></div>`+items.map(item=>`<div class="job-row">
    <div>${actionButton(item,"open-session",esc(titleOf(item)),"job-title")}<small title="${esc(item.requestId)}">${esc(item.requestId)}</small><small>${esc(item.accountId||"待分配")}</small></div>
    <div class="job-spec">${esc(item.model||"默认模型")}<small>${esc(taskSpec(item))}</small></div>
    <div><span class="job-state ${toneOf(item)}">${esc(taskLabel(item))}</span>${item.error?.message?`<small title="${esc(item.error.message)}">${esc(item.error.message)}</small>`:""}</div>
    <div class="job-time">${esc(formatTime(item.updatedAt))}</div>
    <div class="job-actions">${actionButton(item,"detail","详情")}${item.actions?.canRecover?actionButton(item,"recover-result","核对并补取视频","button subtle task-inline-action"):""}</div>
  </div>`).join(""):`<div class="empty">${dashboardJobs.length?"没有符合条件的任务，可切换筛选或清空搜索。":"暂无任务。通过创作平台或接口提交后，任务会出现在这里。"}</div>`);
}
function renderApiRecords() {
  $("#apiRecordSummary").textContent=`今日调用 ${taskSummary.todayCalls??dashboardJobs.filter(i=>isToday(i.createdAt)).length} 次 · 以下展示最近 ${dashboardJobs.length} 条任务`;
  setHtml("#apiRecords",dashboardJobs.length?dashboardJobs.map(item=>`<div class="api-record"><div>${esc(formatTime(item.createdAt))}</div><div>${actionButton(item,"detail",esc(item.requestId),"job-title")}<small>${esc(titleOf(item))}</small></div><div>${esc(sourceLabel(item.source))}</div><div><span class="job-state ${toneOf(item)}">${esc(taskLabel(item))}</span>${item.error?.message?`<p>${esc(item.error.message)}</p>`:""}</div></div>`).join(""):'<div class="empty">暂无接口调用记录</div>');
}
function setTaskFilter(value) {taskFilter=value;renderTasks();$("#recentTitle").scrollIntoView({block:"nearest"});}
function validResultUrl(item) {const url=item?.watermarkFreeUrl||item?.watermarkedUrl||"";try{return ["http:","https:"].includes(new URL(url).protocol)?url:"";}catch{return "";}}
const actionNames={"open-session":"查看原会话",takeover:"人工接管","end-takeover":"结束接管并补取",recheck:"重新核对状态","continue-confirmation":"继续确认","recover-result":"核对并补取视频","adopt-result":"采用此视频","retry-watermark":"重试获取无水印","accept-page-result":"采用页面版本（可能带水印）"};
function renderWatermarkStatus(item) {
  const status=item.watermarkStatus;
  if(!status?.videoFound)return "";
  const pageUrl=validResultUrl(item.pendingWatermarkResult);
  return `<section class="result-candidates watermark-status"><h3>视频与水印状态</h3><p>视频已找回 · ${status.watermarkFreeObtained?"无水印已取得":"无水印尚未取得"}</p>
    ${!status.watermarkFreeObtained?`<p class="dashboard-muted">页面版本的水印状态未确认，可能带水印。豆包中已设置无水印，也需取得对应视频地址后才能确认。</p>${item.lastWatermarkError?.message||item.watermarkFreeError?`<p class="detail-error">无水印获取原因：${esc(item.lastWatermarkError?.message||item.watermarkFreeError)}</p>`:""}`:""}
    ${status.pageVersionPending?`<p>尚未采用页面版本。建议先重试获取无水印；如需采用当前版本，请预览后确认。</p>${pageUrl?`<div class="detail-results"><a href="${esc(pageUrl)}" target="_blank" rel="noopener noreferrer">预览页面版本 ↗</a></div>`:""}`:""}
    ${status.pageVersionAccepted&&!status.watermarkFreeObtained?"<p>已按你的确认采用页面版本，仍可重试获取无水印。</p>":""}
    ${status.watermarkFreeObtained&&item.watermarkFreeRetrievedAt?"<small class=\"dashboard-muted\">原任务已更新无水印地址；创作平台若已下载旧版本，需要在平台更新素材。</small>":""}</section>`;
}
function renderResultCandidates(item) {
  const review=item.resultReview;
  if(!review?.candidates?.length||item.state==="completed")return "";
  return `<section class="result-candidates"><h3>选择要回传的视频</h3><p class="dashboard-muted">以下视频来自原账号、原会话。请核对预览和回复内容后采用，结果将保存到这条原任务。</p>${review.candidates.map((c,index)=>`<article class="result-candidate">
    ${c.poster?`<img src="${esc(c.poster)}" alt="视频 ${index+1} 封面" loading="lazy">`:""}<div><strong>视频 ${index+1}</strong><p>${esc(c.text||"视频卡片")}</p><small>结果消息：${esc(c.messageId)}</small>
    <div class="detail-results">${validResultUrl({watermarkedUrl:c.url})?`<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">预览视频 ↗</a>`:""}<button type="button" class="button subtle" data-action="adopt-result" data-id="${esc(item.requestId)}" data-candidate="${esc(c.id)}" data-review="${esc(review.id)}" ${pendingActions.has(item.requestId)||!item.actions?.canRecover||c.ambiguous?"disabled":""}>采用此视频并回传</button></div>${c.ambiguous?'<small>此卡片包含多个视频标识，请先在原会话打开具体视频后重新核对。</small>':""}</div>
  </article>`).join("")}</section>`;
}
function renderDetail(item) {
  detailItem=item;
  $("#taskDetailTitle").textContent=titleOf(item);$("#detailRequestId").textContent=item.requestId;
  const a=item.actions||{},url=validResultUrl(item);
  const fields=[["当前阶段",taskLabel(item)],["原账号",item.accountId||"待分配"],["原会话",item.conversationId||"尚未关联豆包会话"],["视频规格",`${item.model||"默认模型"} · ${taskSpec(item)}`],["来源",sourceLabel(item.source)],["付费额度",item.allowPaidQuota?"原任务允许":"不允许自动使用"],["创建时间",formatTime(item.createdAt)],["更新时间",formatTime(item.updatedAt)]];
  const times=Object.entries(item.timings||{}).filter(([k,v])=>k.endsWith("At")&&v);
  const names={queuedAt:"进入队列",accountAcquiredAt:"取得账号",modeReadyAt:"参数就绪",submittedAt:"发送阶段",providerStartedAt:"发现生成证据",providerCompletedAt:"发现完成结果",resultReturnedAt:"结果已保存"};
  const expanded=[...document.querySelectorAll("#taskDetailBody details[open]")].map(d=>d.dataset.section);
  const previousScroll=$("#taskDetailBody").scrollTop;
  setHtml("#taskDetailBody",`<dl class="detail-grid">${fields.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
    ${item.error?.message?`<div class="detail-error">${item.resultSelectionPending||item.watermarkStatus?.pageVersionPending?"此前豆包回复（新视频待确认）：":""}${esc(item.error.message)}</div>`:""}
    ${item.lastRecoveryError?.message?`<div class="detail-error">最近补取未完成：${esc(item.lastRecoveryError.message)}</div>`:""}
    ${renderResultCandidates(item)}
    ${renderWatermarkStatus(item)}
    ${url?`<h3>视频结果</h3><div class="detail-results"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">查看视频 ↗</a>${actionButton(item,"copy-result","复制结果地址")}</div><small class="dashboard-muted">工作台已取得结果；创作平台同步状态请在平台核对。</small>`:""}
    <h3>完整提示词</h3><div class="detail-prompt">${esc(item.prompt||item.promptPreview||"未保存提示词")}</div>
    ${times.length?`<h3>关键时间</h3><dl class="detail-grid">${times.map(([k,v])=>`<div><dt>${esc(names[k]||k)}</dt><dd>${esc(formatTime(v))}</dd></div>`).join("")}</dl>`:""}
    <h3>处理记录</h3>${item.actionHistory?.length?`<ul class="action-log">${item.actionHistory.slice().reverse().map(h=>`<li>${esc(actionNames[h.action]||h.action)} · ${esc({completed:"已完成",accepted:"已受理",failed:"未完成",needs_selection:"待选择视频",needs_attention:"需人工处理"}[h.status]||h.status)}<small> ${esc(formatTime(h.at))}</small>${h.message?`<div>${esc(h.message)}</div>`:""}</li>`).join("")}</ul>`:'<small class="dashboard-muted">暂无人工处理记录</small>'}
    <details data-section="diagnostic"><summary>诊断与提交证据</summary><pre>${esc(JSON.stringify({error:item.error||null,submittedEvidence:item.submittedEvidence||null,lastReview:item.lastReview||null},null,2))}</pre></details>`);
  for(const key of expanded)document.querySelector(`#taskDetailBody details[data-section="${key}"]`)?.setAttribute("open","");
  $("#taskDetailBody").scrollTop=previousScroll;
  const buttons=[];
  if(a.canOpen)buttons.push(actionButton(item,"open-session","只读查看原会话"));
  if(a.canEndTakeover){buttons.push(actionButton(item,"takeover","打开接管窗口"));buttons.push(actionButton(item,"end-takeover","结束接管并补取","login-btn"));}
  else if(a.canTakeover)buttons.push(actionButton(item,"takeover","人工接管"));
  if(a.canRecheck)buttons.push(actionButton(item,"recheck","重新核对状态"));
  if(a.canConfirm)buttons.push(actionButton(item,"continue-confirmation","继续确认","login-btn"));
  if(a.canRecover)buttons.push(actionButton(item,"recover-result","核对并补取视频","login-btn"));
  if(a.canRetryWatermark)buttons.push(actionButton(item,"retry-watermark","重试获取无水印","login-btn"));
  if(a.canAcceptPageResult)buttons.push(actionButton(item,"accept-page-result","采用页面版本（可能带水印）"));
  setHtml("#taskDetailActions",buttons.join(""));
  if(!pendingActions.has(item.requestId))$("#detailFeedback").textContent=a.reason||"操作针对原任务执行。核对与补取不发送生成消息。";
}
async function refreshDetail() {
  const id=detailId,seq=++detailSequence;
  try {const item=await getJson(`/api/v1/video/jobs/${encodeURIComponent(id)}`);if(seq===detailSequence&&id===detailId)renderDetail(item);}
  catch(e){if(seq===detailSequence)$("#detailFeedback").textContent=e.message;}
}
async function openDetail(id) {
  detailId=id;detailItem=null;$("#taskDetailTitle").textContent="正在读取任务";$("#detailRequestId").textContent=id;
  setHtml("#taskDetailBody","");setHtml("#taskDetailActions","");$("#detailFeedback").textContent="";
  const dialog=$("#taskDetailDialog");if(!dialog.open)dialog.showModal();
  await refreshDetail();
}
async function performTaskAction(id,action,input={}) {
  if(action==="detail"){await openDetail(id);return;}
  if(action==="copy-result"){await copyApiText(validResultUrl(detailItem));$("#detailFeedback").textContent="结果地址已复制";return;}
  if(pendingActions.has(id))return;
  if(action==="accept-page-result"){
    if(detailItem?.requestId!==id||!detailItem.pendingWatermarkResult)return;
    if(!window.confirm("尚未取得可确认的无水印地址。采用当前页面版本可能带水印，并会将该版本作为原任务结果回传。确认采用吗？"))return;
    input={reviewId:detailItem.pendingWatermarkResult.id,acceptWatermarked:true};
  }
  const cached=dashboardJobs.find(i=>i.requestId===id);
  if(action==="open-session"&&cached?.actions?.canOpen===false){await openDetail(id);return;}
  pendingActions.add(id);renderTasks();if(detailItem?.requestId===id)renderDetail(detailItem);
  if(detailId===id)$("#detailFeedback").textContent=`${actionNames[action]||action}进行中…`;
  let failure="";
  try {
    const route=action==="adopt-result"?"recover-result":action;
    const value=await getJson(`/api/v1/video/jobs/${encodeURIComponent(id)}/${route}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});
    const feedback=value.recoveryFeedback||value.result;
    const message=action==="open-session"?"已打开原账号原会话，只读查看":action==="takeover"?"已交接操作权；完成后请返回详情结束接管":action==="continue-confirmation"?"已受理一次普通确认，后台将先核对页面":feedback?.message||"已核对原会话";
    notify(message,feedback?.needsAttention===true);
    if((action==="takeover"||feedback?.needsSelection||feedback?.needsWatermarkChoice||route==="recover-result")&&(!$("#taskDetailDialog").open||detailId!==id))await openDetail(id);
    await Promise.all([refreshTasks(),refreshAccounts()]);
    if(detailId===id)await refreshDetail();
    if(feedback?.needsSelection)document.querySelector(".result-candidates")?.scrollIntoView({block:"start"});
  }catch(e){failure=e.message;notify(failure,true);}
  finally{pendingActions.delete(id);renderTasks();if(detailItem?.requestId===id)renderDetail(detailItem);if(failure&&detailId===id)$("#detailFeedback").textContent=failure;scheduleDashboardPoll(1000);}
}
function taskActionClick(event){const button=event.target.closest("[data-action]");if(button&&!button.disabled)void performTaskAction(button.dataset.id,button.dataset.action,button.dataset.action==="adopt-result"?{candidateId:button.dataset.candidate,reviewId:button.dataset.review}:{});}
$("#refreshDashboard").addEventListener("click",()=>{void refreshAccounts();void refreshTasks();});
$("#addAccount").addEventListener("click",addAccount);$("#addAccountCard").addEventListener("click",addAccount);
$("#accountSearch").addEventListener("input",renderAccounts);$("#accountFilter").addEventListener("change",renderAccounts);
$("#refreshTasks").addEventListener("click",refreshTasks);
$("#taskSearch").addEventListener("input",e=>{taskQuery=e.target.value.trim().toLowerCase();renderTasks();});
document.querySelectorAll("[data-filter]").forEach(b=>b.addEventListener("click",()=>setTaskFilter(b.dataset.filter)));
document.querySelectorAll("[data-account-filter]").forEach(b=>b.addEventListener("click",()=>{$("#accountFilter").value=b.dataset.accountFilter;renderAccounts();$("#accounts").scrollTop=0;}));
for(const id of ["tasks","apiRecords","taskDetailBody","taskDetailActions"])$("#"+id).addEventListener("click",taskActionClick);
$("#closeTaskDetail").addEventListener("click",()=>$("#taskDetailDialog").close());
$("#taskDetailDialog").addEventListener("close",()=>{detailId="";detailItem=null;detailSequence++;});
$("#hideWindow").addEventListener("click",()=>window.doubaoDesktop.browserAction("hide"));
$("#batchCheck").addEventListener("click",async()=>{for(const button of document.querySelectorAll("[data-check]"))await checkLogin(button.dataset.check);notify("批量检测完成");});
$("#batchLogin").addEventListener("click",()=>notify("请在左侧逐个打开账号完成登录"));
$("#manageGroup").addEventListener("click",()=>notify("可使用状态筛选和账号搜索"));
$("#openData").addEventListener("click",()=>window.doubaoDesktop.openData());
$("#openApi").addEventListener("click",openApiDocs);
function selectApiTab(records){
  $("#apiGuidePanel").hidden=records;$("#apiRecordsPanel").hidden=!records;
  for(const [id,selected]of[["apiGuideTab",!records],["apiRecordsTab",records]]){$("#"+id).setAttribute("aria-selected",String(selected));$("#"+id).tabIndex=selected?0:-1;}
}
$("#apiGuideTab").addEventListener("click",()=>selectApiTab(false));$("#apiRecordsTab").addEventListener("click",()=>selectApiTab(true));
document.querySelector(".api-tabs").addEventListener("keydown",e=>{if(["ArrowLeft","ArrowRight"].includes(e.key)){e.preventDefault();const records=$("#apiGuideTab").getAttribute("aria-selected")==="true";selectApiTab(records);$(records?"#apiRecordsTab":"#apiGuideTab").focus();}});
document.querySelectorAll("[data-copy]").forEach(button=>button.addEventListener("click",()=>copyApiText(button.dataset.copy,button)));
refreshAccounts();refreshTasks();scheduleDashboardPoll(8000);

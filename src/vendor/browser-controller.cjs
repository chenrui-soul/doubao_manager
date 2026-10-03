"use strict";

const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const {spawn} = require("child_process");
const {VideoDownloader} = require("./video-downloader.cjs");
const {probeComposer, probeConversationTurn} = require("./composer-guard.cjs");
const {probePageBlocker} = require("./page-blockers.cjs");
const {reconcileVideoParameters} = require("./video-parameters.cjs");
const {DOUBAO_LOGIN_PROBE_EXPRESSION, classifyDoubaoLoginState, hasDecisivePageLoginSignal} = require("./doubao-login-state.cjs");
const {extractVideoVids, normalizeVideoVid, isVideoResourceRequest} = require("./doubao-video-identifiers.cjs");
const {resolveDoubaoWatermarkFreeVideo, isTrustedDoubaoVideoUrl, summarizeWatermarkFreeError} = require("./doubao-watermark-free-resolver.cjs");

// Electron 主进程通常没有浏览器侧的 WebSocket 全局对象；Node 22 有时有，Electron 31 不一定有。
// 显式使用 ws，保证打包后的桌面程序能够连接 Chrome DevTools Protocol。
const WebSocketImpl = globalThis.WebSocket || require("ws");

const DOUBAO_VIDEO_MODELS = new Set(["Seedance 2.0 Fast", "Seedance 2.0 Mini"]);
const DOUBAO_VIDEO_RATIOS = new Set(["自动", "3:4", "4:3", "9:16", "16:9", "1:1", "21:9"]);
const REFERENCE_ROLE_LABELS = {character:"人物/角色",scene:"场景",prop:"道具",costume:"服装",pose:"姿势/构图",style:"风格",["first-frame"]:"首帧",["last-frame"]:"尾帧",other:"其他"};

// UI waits are only polling intervals and short input/paint settling windows.
// They must never replace a state check: a faster probe is safe, a blind sleep
// is what caused the prompt/parameter races in the first place.
const UI_TIMINGS = Object.freeze({
  composerPollMs: 60,
  composerStableMs: 220,
  composerReadyPollMs: 100,
  sendRetryMs: 80,
  mouseMoveMs: 12,
  mousePressMs: 45,
  filePickerPollMs: 100,
  uploadProbeMs: 120,
  uploadStableMs: 360,
  menuSettlingMs: 100,
  modePollMs: 120,
  submissionProbeMs: 120,
});

function uiTiming(session, name) {
  const override = Number(session?.uiTimings?.[name]);
  return Number.isFinite(override) && override >= 0 ? override : UI_TIMINGS[name];
}

function normalizeVideoParameters(payload = {}) {
  const requestedModel=String(payload.doubaoModel||"").trim();const requestedRatio=String(payload.ratio||"").trim();
  const model=DOUBAO_VIDEO_MODELS.has(requestedModel)?requestedModel:"Seedance 2.0 Mini";
  const seconds=Math.max(4,Math.min(15,Number.parseInt(String(payload.duration||"10"),10)||10));

  return {model,ratio:DOUBAO_VIDEO_RATIOS.has(requestedRatio)?requestedRatio:"自动",duration:seconds};
}

function normalizeReferenceAssets(payload = {}) {
  const source=Array.isArray(payload.imageAssets)?payload.imageAssets:[];
  const unique=[];
  for(const item of source){
    if(!item||item.type&&item.type!=="image")continue;
    const filePath=path.resolve(String(item.path||""));
    if(!filePath||!fs.existsSync(filePath)||!fs.statSync(filePath).isFile())throw referenceUploadError(`参考图片文件不存在：${item.name||item.id||path.basename(filePath)}`);
    const ext=path.extname(filePath).toLowerCase();
    if(![".jpg",".jpeg",".png",".webp"].includes(ext))throw referenceUploadError(`豆包参考图不支持该格式：${path.basename(filePath)}`);
    if(unique.some(asset=>asset.path.toLowerCase()===filePath.toLowerCase()))continue;
    const name=String(item.name||item.originalName||path.basename(filePath));const role=normalizeReferenceRole(item.role||inferReferenceRole({...item,name}));const label=String(item.label||name).trim().slice(0,120)||name;const description=String(item.description||defaultReferenceDescription({role,label})).trim().slice(0,500);
    unique.push({id:String(item.id||`asset-${unique.length+1}`),name,originalName:String(item.originalName||path.basename(filePath)),mime:String(item.mime||"image/*"),size:Number(item.size||fs.statSync(filePath).size),path:filePath,role,label,description,order:Math.max(1,Math.min(10,Number(item.order)||unique.length+1))});
  }
  if(unique.length>10)throw referenceUploadError("单个豆包任务最多上传 10 张参考图，请精简人物、场景和道具素材");
  return unique.sort((a,b)=>a.order-b.order);
}

function normalizeReferenceRole(value) { const role=String(value||"").trim();return Object.hasOwn(REFERENCE_ROLE_LABELS,role)?role:"other"; }
function inferReferenceRole(item = {}) {
  const text=[item.name,item.originalName,item.notes,...(Array.isArray(item.tags)?item.tags:[])].filter(Boolean).join(" ");
  if(/首帧|第一帧|起始帧/.test(text))return"first-frame";if(/尾帧|末帧|结束帧/.test(text))return"last-frame";if(/场景|环境|建筑|室内|室外|街道|巷|便利店|房间|背景/.test(text))return"scene";if(/道具|物件|物品|武器|伞|车辆|手机|杯|门|桌|椅/.test(text))return"prop";if(/服装|服饰|衣服|造型|妆容/.test(text))return"costume";if(/姿势|动作|构图|机位|运镜/.test(text))return"pose";if(/风格|色调|画风|质感|光影/.test(text))return"style";if(/人物|角色|男主|女主|男人|女人|男孩|女孩|店员|陌生人|头像|人像/.test(text))return"character";return"other";
}
function defaultReferenceDescription(item = {}) {
  const role=normalizeReferenceRole(item.role),label=String(item.label||item.name||"参考素材").trim();
  return {character:`角色“${label}”的人物外观参考，只参考人物身份、发型、服装和整体造型。`,scene:`场景“${label}”的环境参考，用于空间、建筑、灯光、天气和氛围。`,prop:`道具“${label}”的造型参考，用于外形、颜色、材质和细节。`,costume:`服装“${label}”的造型参考，用于服饰、配色和穿着细节。`,pose:`“${label}”的姿势与构图参考，用于动作、机位和画面布局。`,style:`“${label}”的视觉风格参考，用于画风、色调、光影和质感。`,["first-frame"]:`“${label}”作为视频首帧参考，保持起始画面的主体与构图。`,["last-frame"]:`“${label}”作为视频尾帧参考，保持结束画面的主体与构图。`,other:`“${label}”作为补充参考图，仅使用与视频内容相关的视觉信息。`}[role];
}
function buildReferenceManifest(assets = []) { return assets.map((asset,index)=>`图${index+1}（${REFERENCE_ROLE_LABELS[normalizeReferenceRole(asset.role)]}）：${asset.description||defaultReferenceDescription(asset)}`); }
function buildReferencePrompt(prompt, assets = []) {
  // 图片会作为真实附件上传到豆包对话框，豆包可直接读取附件内容；
  // 不再把长篇“参考图使用说明”拼进用户提示词，避免污染原始创作意图。
  return String(prompt || "").trim();
}

// Only use this representation for matching DOM text back to the submitted
// prompt. The original prompt is always preserved for the actual submission.
function normalizeComparableText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[，、]/g, ",")
    .replace(/[。]/g, ".")
    .replace(/[：]/g, ":")
    .replace(/[；]/g, ";")
    .replace(/[！]/g, "!")
    .replace(/[？]/g, "?")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[【]/g, "[")
    .replace(/[】]/g, "]")
    .replace(/[「」『』]/g, "")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[…]/g, "...")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\*_#>~`]/g, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function referenceUploadError(message, extra = {}) {
  return Object.assign(new Error(String(message||"参考图上传失败")),{providerTerminal:true,terminalFailureVerified:true,safeToRetry:true,notSentVerified:true,code:"DOUBAO_ASSET_UPLOAD_FAILED",category:"asset_upload",retryMode:"edit_assets",requiresPromptEdit:false,userAction:"参考图没有完整上传到豆包，本次提示词尚未发送。请检查或替换素材后安全重试。",quotaConsumed:false,...extra});
}

function detectTrustedQuotaMessage(values = []) {
  const text=(Array.isArray(values)?values:[values]).map(value=>String(value||"")).join(" ").replace(/\s+/g," ").trim();
  const rolling=text.match(/(?:最近|近|过去)\s*(?:30|7|三十|七)\s*天\s*免费\s*额度\s*(?:已\s*)?(?:用完|耗尽)/i);
  const match=rolling||text.match(/(?:视频|生成).{0,20}(?:免费)?(?:次数|额度).{0,14}(?:没有|不足|用完|耗尽|上限|已达上限|为\s*0|为零)|(?:今日|本日).{0,20}(?:视频|生成).{0,20}(?:免费)?(?:次数|额度).{0,14}(?:没有|不足|用完|耗尽|上限|已达上限|为\s*0|为零)|(?:额度|次数).{0,16}(?:不足|用完|耗尽|上限|已达上限|为\s*0|为零).{0,16}(?:视频|生成)/i);
  return match?match[0]:"";
}

function detectQuotaMessage(value) {
  return detectTrustedQuotaMessage([value]);
}

function isPaidQuotaConfirmation(value) {
  const text = String(value || "").replace(/\\s+/g, " ").trim();
  return /(?:本次|此次).{0,24}(?:将消耗|使用|消耗)付费额度/i.test(text)
    && /(?:是否继续|确认生成|继续生成|确认后)/i.test(text);
}

function shouldRequestGenerationConfirmation(value) {
  const text=String(value||"").replace(/\s+/g," ").trim();
  if(!text)return false;
  const flat=text.replace(/\s+/g,"");
  if(/(?:视频生成参数确认|生成参数确认|确认后我再开始生成|请确认.{0,80}(?:模型|比例|画幅|时长)|我将以.{0,80}生成一段.{0,40}视频|视频生成参数如下)/i.test(text))return true;
  if(/需要我.{0,32}(?:直接)?(?:帮你)?生成|直接帮你生成|要不要(?:我)?生成/i.test(text))return true;
  // Some Doubao versions return a complete storyboard titled “视频生成指令”
  // instead of creating the task. Treat the instruction-only response as a
  // confirmation request when it contains generation-spec markers.
  if (/(?:Seedance\s*2\.[05]|视频)生成指令/i.test(text)
    && /(?:分镜|时间轴|约束规则|画幅|时长|模型|镜头|声音与音乐)/.test(flat)) return true;
  // The desktop workbench can return a full storyboard/prompt package without
  // using the words “确认参数”. It is still a planning response: no task card
  // exists yet and the next human action is the short confirmation message.
  const planningMarkers = [
    /完整可直接复制的prompt/i,
    /(?:时间轴|镜头\s*\d{2,}|目标时长最终状态)/i,
    /(?:连续性硬约束|禁止项|约束规则)/i,
  ];
  const markerCount = planningMarkers.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
  return markerCount >= 2 && /(?:视频|生成|Seedance|画幅|时长)/i.test(text);
}

function validateSubmissionContextState(state = {}, expectedConversationId = "") {
  const currentConversationId=String(state.conversationId||"").trim(),expected=String(expectedConversationId||"").trim();
  const conversationMatched=Boolean(currentConversationId)&&(!expected||currentConversationId===expected);
  const promptMatched=state.promptPresentInCurrentConversation===true&&state.userMessage===true;
  return {matched:conversationMatched&&promptMatched,conversationMatched,promptMatched,conversationId:currentConversationId,expectedConversationId:expected,userMessageId:String(state.userMessageId||""),bindingMode:String(state.bindingMode||"")};
}

function probeDoubaoVideoResultPage() {
  const validVid=value=>{const text=String(value||"").trim();return !/^https?:\/\//i.test(text)&&/^[a-z0-9_-]{8,240}$/i.test(text)?text:""};
  const candidates=[],seen=new WeakSet();
  const add=(videoVid,url="")=>{const vid=validVid(videoVid);if(!vid)return;const normalizedUrl=/^https?:\/\//i.test(String(url||""))?String(url):"";if(!candidates.some(item=>item.videoVid===vid&&item.url===normalizedUrl))candidates.push({videoVid:vid,url:normalizedUrl})};
  const scan=(value,depth=0)=>{
    if(value==null||depth>10)return;
    if(typeof value==="string"){
      if(value.length<200000&&/["'](?:vid|video_id|videoId)["']\s*:/.test(value))try{scan(JSON.parse(value),depth+1)}catch{}
      return;
    }
    if(typeof value!=="object"||seen.has(value))return;seen.add(value);
    add(value.vid||value.video_id||value.videoId,value.download_url||value.downloadUrl||value.url);
    for(const [key,item] of Object.entries(value)){
      if(["ref","_owner","stateNode","return","alternate","child","sibling"].includes(key)||String(key).startsWith("__react"))continue;
      scan(item,depth+1);
    }
  };
  const allMessages=[...document.querySelectorAll('[data-message-id]')];
  const messages=allMessages.filter(node=>/你的视频生成好了|视频生成完成|生成结果/.test(node.innerText||node.textContent||"")||Boolean(node.querySelector?.('video,[class*="block-video"],[class*="video-player"],[class*="play-icon-wrapper"],[data-testid*="video"]')));
  const message=messages[messages.length-1]||null,card=message?.querySelector?.('[class*="block-video"],[class*="video-player"],[class*="play-icon-wrapper"],[data-testid*="video"],video')||null;
  for(const node of [card,message].filter(Boolean)){
    for(const key of Object.keys(node)){
      if(key.startsWith("__reactProps$"))scan(node[key],0);
      if(!key.startsWith("__reactFiber$"))continue;
      let fiber=node[key];for(let index=0;fiber&&index<16;index+=1,fiber=fiber.return){scan(fiber.memoizedProps,0);scan(fiber.pendingProps,0);scan(fiber.memoizedState,0);}
    }
  }
  const descriptor=candidates[candidates.length-1]||{videoVid:"",url:""};
  const videos=[...document.querySelectorAll('video')].map(video=>({url:video.currentSrc||video.src,readyState:video.readyState,duration:video.duration}));
  const playable=videos.find(video=>/^https?:\/\//i.test(video.url||"")&&video.readyState>=2),ready=Boolean(message)||/你的视频生成好了|视频生成完成|生成结果/.test(String(document.body?.innerText||""));
  if(playable?.url)return{...playable,ready:true,videoVid:descriptor.videoVid,descriptorUrl:descriptor.url,messageId:message?.getAttribute?.("data-message-id")||""};
  if(ready&&card&&!window.__lingframeResultCardClicked){card.click();window.__lingframeResultCardClicked=true;return{clicked:true,ready:true,videoVid:descriptor.videoVid,descriptorUrl:descriptor.url,messageId:message?.getAttribute?.("data-message-id")||""};}
  return{ready,videoVid:descriptor.videoVid,descriptorUrl:descriptor.url,messageId:message?.getAttribute?.("data-message-id")||""};
}

function classifyDoubaoFailureMessage(value) {
  const raw=String(value||"").trim();
  const text=raw.replace(/\s+/g," ");
  const empty={failed:false,outcomeCode:"",terminal:false,providerTerminal:false,terminalFailureVerified:false,submittedVerified:false,safeToRetry:false,notSentVerified:false,code:"",category:"",retryMode:"",accountAction:"hold",requiresPromptEdit:false,userAction:"",providerMessage:"",providerMessageRaw:"",quotaExhausted:false,quotaConsumed:null,evidence:null};
  if(!text)return empty;
  const noCharge=/(?:生成)?额度(?:未|没有|不会)(?:扣除|消耗)|未扣除(?:生成)?额度|本次不消耗额度/i.test(text);
  const rules=[
    {code:"DOUBAO_VIDEO_QUOTA_EXHAUSTED",category:"quota",retryMode:"switch_account",requiresPromptEdit:false,userAction:"当前可用额度已用完，请切换其他账号；恢复时间以豆包额度页面为准，近7天/近30天额度不按当天零点恢复。",pattern:/(?:最近|近|过去)\s*(?:30|7|三十|七)\s*天\s*免费\s*额度\s*(?:已\s*)?(?:用完|耗尽)|(?:视频|生成).{0,20}(?:免费)?(?:次数|额度).{0,14}(?:没有|不足|用完|耗尽|上限|已达上限|为\s*0|为零)|(?:今日|本日).{0,20}(?:视频|生成).{0,20}(?:免费)?(?:次数|额度).{0,14}(?:没有|不足|用完|耗尽|上限|已达上限|为\s*0|为零)|(?:额度|次数).{0,16}(?:不足|用完|耗尽|上限|已达上限|为\s*0|为零).{0,16}(?:视频|生成)/i,quotaExhausted:true},
    {code:"DOUBAO_VIDEO_NOT_CREATED",category:"provider_generation",retryMode:"switch_account",requiresPromptEdit:false,userAction:"豆包只返回了视频提示词，没有创建视频任务；当前账号已释放并切换其他账号重试。",pattern:/(?:^|\s)(?:#{1,6}\s*)?(?:AI\s*)?视频生成提示词(?=\s|[（(：:]|$)/i},
    {code:"DOUBAO_FACE_REFERENCE_REJECTED",category:"portrait_policy",retryMode:"edit_assets",requiresPromptEdit:false,userAction:"豆包因肖像保护拒绝了真人脸参考图。请更换为非真人肖像、AI生成角色设定图或动漫角色图，也可以移除人物图后改用文生视频。",pattern:/(?:肖像保护|真人脸|真人面孔|真实人脸|真人肖像).{0,48}(?:暂不支持|不支持|无法|不能|禁止|拒绝)|暂不支持上传真人脸素材/i},
    {code:"DOUBAO_REFERENCE_ROLE_AMBIGUOUS",category:"reference_mapping",retryMode:"edit_assets",requiresPromptEdit:false,userAction:"豆包无法明确参考图用途。请为每张图片标注人物、场景、道具等用途，并确认图号与上传顺序一致后重新提交。",pattern:/(?:无法|不能|难以).{0,18}(?:判断|识别|确认).{0,18}参考图.{0,18}(?:用途|对应关系)|请.{0,12}(?:说明|标注|明确).{0,18}图\s*\d+.{0,18}(?:人物|角色|场景|道具|用途)|参考图.{0,18}(?:用途不明|对应关系不清|容易混淆)/i},
    {code:"DOUBAO_REFERENCE_LIMIT_EXCEEDED",category:"asset_limit",retryMode:"edit_assets",requiresPromptEdit:false,userAction:"参考图数量超过当前模型限制。请减少图片数量，并只保留必要的人物、场景和道具参考。",pattern:/(?:参考图|图片|素材).{0,20}(?:数量|张数).{0,16}(?:过多|超出|超过|上限)|最多.{0,8}(?:张|个).{0,12}(?:参考图|图片|素材)/i},
    {code:"DOUBAO_IMAGE_QUALITY_REJECTED",category:"asset_quality",retryMode:"edit_assets",requiresPromptEdit:false,userAction:"参考图质量不符合要求。请更换清晰、无遮挡、无二维码和明显水印的图片后重新提交。",pattern:/(?:图片|参考图|素材).{0,30}(?:模糊|不清晰|分辨率过低|质量过低|遮挡严重|二维码|水印|损坏|读取失败)/i},
     {code:"DOUBAO_COPYRIGHT_ASSET_REJECTED",category:"asset_copyright",retryMode:"edit_assets",requiresPromptEdit:false,userAction:"参考素材可能涉及版权、公众人物或受保护角色。请更换为自有或已授权素材后重新提交。",pattern:/(?:^|[。！？])(?=[^。！？]*(?:参考图|图片|素材|角色))(?=[^。！？]*(?:版权|著作权|公众人物|明星|名人(?!物)|受保护角色|知名IP|知识产权))(?=[^。！？]*(?:限制|受限|拒绝|不支持|无法|不能|禁止|未通过|请更换|请修改))[^。！？]+/i},
     {code:"DOUBAO_COPYRIGHT_CONTENT_REJECTED",category:"content_policy",retryMode:"edit_prompt",requiresPromptEdit:true,userAction:"豆包因版权限制拒绝本次视频生成，请更换涉及版权的输入内容或提示词后重新提交。",pattern:/(?:^|[。！？])(?=[^。！？]*(?:视频|内容|版权限制))(?=[^。！？]*(?:版权|著作权|知识产权))(?=[^。！？]*(?:限制|受限|拒绝|不支持|无法|不能|禁止|未通过|请更换|请修改))[^。！？]+/i},
     {code:"DOUBAO_CONTENT_REJECTED",category:"content_policy",retryMode:"edit_prompt",requiresPromptEdit:true,userAction:"豆包已明确拒绝本次内容。请修改提示词中的侵权、违规、暴力、惊悚或敏感描述后重新提交。",pattern:/(?:生成内容|内容|提示词).{0,32}(?:疑似|包含|涉及|存在).{0,20}(?:侵权|违规|违法|敏感|风险|不安全)|无法返回该内容|换个主题再试试|不符合(?:平台|社区|相关).{0,10}(?:规范|要求)|违反.{0,12}(?:规范|政策)|不支持生成该内容|(?:内容|作品|视频).{0,20}(?:未通过审核|审核未通过|被审核拦截)/i},
    {code:"DOUBAO_ASSET_REJECTED",category:"asset_policy",retryMode:"edit_assets",requiresPromptEdit:false,userAction:"豆包已拒绝使用当前参考素材进行创作，请处理素材后再提交。",pattern:/(?:^|[。！])\s*(?:抱歉[，,：:]?\s*)?(?:(?:无法|不能|暂不支持|不支持)(?:针对|基于|使用|用).{0,16}(?:图片|参考图|素材).{0,12}(?:创作|生成(?:视频|图片|内容)?)|(?:该|这些|当前)?(?:图片|参考图|素材).{0,12}(?:无法|不能|不支持).{0,8}(?:创作|生成(?:视频|图片|内容)?))(?=[，,。！!]|$)/i},
    {code:"DOUBAO_ASSET_REJECTED",category:"asset_policy",retryMode:"edit_assets",requiresPromptEdit:false,userAction:"参考素材未通过或无法处理。请删除、替换或压缩对应图片/视频后重新提交。",pattern:/(?:图片|视频|音频|文件|素材).{0,30}(?:违规|侵权|风险|无法处理|上传失败|解析失败|格式不支持|格式错误|文件过大|大小超限|不符合要求)/i},
    {code:"DOUBAO_PARAMETER_REJECTED",category:"parameters",retryMode:"adjust_parameters",requiresPromptEdit:false,userAction:"当前模型或生成参数不可用。请调整模型、画面比例、时长或素材数量后重新提交。",pattern:/(?:当前模型|该模型|参数|画面比例|宽高比|时长|分辨率).{0,24}(?:不支持|不可用|无效|错误|超出|上限)|暂不支持.{0,20}(?:比例|时长|生成|视频)/i},
    {code:"DOUBAO_LOGIN_REQUIRED",category:"authentication",retryMode:"reauthenticate",requiresPromptEdit:false,userAction:"豆包登录状态已失效。请重新登录该账号后再执行任务。",pattern:/(?:登录已失效|登录状态失效|请重新登录|登录后再试|账号已退出)/i},
    {code:"DOUBAO_SERVICE_BUSY",category:"transient_provider",retryMode:"retry_later",requiresPromptEdit:false,userAction:"豆包服务暂时繁忙。账号已经释放，请稍后重新执行；不要连续高频提交。",pattern:/(?:系统|服务|服务器|模型).{0,16}(?:繁忙|拥挤|异常|不可用)|请求过多|操作频繁|稍后再试|稍后重试|出了点问题|网络异常|网络错误/i},
    {code:"DOUBAO_GENERATION_FAILED",category:"provider_generation",retryMode:"retry_or_edit",requiresPromptEdit:false,userAction:"豆包已明确结束本次生成且没有返回视频。可检查提示词和素材后重新执行。",pattern:/(?:视频|内容|任务)?.{0,12}(?:生成失败|生成中断|生成超时|无法生成|任务失败|处理失败)/i},
    {code:"DOUBAO_TERMINAL_UNRECOGNIZED",category:"provider_terminal_unknown",retryMode:"retry_or_edit",requiresPromptEdit:false,userAction:"豆包已结束本次生成，但没有返回标准错误原因。请打开现场核对提示词、素材和参数后再决定是否重试。",pattern:/(?:这次|本次)?.{0,8}(?:没有|没能|未能|无法).{0,8}(?:生成出来|完成生成|生成成功)|(?:视频|内容|任务|创作)?.{0,10}(?:生成未成功|未生成成功|生成已停止|生成已终止|生成被终止|创作已停止|任务已终止|任务被终止)/i}
  ];
  const paidGenerationAccepted=/(?:本次|此次).{0,16}(?:将消耗|使用|消耗)付费额度/.test(text)&&/(?:生成通道|预计等待|视频生成中|生成成功后)/.test(text);
  const rule=rules.find(item=>!(item.quotaExhausted&&paidGenerationAccepted)&&item.pattern.test(text));
  if(!rule)return empty;
  const match=text.match(rule.pattern);const excerpt=String(match?.[0]||"").replace(/\s+/g," ").trim();
  return {failed:true,outcomeCode:rule.code,terminal:true,providerTerminal:true,terminalFailureVerified:true,submittedVerified:false,safeToRetry:true,notSentVerified:rule.quotaExhausted===true,code:rule.code,category:rule.category,retryMode:rule.retryMode,accountAction:"release",requiresPromptEdit:rule.requiresPromptEdit,userAction:rule.userAction,providerMessage:excerpt||String(match?.[0]||""),providerMessageRaw:raw,quotaExhausted:rule.quotaExhausted===true,quotaConsumed:noCharge?false:null,evidence:{source:"doubao-current-conversation",excerpt:excerpt||String(match?.[0]||"")}};
}

function safeAccountId(value) {
  const id = String(value || "").trim();
  if (!id || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("账号标识无效");
  return id;
}

function browserCandidates(configured) {
  return [
    configured,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter(Boolean);
}

function findBrowser(configured) {
  const found = browserCandidates(configured).find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error("未找到 Chrome 或 Edge，请在系统设置中指定浏览器路径");
  return found;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function getJson(url, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, {timeout: timeoutMs}, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { reject(error); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("浏览器连接超时")));
    request.on("error", reject);
  });
}

async function waitTargets(port, platform = "") {
  const expected = String(platform || "").toLowerCase() === "dola" ? /dola\.com/i : /doubao\.com/i;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json`, 500);
      const page = targets.find(item => item.type === "page" && item.webSocketDebuggerUrl && expected.test(String(item.url || "")));
      if (page) return page;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Object.assign(new Error("本机浏览器调试端口未就绪"), {code: "DOUBAO_BROWSER_START_FAILED"});
}

function classifySubmissionEvidence({prompt = "", beforeConversationId = "", after = {}, request = null} = {}) {
  const conversationId = String(after.conversationId || "").trim();
  const userMessageConfirmed = Boolean(after.userMessage);
  const conversationObserved = /^\d{6,}$/.test(conversationId);
  const conversationChanged = conversationObserved && conversationId !== String(beforeConversationId || "").trim();
  // A completion POST also occurs when Doubao only writes a plan or code.
  // Keep it as transport evidence; it cannot prove that a video task exists.
  const requestObserved = Boolean(request?.videoGenerationRequest);
  const blocked = after.planningConfirmation || after.paidQuotaPrompt || after.paidQuotaConfirmation || after.providerTerminal || after.replyResponding || after.safetyConfirmation;
  const scopedGeneratingConfirmed = Boolean(after.scopedGenerating) && conversationObserved && !after.codeOnlyVideoResponse && !blocked;
  // SPA navigation can keep the URL at /chat while the sent message already
  // contains the rendered video task card and selected parameters.
  const taskCardConfirmed = Boolean(after.videoTaskCard && !blocked && userMessageConfirmed && (!after.expectedConversationId || after.conversationMatches));
  const confirmed = scopedGeneratingConfirmed || taskCardConfirmed;
  const evidenceType = scopedGeneratingConfirmed ? "current-conversation-generation-status"
    : taskCardConfirmed ? "video-task-card" : "";
  return {confirmed, evidenceType, requestConfirmed:false, requestObserved, userMessageConfirmed, conversationObserved, conversationChanged, scopedGeneratingConfirmed, taskCardConfirmed, conversationId};
}

class Cdp {
  constructor(url) {
    this.nextId = 0;
    this.pending = new Map();
    this.socket = new WebSocketImpl(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, {once: true});
      this.socket.addEventListener("error", () => reject(new Error("无法连接本机浏览器")), {once: true});
    });
    this.socket.addEventListener("message", event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message.id) {
        if (message.method) {
          for (const handler of this.handlers?.get(message.method) || []) {
            try { handler(message.params || {}); } catch {}
          }
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "CDP 执行失败"));
      else pending.resolve(message.result || {});
    });
  }
  on(method, handler) {
    if (!this.handlers) this.handlers = new Map();
    const list = this.handlers.get(method) || [];
    list.push(handler);
    this.handlers.set(method, list);
    return () => this.handlers.set(method, (this.handlers.get(method) || []).filter(item => item !== handler));
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.socket.send(JSON.stringify({id, method, params}));
    });
  }
  close() { try { this.socket.close(); } catch {} }
}

class EmbeddedCdp {
  constructor(webContents) {
    this.webContents = webContents;
    this.handlers = new Map();
    this.socket = {readyState: 1};
    this.listener = (_event, method, params) => {
      for (const handler of this.handlers.get(method) || []) { try { handler(params || {}); } catch {} }
    };
    if (!webContents.debugger.isAttached()) webContents.debugger.attach("1.3");
    webContents.debugger.on("message", this.listener);
  }
  on(method, handler) { const list = this.handlers.get(method) || []; list.push(handler); this.handlers.set(method, list); return () => this.handlers.set(method, list.filter(item => item !== handler)); }
  async send(method, params = {}) {
    let timer;
    try {
      return await Promise.race([
        this.webContents.debugger.sendCommand(method, params),
        new Promise((_, reject) => { timer=setTimeout(()=>reject(new Error(`内嵌豆包调试命令超时：${method}`)),15000); })
      ]);
    } finally { if(timer)clearTimeout(timer); }
  }
  close() { try { this.webContents.debugger.off("message", this.listener); } catch {} try { if (this.webContents.debugger.isAttached()) this.webContents.debugger.detach(); } catch {} this.socket.readyState = 0; }
}

class BrowserController {
  constructor({profileRootProvider, downloadRootProvider, browserExe = "", embeddedBrowserProvider = null, testMode = false}) {
    this.profileRootProvider = profileRootProvider;
    this.configuredBrowser = browserExe;
    this.embeddedBrowserProvider = embeddedBrowserProvider;
    this.testMode = testMode;
    this.sessions = new Map();
    this.submissionTails = new Map();
    this.downloader = new VideoDownloader({rootProvider: downloadRootProvider || (() => {
      const root = this.profileRoot();
      return path.join(path.dirname(root), "downloads");
    }), testMode});
  }
  profileRoot() {
    const root = this.profileRootProvider && this.profileRootProvider();
    if (!root) throw new Error("授权未生效，不能创建账号环境");
    fs.mkdirSync(root, {recursive: true});
    return root;
  }
  platformUrl(platform) {
    return String(platform || "豆包").toLowerCase() === "dola" ? "https://www.dola.com/chat/" : "https://www.doubao.com/chat/";
  }
  async withSubmissionLock(accountId, work) {
    const key = safeAccountId(accountId);
    const previous = this.submissionTails.get(key) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.submissionTails.set(key, tail);
    await previous.catch(() => {});
    try { return await work(); }
    finally {
      release();
      if (this.submissionTails.get(key) === tail) this.submissionTails.delete(key);
    }
  }
  async open(account) {
    const accountId = safeAccountId(account && account.id);
    const current = this.sessions.get(accountId);
    if (current?.embedded && current.webContents && !current.webContents.isDestroyed()) {
      const manager = this.embeddedBrowserProvider?.();
      if (manager?.automationSession) {
        const item = await manager.automationSession(account);
        if (current.webContents !== item.webContents) {
          try { current.cdp?.close(); } catch {}
          current.cdp = null;
        }
        current.account = account;
        current.webContents = item.webContents;
        current.view = item.view || current.view;
        current.profile = item.partition || current.profile;
      }
      return current;
    }
    if (current?.embedded) {
      try { current.cdp?.close(); } catch {}
      this.sessions.delete(accountId);
    }
    if (current && (current.testMode || current.process?.exitCode === null)) return current;
    if (this.embeddedBrowserProvider) {
      const manager = this.embeddedBrowserProvider();
      if (manager) {
        const item = await manager.automationSession(account);
        const session = {account, embedded: true, webContents: item.webContents, window: item.window || null, view: item.view || null, profile: item.partition, captures: [], captureSeq: 0, consumedCaptures: new Set(), submissionRequests: [], assetUploadRequests: [], videoIdentifiers: [], pendingAssetUpload: null, pendingSubmission: null, currentJobId: null, conversationId: "", cdp: null, phase: "idle"};
        this.sessions.set(accountId, session);
        return session;
      }
    }
    const profile = path.join(this.profileRoot(), `account_${accountId}`);
    fs.mkdirSync(profile, {recursive: true});
    if (this.testMode) {
      const session = {account, profile, testMode: true};
      this.sessions.set(accountId, session);
      return session;
    }
    const port = await freePort();
    const child = spawn(findBrowser(this.configuredBrowser), [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-mode",
      "--start-maximized",
      "--window-size=1280,900",
      "--new-window",
      this.platformUrl(account.platform),
    ], {detached: true, stdio: "ignore", windowsHide: false});
    let target;
    try { target = await waitTargets(port, account.platform); }
    catch (error) { try { child.kill(); } catch {} throw error; }
    const session = {account, process: child, port, profile, target, captures: [], captureSeq: 0, consumedCaptures: new Set(), submissionRequests: [], assetUploadRequests: [], videoIdentifiers: [], pendingAssetUpload: null, pendingSubmission: null, currentJobId: null, conversationId: "", cdp: null, phase: "idle"};
    child.once("exit", () => this.sessions.delete(accountId));
    this.sessions.set(accountId, session);
    return session;
  }
  async detect(account) {
    const session = await this.open(account);
    if (session.embedded) {
      const manager = this.embeddedBrowserProvider?.();
      if (manager?.detect) return manager.detect(account, session);
      const cdp = await this.connect(session);
      const cookieResult = await cdp.send("Network.getCookies", {urls: [this.platformUrl(account.platform)]});
      const value = await this.evaluate(session, DOUBAO_LOGIN_PROBE_EXPRESSION);
      const detected = classifyDoubaoLoginState(value, cookieResult.cookies || []);
      if (session.phase === "verification" && detected.loggedIn && !detected.verificationRequired) session.phase = "idle";
      return detected;
    }
    if (session.testMode) return {loggedIn: false, verificationRequired: false, platformAccountName: "", message: "测试模式浏览器已打开"};
    const targets = await getJson(`http://127.0.0.1:${session.port}/json`, 1000);
    const page = targets.find(item => item.type === "page" && /doubao\.com|dola\.com/i.test(item.url)) || targets.find(item => item.type === "page");
    if (!page) throw new Error("没有找到豆包页面");
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    try {
      await cdp.send("Network.enable");
      const cookieResult = await cdp.send("Network.getCookies", {urls: [this.platformUrl(account.platform)]});
      let value = {};
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const result = await cdp.send("Runtime.evaluate", {returnByValue: true, expression: DOUBAO_LOGIN_PROBE_EXPRESSION});
        value = result.result && result.result.value || {};
        const pageStable = value.readyState === "complete" && Number(value.bodyTextLength || 0) > 20;
        if (value.onPlatform && (hasDecisivePageLoginSignal(value) || (pageStable && attempt >= 4))) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const detected = classifyDoubaoLoginState(value, cookieResult.cookies || []);
      if (session.phase === "verification" && detected.loggedIn && !detected.verificationRequired) session.phase = "idle";
      return detected;
    } finally { cdp.close(); }
  }
  async refreshPage(session) {
    if (!session || session.phase !== "idle" || session.testMode) return {refreshed: false, reason: "busy-or-test-mode"};
    if (session.embedded) { await session.webContents.reload(); return {refreshed: true, url: session.webContents.getURL()}; }
    const targets = await getJson(`http://127.0.0.1:${session.port}/json`, 1000);
    const page = targets.find(item => item.type === "page" && /doubao\.com|dola\.com/i.test(String(item.url || "")) && item.webSocketDebuggerUrl);
    if (!page) return {refreshed: false, reason: "platform-page-not-ready"};
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    try {
      await cdp.send("Page.enable");
      await cdp.send("Page.reload", {ignoreCache: false});
    } finally { cdp.close(); }
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const next = await getJson(`http://127.0.0.1:${session.port}/json`, 700);
        const current = next.find(item => item.type === "page" && /doubao\.com|dola\.com/i.test(String(item.url || "")) && item.webSocketDebuggerUrl);
        if (current) {
          const probe = new Cdp(current.webSocketDebuggerUrl);
          try {
            const ready = await probe.send("Runtime.evaluate", {returnByValue: true, expression: "document.readyState === 'complete' && Boolean(document.body && document.body.innerText)"});
            if (ready.result?.value) return {refreshed: true, url: current.url};
          } finally { probe.close(); }
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, uiTiming(session, "composerReadyPollMs")));
    }
    throw new Error("豆包刷新后页面未完成加载");
  }
  async evaluate(session, expression) {
    if (session.testMode) return {testMode: true};
    if (session.embedded) {
      const cdp = await this.connect(session);
      const result = await cdp.send("Runtime.evaluate", {returnByValue: true, awaitPromise: true, expression});
      if (result.exceptionDetails) throw Object.assign(new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "豆包页面检测脚本执行失败"), {code:"DOUBAO_PAGE_EVALUATION_FAILED"});
      return result.result?.value;
    }
    const targets = await getJson(`http://127.0.0.1:${session.port}/json`, 1000);
    const page = targets.find(item => item.type === "page" && /doubao\.com|dola\.com/i.test(item.url)) || targets.find(item => item.type === "page");
    if (!page) throw new Error("没有找到豆包页面");
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    try { const result = await cdp.send("Runtime.evaluate", {returnByValue: true, awaitPromise: true, expression}); if(result.exceptionDetails) throw Object.assign(new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "豆包页面检测脚本执行失败"), {code:"DOUBAO_PAGE_EVALUATION_FAILED"}); return result.result?.value; }
    finally { cdp.close(); }
  }
  async navigateSession(session, url) {
    if (session.embedded) {
      try { session.cdp?.close(); } catch {}
      session.cdp = null;
      await session.webContents.loadURL(url);
      return {url:session.webContents.getURL()};
    }
    const cdp=await this.connect(session);return cdp.send("Page.navigate",{url});
  }
  recordSubmissionRequest(session, params = {}) {
    const pending = session.pendingSubmission;
    const request = params.request || {};
    const url = String(request.url || "");
    const method = String(request.method || "GET").toUpperCase();
    if (!pending || session.phase !== "submitting" || method !== "POST" || !/^https?:\/\/(?:[^/]+\.)?(?:doubao|dola)\.com\//i.test(url)) return;
    const endpointMatched = /(?:chat|conversation|message|completion|generate|video)/i.test(url);
    if (!endpointMatched) return;
    const postData = String(request.postData || "");
    const token = String(pending.prompt || "").trim().slice(0, 24);
    // The follow-up confirmation is short and the actual generation request
    // often carries the original prompt only in server-side conversation
    // context. Bind that explicit confirmation turn without weakening the
    // strict prompt match for the first submission.
    const confirmationTurn = pending.kind === "generation-confirmation"
      || /^(?:不需要|确认|可以|好的)[，,。！! ]*(?:直接)?(?:帮我)?生成视频[。！! ]*$/i.test(String(pending.prompt || "").trim());
    let promptMatched = (token.length >= 6 && (postData.includes(token) || postData.includes(JSON.stringify(token).slice(1, -1)))) || confirmationTurn;
    if (!promptMatched && token.length >= 6) {
      // Request JSON escapes newlines, quotes and sometimes Unicode. Match
      // decoded string values so multiline prompts keep their stream guard.
      try {
        const pendingValues = [JSON.parse(postData)], comparable = normalizeComparableText(token);
        while (pendingValues.length) {
          const value = pendingValues.pop();
          if (typeof value === "string" && normalizeComparableText(value).includes(comparable)) { promptMatched = true; break; }
          if (value && typeof value === "object") pendingValues.push(...Object.values(value));
        }
      } catch {}
    }
    const videoEndpointMatched = /(?:^|[/_-])(?:video|generate[_-]?video|video[_-]?generation)(?:[/_.?-]|$)/i.test(url);
    // 豆包新版可能把视频任务提交到通用 conversation/completion 接口，URL 不一定包含 video。
    // 只在请求体同时出现 Seedance/视频生成模型特征或明确视频字段时放宽判定，并要求命中本次提示词。
    // A generic completion request may contain a lone duration/ratio field while
    // the assistant is only drafting a plan. Require explicit video intent or
    // the model plus at least one video parameter before treating it as submit.
    const explicitVideoPayload = /(?:video[_-]?generation|generate[_-]?video|"video"\s*:)/i.test(postData);
    const modelWithVideoParams = /seedance/i.test(postData)
      && /"(?:duration|ratio|aspect_ratio)"\s*:/i.test(postData);
    const videoPayloadMatched = explicitVideoPayload || modelWithVideoParams;
    const videoGenerationRequest = Boolean((videoEndpointMatched || videoPayloadMatched) && promptMatched);
    session.submissionRequests = Array.isArray(session.submissionRequests) ? session.submissionRequests : [];
    session.submissionRequests.push({at:Date.now(),requestId:params.requestId || "",url,method,endpointMatched,promptMatched,confirmationTurn,videoEndpointMatched,videoGenerationRequest,jobId:pending.jobId || ""});
    if (session.submissionRequests.length > 100) session.submissionRequests.splice(0, session.submissionRequests.length - 100);
  }
  recordVideoIdentifierRequest(session, params = {}) {
    const request=params.request||{},url=String(request.url||"");
    if(!isVideoResourceRequest(url))return;
    const requestId=String(params.requestId||""),at=Date.now(),jobId=String(session.currentJobId||""),conversationId=String(session.conversationId||"");
    session.videoResourceRequests=Array.isArray(session.videoResourceRequests)?session.videoResourceRequests:[];
    session.videoResourceRequests.push({requestId,url,at,jobId,conversationId});
    if(session.videoResourceRequests.length>100)session.videoResourceRequests.splice(0,session.videoResourceRequests.length-100);
    this.storeVideoIdentifiers(session,extractVideoVids({url,postData:request.postData}),{requestId,url,at,jobId,conversationId,source:"resource-request"});
  }
  async recordVideoIdentifierResponse(session, cdp, params = {}) {
    const requestId=String(params.requestId||""),request=(session.videoResourceRequests||[]).find(item=>item.requestId===requestId);
    if(!request)return;
    try{
      const result=await cdp.send("Network.getResponseBody",{requestId});
      const responseBody=result?.base64Encoded?Buffer.from(String(result.body||""),"base64").toString("utf8"):String(result?.body||"");
      this.storeVideoIdentifiers(session,extractVideoVids({url:request.url,responseBody}),{...request,at:Date.now(),source:"resource-response"});
    }catch{}
  }
  storeVideoIdentifiers(session, values = [], metadata = {}) {
    session.videoIdentifiers=Array.isArray(session.videoIdentifiers)?session.videoIdentifiers:[];
    for(const value of values){const videoVid=normalizeVideoVid(value);if(!videoVid)continue;const duplicate=session.videoIdentifiers.find(item=>item.videoVid===videoVid&&String(item.jobId||"")===String(metadata.jobId||""));if(duplicate){Object.assign(duplicate,metadata,{videoVid});continue;}session.videoIdentifiers.push({...metadata,videoVid});}
    if(session.videoIdentifiers.length>100)session.videoIdentifiers.splice(0,session.videoIdentifiers.length-100);
  }
  latestVideoVid(session,{jobId="",conversationId=""}={}) {
    const values=(session.videoIdentifiers||[]).filter(item=>(!jobId||String(item.jobId||"")===String(jobId))&&(!conversationId||!item.conversationId||String(item.conversationId)===String(conversationId))).sort((a,b)=>Number(b.at||0)-Number(a.at||0));
    return normalizeVideoVid(values[0]?.videoVid);
  }
  recordAssetUploadRequest(session, params = {}) {
    const pending=session.pendingAssetUpload,request=params.request||{},url=String(request.url||""),method=String(request.method||"GET").toUpperCase();
    if(!pending||session.phase!="submitting"&&session.phase!="uploading")return;
    if(!/^https?:\/\//i.test(url)||!["POST","PUT","PATCH"].includes(method))return;
    const headers=request.headers||{},contentType=String(headers["Content-Type"]||headers["content-type"]||"");
    if(!/(?:upload|image|file|media|object|tos|storage|attachment|resource)/i.test(url)&&!/(?:multipart\/form-data|image\/|application\/octet-stream)/i.test(contentType))return;
    session.assetUploadRequests=Array.isArray(session.assetUploadRequests)?session.assetUploadRequests:[];
    session.assetUploadRequests.push({at:Date.now(),assetId:pending.assetId||"",name:pending.name||"",requestId:String(params.requestId||""),url,method,status:null});
    if(session.assetUploadRequests.length>100)session.assetUploadRequests.splice(0,session.assetUploadRequests.length-100);
  }
  recordAssetUploadResponse(session, params = {}) {
    const requestId=String(params.requestId||""),response=params.response||{},item=(session.assetUploadRequests||[]).find(entry=>entry.requestId===requestId&&!entry.status);
    if(!item)return;
    item.status=Number(response.status||0);item.mimeType=String(response.mimeType||"");item.completedAt=Date.now();
  }
  finishSubmissionRequest(session, params, failed = false) {
    for (const item of session.submissionRequests || []) {
      if (item.requestId === params.requestId) { item.finishedAt = Date.now(); item.failed = failed; }
    }
  }
  async connect(session) {
    if (session.testMode) return null;
    if (session.embedded) {
      if (session.cdp && session.cdp.socket.readyState === 1) return session.cdp;
      const cdp = new EmbeddedCdp(session.webContents);
      await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Network.enable");
      cdp.on("Network.responseReceived", params => {
        this.recordAssetUploadResponse(session,params);
        const response = params && params.response || {}, url = String(response.url || ""), mimeType = String(response.mimeType || "");
        if (!/^https?:\/\//i.test(url) || (!/^video\//i.test(mimeType) && !/\.mp4(?:\?|$)|\.m3u8(?:\?|$)/i.test(url))) return;
        session.captures.push({seq: ++session.captureSeq, at: Date.now(), url, mimeType, status: response.status, requestId: params.requestId, jobId: session.currentJobId, conversationId: session.conversationId || null, videoVid:this.latestVideoVid(session,{jobId:session.currentJobId,conversationId:session.conversationId}), source: "embedded-network"});
        if (session.captures.length > 500) session.captures.splice(0, session.captures.length - 500);
      });
      cdp.on("Network.requestWillBeSent", params => {this.recordAssetUploadRequest(session,params);this.recordSubmissionRequest(session, params);this.recordVideoIdentifierRequest(session,params);});
      cdp.on("Network.loadingFinished", params => {this.finishSubmissionRequest(session,params);this.recordVideoIdentifierResponse(session,cdp,params).catch(()=>{});});
      cdp.on("Network.loadingFailed", params => this.finishSubmissionRequest(session,params,true));
      session.cdp = cdp;
      return cdp;
    }
    const targets = await getJson(`http://127.0.0.1:${session.port}/json`, 1000);
    const page = targets.find(item => item.type === "page" && /doubao\.com|dola\.com/i.test(item.url)) || targets.find(item => item.type === "page");
    if (!page) throw new Error("没有找到豆包页面");
    if (session.cdp && session.cdp.socket && session.cdp.socket.readyState === 1) return session.cdp;
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    cdp.on("Network.responseReceived", params => {
      this.recordAssetUploadResponse(session,params);
      const response = params && params.response || {};
      const url = String(response.url || "");
      const mimeType = String(response.mimeType || "");
      if (!/^https?:\/\//i.test(url) || (!/^video\//i.test(mimeType) && !/\.mp4(?:\?|$)|\.m3u8(?:\?|$)/i.test(url))) return;
      session.captures.push({seq: ++session.captureSeq, at: Date.now(), url, mimeType, status: response.status, requestId: params.requestId, jobId: session.currentJobId, conversationId: session.conversationId || null, videoVid:this.latestVideoVid(session,{jobId:session.currentJobId,conversationId:session.conversationId}), source: "network"});
      if (session.captures.length > 500) session.captures.splice(0, session.captures.length - 500);
    });
    cdp.on("Network.requestWillBeSent", params => {this.recordAssetUploadRequest(session,params);this.recordSubmissionRequest(session, params);this.recordVideoIdentifierRequest(session,params);});
    cdp.on("Network.loadingFinished", params => {this.finishSubmissionRequest(session,params);this.recordVideoIdentifierResponse(session,cdp,params).catch(()=>{});});
    cdp.on("Network.loadingFailed", params => this.finishSubmissionRequest(session,params,true));
    session.cdp = cdp;
    return cdp;
  }
  async waitForComposer(session, timeoutMs = 15000) {
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 15000);
    while (Date.now() < deadline) {
      const state = await this.evaluate(session, `(() => {
        const visible = el => { if (!el) return false; const r=el.getBoundingClientRect(),s=getComputedStyle(el); return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'; };
        const nodes=[];const seen=new Set();
        const collect=root=>{ if(!root||seen.has(root))return;seen.add(root); for(const selector of ['textarea','input:not([type="file"]):not([type="search"]):not([type="button"]):not([type="submit"])','[contenteditable="true"]','[role="textbox"]','[data-slate-editor="true"]','.ProseMirror']) for(const el of root.querySelectorAll?.(selector)||[]) nodes.push(el); for(const host of root.querySelectorAll?.('*')||[]) if(host.shadowRoot) collect(host.shadowRoot); };
        collect(document);
        const describe=el=>{const r=el.getBoundingClientRect(),placeholder=String(el.getAttribute('placeholder')||el.getAttribute('aria-placeholder')||el.querySelector?.('[data-placeholder]')?.getAttribute('data-placeholder')||'');const hint=[placeholder,el.getAttribute('aria-label')||'',el.getAttribute('data-testid')||'',String(el.className||'')].join(' ');return{el,r,placeholder,hint};};
        const candidates=nodes.filter(visible).map(describe).filter(item=>{const hint=item.hint,tag=String(item.el?.tagName||'').toUpperCase(),genericComposer=tag==='TEXTAREA'||item.el?.isContentEditable===true||item.el?.getAttribute?.('role')==='textbox';return !/(?:search|搜索|项目|素材|任务)/i.test(hint)&&(genericComposer||!item.placeholder||/(?:描述|视频|想要|输入|prompt|创作|内容|故事)/i.test(hint));}).sort((a,b)=>b.r.bottom-a.r.bottom||b.r.width-a.r.width);
        const input=candidates[0];
        // 部分豆包账号会把首页编辑器渲染为动态宿主节点，暂时没有标准
        // textarea/contenteditable，但底部仍显示真实的输入提示。允许该节点
        // 进入后续 fillComposer 的 CDP 兜底输入流程，同时排除顶部导航文本。
        const hintNodes=[...document.querySelectorAll('body *')].filter(visible).map(el=>({el,text:String(el.innerText||el.textContent||'').replace(/\\s+/g,'').trim(),r:el.getBoundingClientRect()})).filter(item=>/(有什么我能帮你的吗|发消息或按住空格说话)/.test(item.text)&&item.r.bottom>innerHeight*.5).sort((a,b)=>a.text.length-b.text.length||b.r.top-a.r.top);
        const fallback=Boolean(!input&&hintNodes[0]);
        return {ready:Boolean(input)||fallback,fallback,url:location.href,placeholder:input?.placeholder||hintNodes[0]?.text||'',candidateCount:candidates.length,candidates:candidates.slice(0,6).map(item=>({placeholder:item.placeholder,top:Math.round(item.r.top),bottom:Math.round(item.r.bottom),width:Math.round(item.r.width),height:Math.round(item.r.height)}))};
      })()`);
      if (state?.ready) return state;
      // 豆包新版首页的编辑器可能由动态组件渲染，DOM 暂时不可见但底部对话区已存在。
      // 不能仅凭“有什么我能帮你的吗/对话”等正文判断编辑器已就绪；
      // 带图片任务尤其容易出现正文已加载、底部编辑器仍未挂载的状态。
      await new Promise(resolve => setTimeout(resolve, uiTiming(session, "composerReadyPollMs")));
    }
    let diagnostic = {};
    try { diagnostic = await this.evaluate(session, `(() => ({url:location.href,title:document.title,readyState:document.readyState,bodyText:String(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,500)}))()`); } catch (error) { diagnostic = {probeError:String(error?.message||error)}; }
    throw Object.assign(new Error(`豆包新对话页面未加载完成：${JSON.stringify(diagnostic)}`), {code:"DOUBAO_COMPOSER_NOT_READY", category:"page_loading", safeToRetry:true});
  }
  async prepareFreshConversationLegacy(session, account) {
    if (session.testMode) return {ready: true, url: "mock://new-chat"};
    await this.navigateSession(session, this.platformUrl(account.platform));
    const openDialogueTab = async () => {
      const target = await this.evaluate(session, `(() => { const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>2&&r.height>2&&r.top>=40&&r.bottom<=260&&s.display!=='none'&&s.visibility!=='hidden'&&s.pointerEvents!=='none'}; const clean=v=>String(v||'').replace(/\\s+/g,'').trim(); const items=[...document.querySelectorAll('button,[role="tab"],[role="button"],a,div,span')].filter(visible).map(el=>({el,r:el.getBoundingClientRect(),text:clean(el.innerText||el.textContent||el.getAttribute('aria-label')||el.getAttribute('title')||'')})).filter(x=>x.text==='对话'||x.text.startsWith('对话')); const hit=items.sort((a,b)=>a.r.width*a.r.height-b.r.width*b.r.height)[0]; if(!hit)return false; const clickable=hit.el.closest?.('button,[role="tab"],[role="button"],a')||hit.el; clickable.click(); const r=clickable.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,verified:true}; })()`);
      if (!target?.verified) return false;
      const cdp = await this.connect(session);
      await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:target.x,y:target.y});
      await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:target.x,y:target.y,button:'left',clickCount:1});
      await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:target.x,y:target.y,button:'left',clickCount:1});
      await new Promise(resolve => setTimeout(resolve, uiTiming(session, "menuSettlingMs")));
      return true;
    };
    await openDialogueTab();
    const opened = await this.evaluate(session, `(() => {
      const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'};
      const candidates=[...document.querySelectorAll('span,button,[role="button"],a,div')].filter(visible)
        .map(el=>({el,text:String(el.innerText||el.textContent||el.getAttribute('aria-label')||'').replace(/\\s+/g,'').trim(),rect:el.getBoundingClientRect()}))
        .filter(item=>item.text.startsWith('新对话')&&item.rect.top>=60&&item.rect.top<180)
        .sort((left,right)=>left.rect.width*left.rect.height-right.rect.width*right.rect.height);
      if(!candidates[0])return false; const target=candidates[0].el, r=target.getBoundingClientRect(); target.click(); return {x:r.left+r.width/2,y:r.top+r.height/2,verified:true};
    })()`);
    if (opened?.verified) {
      await this.connect(session).then(cdp => cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:opened.x,y:opened.y}));
      const cdp=await this.connect(session); await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:opened.x,y:opened.y,button:'left',clickCount:1}); await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:opened.x,y:opened.y,button:'left',clickCount:1});
      await new Promise(resolve=>setTimeout(resolve,uiTiming(session,"menuSettlingMs")));
    }
    let state;
    try { state = await this.waitForComposer(session, 35000); }
    catch (firstError) {
      // 首页导航偶发停留在旧渲染状态，重新导航并直接点击新对话后再等待输入框。
      await this.navigateSession(session, this.platformUrl(account.platform));
      const retried = await this.evaluate(session, `(() => { const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'&&s.pointerEvents!=='none'}; const hit=[...document.querySelectorAll('button,[role="button"],a,div,span')].filter(visible).map(el=>({el,text:String(el.innerText||el.textContent||el.getAttribute('aria-label')||'').replace(/\\s+/g,'').trim(),r:el.getBoundingClientRect()})).filter(x=>x.text.startsWith('新对话')&&x.r.top<220).sort((a,b)=>a.r.width*a.r.height-b.r.width*b.r.height)[0]; if(!hit)return false; hit.el.click(); return true; })()`);
      if (retried) await new Promise(resolve=>setTimeout(resolve,uiTiming(session,"menuSettlingMs")));
      state = await this.waitForComposer(session, 25000).catch(() => { throw firstError; });
    }
    session.conversationId = "";
    return state;
  }
  async prepareFreshConversation(session, account) {
    if (session.testMode) return {ready: true, url: "mock://new-chat"};
    const platformUrl = this.platformUrl(account.platform);
    const dispatchPoint = async point => {
      if (!point?.verified) return false;
      const cdp = await this.connect(session);
      await cdp.send("Input.dispatchMouseEvent", {type:"mouseMoved", x:point.x, y:point.y});
      await cdp.send("Input.dispatchMouseEvent", {type:"mousePressed", x:point.x, y:point.y, button:"left", clickCount:1});
      await cdp.send("Input.dispatchMouseEvent", {type:"mouseReleased", x:point.x, y:point.y, button:"left", clickCount:1});
      return true;
    };
    const clickLabel = async (pattern, {minTop = 0, maxTop = 99999, maxBottom = 99999} = {}) => this.evaluate(session, `(() => {
      const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>2&&r.height>2&&s.display!=="none"&&s.visibility!=="hidden"&&s.pointerEvents!=="none"};
      const clean=v=>String(v||"").replace(/\\s+/g,"").trim();
      const regex=new RegExp(${JSON.stringify(String(pattern))});
      const items=[...document.querySelectorAll("button,[role=tab],[role=button],a,[tabindex],div,span")].filter(visible).map(el=>({el,text:clean(el.innerText||el.textContent||el.getAttribute("aria-label")||el.getAttribute("title")||""),r:el.getBoundingClientRect()})).filter(x=>regex.test(x.text));
      const hit=items.filter(x=>x.r.top>=${Number(minTop)}&&x.r.top<=${Number(maxTop)}&&x.r.bottom<=${Number(maxBottom)}).sort((a,b)=>a.r.width*a.r.height-b.r.width*b.r.height)[0];
      if(!hit)return {verified:false,candidateCount:items.length};
      const clickable=hit.el.closest?.("button,[role=tab],[role=button],a")||hit.el, r=clickable.getBoundingClientRect();
      for(const type of ["pointerdown","mousedown","pointerup","mouseup","click"]) clickable.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));
      return {verified:true,x:r.left+r.width/2,y:r.top+r.height/2,label:hit.text};
    })()`);
    const waitForPageShell = async (timeoutMs = 30000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const state = await this.evaluate(session, `(() => ({readyState:document.readyState,onPlatform:/doubao\\.com|dola\\.com/i.test(location.href),bodyTextLength:String(document.body?.innerText||"").trim().length}))()`);
        if (state?.onPlatform && state.readyState === "complete" && Number(state.bodyTextLength || 0) > 20) return state;
        await new Promise(resolve => setTimeout(resolve, 120));
      }
      return null;
    };
    let lastError = null;
    // 账号切换后 readyState 可能先完成，而编辑器还在异步挂载；每轮都重新进入新对话并确认输入框。
    for (let round = 1; round <= 3; round += 1) {
      try {
        await this.navigateSession(session, platformUrl);
        await waitForPageShell(30000);
        const dialogue = await clickLabel("^(对话)$", {minTop:30, maxTop:300, maxBottom:360});
        if (dialogue?.verified) { await dispatchPoint(dialogue); await new Promise(resolve => setTimeout(resolve, 220)); }
        const fresh = await clickLabel("^新对话", {minTop:30, maxTop:300, maxBottom:360});
        if (fresh?.verified) { await dispatchPoint(fresh); await new Promise(resolve => setTimeout(resolve, 220)); }
        const state = await this.waitForComposer(session, round === 1 ? 45000 : 35000);
        session.conversationId = "";
        return state;
      } catch (error) {
        lastError = error;
        if (round < 3) await new Promise(resolve => setTimeout(resolve, 1200 * round));
      }
    }
    throw lastError || Object.assign(new Error("豆包新对话页面未加载完成"), {code:"DOUBAO_COMPOSER_NOT_READY", category:"page_loading", safeToRetry:true});
  }

  async restoreConversation(session, command) {
    if (session.testMode) return {restored:true,conversationId:String(command.payload?.conversationId||"")};
    const requested=String(command.payload?.conversationId||"").trim();
    const prompt=String(command.payload?.prompt||"").trim();
    if (/^\d{6,}$/.test(requested)) {
      const target=`https://www.doubao.com/chat/${requested}`;
      const current=await this.evaluate(session,"location.href");
      if (current!==target) { await this.navigateSession(session,target); await new Promise(resolve=>setTimeout(resolve,180)); }
    } else {
      const restored=await this.evaluate(session, `(() => { const prompt=${JSON.stringify(prompt)};const clean=${normalizeComparableText.toString()};const source=clean(prompt);const grams=[];for(let i=0;i<source.length-1;i++){const token=source.slice(i,i+2);if(!['一个','画面','镜头','视频','生成'].includes(token))grams.push(token)}const links=[...document.querySelectorAll('a[href*="/chat/"]')].map(a=>{const text=clean(a.innerText||a.textContent);const score=grams.reduce((sum,g)=>sum+(text.includes(g)?1:0),0);return {a,score,text}}).sort((a,b)=>b.score-a.score);if(!links[0]||links[0].score<2)return false;links[0].a.click();return true;})()`);
      if (restored) await new Promise(resolve=>setTimeout(resolve,180));
    }
    let state;
    const restoreDeadline=Date.now()+15000;
    do {
      state=await this.evaluate(session, `(() => {const match=location.pathname.match(/\\/chat\\/([^/?#]+)/);const root=document.querySelector('main')||document.body;const clean=${normalizeComparableText.toString()};const token=clean(${JSON.stringify(prompt.slice(0,96))});const text=clean(root?.innerText||root?.textContent||'');return {conversationId:match?match[1]:'',restored:token?text.includes(token):true,url:location.href}})()`);
      if(state?.restored&&(!requested||state.conversationId===requested))break;
      if(state)state.restored=false;
      await new Promise(resolve=>setTimeout(resolve,100));
    } while(Date.now()<restoreDeadline);
    if (!state?.restored) throw Object.assign(new Error("未能恢复当前任务对应的豆包会话；不会重新提交"),{code:"DOUBAO_CONVERSATION_RESTORE_FAILED",recoveryState:"conversation_restore_failed",safeToRetry:false,notSentVerified:false,monitorProbe:{conversationId:String(state?.conversationId||requested||""),requestedConversationId:requested,url:String(state?.url||""),promptMatched:false}});
    session.conversationId=String(state.conversationId||requested||session.conversationId||"");
    return state;
  }
  async ensureVideoMode(session) {
    await this.checkPageBlocker(session, {dismissPromotion:true});
    const clickPoint=async point=>{if(!point?.verified)return false;const cdp=await this.connect(session);await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:point.x,y:point.y});await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",x:point.x,y:point.y,button:"left",clickCount:1});await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",x:point.x,y:point.y,button:"left",clickCount:1});return true;};
    const clickVideoEntry=async()=>this.evaluate(session, `(() => {
      const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>2&&r.height>2&&s.display!=="none"&&s.visibility!=="hidden"&&s.pointerEvents!=="none"};
      const clean=value=>String(value||"").replace(/\\s+/g,"").trim();
      const candidates=[...document.querySelectorAll('button[data-component-type="skill-item"],button,[role="button"],a,[tabindex],div,span')].filter(visible);
      const target=candidates.find(el=>el.getAttribute("data-skill-id")==="skill_bar_button_17")||candidates.find(el=>/^(视频生成|生成视频)$/.test(clean(el.innerText||el.textContent||el.getAttribute("aria-label")||el.getAttribute("title")||"")));
       if(!target)return {clicked:false};
       // The caller dispatches one CDP mouse click after this locator returns.
       // Do not also invoke DOM click here: that double-clicks the SPA entry.
       const r=target.getBoundingClientRect(); target.focus();
       return {clicked:true,label:clean(target.innerText||target.textContent||target.getAttribute("aria-label")||""),x:r.left+r.width/2,y:r.top+r.height/2,verified:true};
    })()`);
    const dismissTransientUi=async()=>{const cdp=await this.connect(session);for(let index=0;index<2;index+=1){await cdp.send("Input.dispatchKeyEvent",{type:"rawKeyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});await cdp.send("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});}await new Promise(resolve=>setTimeout(resolve,80));};
    const modeState = async () => this.evaluate(session, `(() => {/*doubao-video-mode-state*/
      const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'&&s.pointerEvents!=='none'};
      const model=[...document.querySelectorAll('[data-input-engine-actionbar-control-key="video-model"]')].find(visible);
      const params=[...document.querySelectorAll('[data-input-engine-actionbar-render-entry-key="video-generation-params-panel"],[data-creation-params-panel-id]')].find(visible);
      const composer=[...document.querySelectorAll('textarea,input,[contenteditable="true"],[role="textbox"],[data-slate-editor="true"],.ProseMirror')].filter(visible).find(el=>/描述.*视频|想要的视频/.test(String(el.getAttribute('placeholder')||el.getAttribute('aria-placeholder')||el.querySelector?.('[data-placeholder]')?.getAttribute('data-placeholder')||'')));
      // 普通对话页也可能残留“视频生成”文字或旧 DOM 节点，不能据此判定已切换。
      // 只有模型控件与参数面板/视频专用编辑器同时可见，才算真正进入视频模式。
      return {active:Boolean(model&&(params||composer)),videoComposer:Boolean(composer),legacyControls:Boolean(model&&params)};
    })()`);
    let currentMode=await modeState();
    if (currentMode?.active) return true;
    // 豆包首页默认停留在“对话”工作区；视频入口位于“工作”标签下。
    // 不同版本的页面把标签渲染为 div/span，因此不能只依赖 button 选择器。
    const openWorkTab = async () => {
      const target = await this.evaluate(session, `(() => { const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&r.top>=60&&r.bottom<=innerHeight&&s.display!=='none'&&s.visibility!=='hidden'&&s.pointerEvents!=='none'}; const clean=v=>String(v||'').replace(/\\s+/g,'').trim(); const items=[...document.querySelectorAll('button,[role="tab"],[role="button"],a,div,span')].filter(visible).map(el=>({el,r:el.getBoundingClientRect(),text:clean(el.innerText||el.textContent||el.getAttribute('aria-label')||el.getAttribute('title')||'')})).filter(x=>x.text==='工作'&&x.r.width<240&&x.r.height<100).sort((a,b)=>a.r.width*a.r.height-b.r.width*b.r.height); const hit=items[0]; if(!hit)return false; hit.el.click(); return {x:hit.r.left+hit.r.width/2,y:hit.r.top+hit.r.height/2,label:hit.text,verified:true}; })()`);
      if (!target?.verified) return false;
      const cdp=await this.connect(session); await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:target.x,y:target.y}); await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:target.x,y:target.y,button:'left',clickCount:1}); await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:target.x,y:target.y,button:'left',clickCount:1});
      const deadline=Date.now()+8000; while(Date.now()<deadline){const ready=await this.evaluate(session,`(() => { const t=String(document.body?.innerText||'').replace(/\\s+/g,''); return /视频生成|Seedance|创作/.test(t) || Boolean(document.querySelector('[data-input-engine-actionbar-control-key="video-model"],[data-creation-params-panel-id]')); })()`); if(ready)break; await new Promise(resolve=>setTimeout(resolve,uiTiming(session,"modePollMs"))); }
      return true;
    };
    // 不要默认切到“工作”首页：新版豆包的正确入口就在底部输入框工具栏，
    // 用户截图所示的“视频生成”标签会直接切换到 Seedance 视频模式。只有
    // 直接入口和“更多”兜底都不存在时，才应考虑其他页面导航。
    const openContentCreation = async () => {
      const target = await this.evaluate(session, `(() => { const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&r.top>=120&&r.bottom<=innerHeight&&s.display!=='none'&&s.visibility!=='hidden'&&s.pointerEvents!=='none'}; const clean=v=>String(v||'').replace(/\\s+/g,'').trim(); const items=[...document.querySelectorAll('button,[role="button"],a,div,span')].filter(visible).map(el=>({el,r:el.getBoundingClientRect(),text:clean(el.innerText||el.textContent||el.getAttribute('aria-label')||el.getAttribute('title')||'')})).filter(x=>x.text==='内容创作'&&x.r.width<360&&x.r.height<120).sort((a,b)=>a.r.width*a.r.height-b.r.width*b.r.height); const hit=items[0]; if(!hit)return false; const clickable=hit.el.closest?.('button,[role="button"],a')||hit.el; const r=clickable.getBoundingClientRect(); for(const type of ['pointerdown','mousedown','pointerup','mouseup','click']) clickable.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window,clientX:r.left+r.width/2,clientY:r.top+r.height/2})); return {x:r.left+r.width/2,y:r.top+r.height/2,verified:true}; })()`);
      if (!target?.verified) return false;
      const cdp=await this.connect(session); await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:target.x,y:target.y}); await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:target.x,y:target.y,button:'left',clickCount:1}); await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:target.x,y:target.y,button:'left',clickCount:1}); await new Promise(resolve=>setTimeout(resolve,uiTiming(session,"menuSettlingMs"))); return true;
    };
    const findDirect=()=>this.evaluate(session, `(() => {/*doubao-video-entry-target*/
      const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'};
      const clean=value=>String(value||'').replace(/\\s+/g,'').trim();
      const editors=[...document.querySelectorAll('textarea,input,[contenteditable="true"],[role="textbox"],[data-slate-editor="true"],.ProseMirror')].filter(visible).sort((a,b)=>b.getBoundingClientRect().bottom-a.getBoundingClientRect().bottom),editor=editors[0];
      const ir=editor?.getBoundingClientRect?.()||{top:innerHeight*.45,bottom:innerHeight,left:0};
      const elements=[...document.querySelectorAll('button,[role="button"],a,[tabindex],div,span')].filter(visible);
       const contentLeft=Math.max(96,Number(ir.left||0)-360);
       const candidates=elements.map(el=>({el,r:el.getBoundingClientRect(),label:clean(el.innerText||el.textContent||el.getAttribute('aria-label')||el.getAttribute('title')||''),tag:el.tagName,skillId:el.getAttribute('data-skill-id')||''})).filter(item=>/^(?:视频生成|生成视频)$/.test(item.label)||item.skillId==='skill_bar_button_17').filter(item=>item.r.bottom>innerHeight*.40&&item.r.top<=ir.bottom+180&&item.r.left>=contentLeft);
      const score=item=>{const exact=/^(视频生成|生成视频)$/.test(item.label);const nearEditor=item.r.bottom>=ir.top-260&&item.r.top<=ir.bottom+180;const bottom=Math.min(1,item.r.bottom/Math.max(1,innerHeight));const right=Math.min(1,item.r.left/Math.max(1,innerWidth));return (exact?900:0)+(nearEditor?500:0)+bottom*300+right*80-(item.r.width*item.r.height/1000000);};
      const hit=candidates.map(item=>{const x=item.r.left+item.r.width/2,y=item.r.top+item.r.height/2,top=document.elementFromPoint(x,y),clickable=item.el.closest?.('button,[role="button"],a,[tabindex]')||item.el,cr=clickable.getBoundingClientRect(),topText=clean(top?.innerText||top?.textContent||top?.getAttribute?.('aria-label')||'');return{...item,clickable,x:cr.left+cr.width/2,y:cr.top+cr.height/2,verified:Boolean(top&&(item.el===top||item.el.contains(top)||top.contains?.(item.el)||clickable===top||clickable.contains?.(top))),topText,score:score(item)}}).sort((a,b)=>b.score-a.score||b.r.bottom-a.r.bottom)[0];
      return hit?{x:hit.x,y:hit.y,label:hit.label,scope:'composer-toolbar',verified:true,topText:hit.topText}:{verified:false,scope:'composer-toolbar',candidateCount:candidates.length,candidateLabels:candidates.slice(-10).map(item=>item.label)};
    })()`);
    await dismissTransientUi();
    // 带图片的新对话会比纯文本慢，等待底部工具栏真正挂载，避免仅凭页面正文
    // 已加载就误判为可点击。最多等待 20 秒，每 400ms 重新扫描一次。
    let direct = await findDirect();
    const directDeadline = Date.now() + 20000;
    while (!direct?.verified && Date.now() < directDeadline) {
      await new Promise(resolve => setTimeout(resolve, uiTiming(session, "modePollMs")));
      direct = await findDirect();
    }
     if(direct?.verified){const domResult=await clickVideoEntry();if(domResult?.clicked)await clickPoint(domResult);else await clickPoint(direct);}
    // 首页可能停在“对话”工作区，视频工具栏在“工作”标签；找不到底部入口时切换后重扫。
    if (!direct?.verified && !direct?.candidateCount) {
      const workOpened = await openWorkTab();
      if (workOpened) {
        const workDeadline = Date.now() + 10000;
        direct = await findDirect();
        while (!direct?.verified && Date.now() < workDeadline) {
          await new Promise(resolve => setTimeout(resolve, uiTiming(session, "modePollMs")));
          direct = await findDirect();
        }
        if (direct?.verified) { const domResult = await clickVideoEntry(); if (domResult?.clicked) await clickPoint(domResult); else await clickPoint(direct); }
      }
    }
    // 只有在底部工具栏和“工作”标签都没有入口时，才尝试打开“内容创作”。
    // 新版豆包会在历史/导航区域也渲染同名文本，无条件点击会把当前编辑器切走。
    if (!direct?.verified && !direct?.candidateCount) {
      await openContentCreation();
      const creationDeadline = Date.now() + 8000;
      direct = await findDirect();
      while (!direct?.verified && Date.now() < creationDeadline) {
        await new Promise(resolve => setTimeout(resolve, uiTiming(session, "modePollMs")));
        direct = await findDirect();
      }
      if (direct?.verified) {
        const domResult = await clickVideoEntry();
        if (domResult?.clicked) await clickPoint(domResult); else await clickPoint(direct);
      }
    }
    if (!direct?.verified && !direct?.candidateCount) {
       let more = await this.evaluate(session, `(() => {/*doubao-video-more-target*/
        const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'};
        const inputs=[...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"],[data-slate-editor="true"]')].filter(visible).sort((a,b)=>b.getBoundingClientRect().bottom-a.getBoundingClientRect().bottom);
        const input=inputs[0];if(!input)return false;const ir=input.getBoundingClientRect();
        const all=[...document.querySelectorAll('button,[role="button"],[tabindex]')].filter(visible);
        const hit=all.map(el=>{const r=el.getBoundingClientRect(),label=String(el.innerText||el.textContent||el.getAttribute('aria-label')||el.getAttribute('title')||'').replace(/\\s+/g,'').trim();return {el,r,label};})
          .filter(x=>/^(更多|…|\\.\\.\\.)$/.test(x.label)&&x.r.bottom>ir.top-160&&x.r.left>ir.left)
          .sort((a,b)=>b.r.left-a.r.left)[0];
        if(!hit)return false;hit.el.click();return true;
       })()`);
       if (!more) {
         // 新版首页没有可识别的编辑器时，“更多”位于顶部工作区工具栏。
         const topMore = await this.evaluate(session, `(() => { const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&r.top<120&&s.display!=='none'&&s.visibility!=='hidden'&&s.pointerEvents!=='none'}; const clean=v=>String(v||'').replace(/\\s+/g,'').trim(); const hit=[...document.querySelectorAll('button,[role="button"],a,div,span')].filter(visible).map(el=>({el,r:el.getBoundingClientRect(),text:clean(el.innerText||el.textContent||el.getAttribute('aria-label')||el.getAttribute('title')||'')})).filter(x=>x.text==='更多'&&x.r.left>80).sort((a,b)=>a.r.width*a.r.height-b.r.width*b.r.height)[0]; if(!hit)return false; hit.el.click(); return {x:hit.r.left+hit.r.width/2,y:hit.r.top+hit.r.height/2,verified:true}; })()`);
         if (topMore?.verified) { await clickPoint(topMore); await new Promise(resolve => setTimeout(resolve, uiTiming(session, "menuSettlingMs"))); more = true; }
       }
       let menuVideo = false;
       if (!more) {
          const fallbackVideo = await this.evaluate(session, `(() => { const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'&&s.pointerEvents!=='none'}; const clean=v=>String(v||'').replace(/\\s+/g,'').trim(); const hit=[...document.querySelectorAll('button,[role="button"],a,[tabindex],div,span')].filter(visible).map(el=>({el,r:el.getBoundingClientRect(),text:clean(el.innerText||el.textContent||el.getAttribute('aria-label')||el.getAttribute('title')||'')})).filter(x=>/^视频生成$|^生成视频$/.test(x.text)&&x.r.bottom>innerHeight*.45).sort((a,b)=>b.r.bottom-a.r.bottom||b.r.left-a.r.left)[0]; if(!hit)return false; return {x:hit.r.left+hit.r.width/2,y:hit.r.top+hit.r.height/2,label:hit.text,verified:true}; })()`);
         if (fallbackVideo) { await clickPoint(fallbackVideo); menuVideo = true; }
          else {
            const diagnostic = await this.evaluate(session, `(() => { const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'}; const clean=v=>String(v||'').replace(/\\s+/g,' ').trim(); const describe=e=>({tag:e.tagName,text:clean(e.innerText||e.textContent||e.getAttribute('aria-label')||e.getAttribute('title')||''),role:e.getAttribute('role')||'',testid:e.getAttribute('data-testid')||'',skill:e.getAttribute('data-skill-id')||'',href:e.getAttribute('href')||'',cls:String(e.className||'').slice(0,160),onclick:Boolean(e.onclick),rect:(()=>{const r=e.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}})()}); const exact=[...document.querySelectorAll('*')].filter(visible).filter(e=>clean(e.innerText||e.textContent||'')==='内容创作').map(e=>({...describe(e),outer:String(e.outerHTML||'').slice(0,900)})).slice(-12); return {url:location.href, bodyText:clean(document.body?.innerText||'').slice(-1800), contentCandidates:exact, tabs:[...document.querySelectorAll('*')].filter(visible).map(describe).filter(x=>/^(工作|对话|更多)$/.test(x.text)).slice(-30), videoLike:[...document.querySelectorAll('*')].filter(visible).map(describe).filter(x=>/视频|生成|内容创作|处理日常工作|设计与创意/.test(x.text)).slice(-50)}; })()`);
            throw new Error(`没有找到豆包“视频生成”或“更多”入口：${JSON.stringify(diagnostic)}`);
          }
       }
       else { await new Promise(resolve => setTimeout(resolve, uiTiming(session, "menuSettlingMs"))); menuVideo = await this.evaluate(session, `(() => {
         const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'};
          const hit=[...document.querySelectorAll('button,[role="button"],[role="menuitem"],a,[tabindex],div,span')].filter(visible)
            .map(el=>({el,text:String(el.innerText||el.textContent||el.getAttribute('aria-label')||el.getAttribute('title')||'').replace(/\\s+/g,'').trim(),r:el.getBoundingClientRect()}))
            .filter(x=>/^(视频生成|生成视频)$/.test(x.text)&&x.r.width<420&&x.r.height<120)
            .sort((a,b)=>a.r.width*a.r.height-b.r.width*b.r.height)[0];
          if(!hit)return false;hit.el.click();return true;
       })()`); }
       if (!menuVideo) {
         const menuDiagnostic = await this.evaluate(session, `(() => { const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&r.top>=0&&r.bottom<=innerHeight&&s.display!=='none'&&s.visibility!=='hidden'}; const clean=v=>String(v||'').replace(/\\s+/g,' ').trim(); return {bodyText:clean(document.body?.innerText||'').slice(-1200), candidates:[...document.querySelectorAll('button,[role="button"],[role="menuitem"],a,[tabindex],div,span')].filter(visible).map(e=>({tag:e.tagName,text:clean(e.innerText||e.textContent||e.getAttribute('aria-label')||e.getAttribute('title')||''),role:e.getAttribute('role')||'',rect:(()=>{const r=e.getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}})()})).filter(x=>/视频|生成|工作/.test(x.text)).slice(-40)}; })()`);
         throw new Error(`已展开“更多”，但没有找到“视频生成”：${JSON.stringify(menuDiagnostic)}`);
       }
    }
    const maxAttempts=2,confirmTimeoutMs=Math.max(20,Number(session?.videoModeConfirmTimeoutMs)||10000),confirmIntervalMs=Math.min(uiTiming(session,"modePollMs"),Math.max(5,Math.round(confirmTimeoutMs/3)));let active=false;
    for(let attempt=1;attempt<=maxAttempts&&!active;attempt+=1){
      const deadline=Date.now()+confirmTimeoutMs;
      while(Date.now()<deadline&&!active){active=Boolean((await modeState())?.active);if(!active)await new Promise(resolve=>setTimeout(resolve,confirmIntervalMs));}
        if(!active&&attempt<maxAttempts){await dismissTransientUi();direct=await findDirect();if(direct?.verified){const domResult=await clickVideoEntry();if(!domResult?.clicked)await clickPoint(direct);}}
    }
    if (!active && !session.videoModeRetry) {
      // The SPA can finish navigation while leaving the composer in a stale
      // workspace. Reset the fresh conversation once before reporting failure.
      session.videoModeRetry = true;
      try { await this.prepareFreshConversation(session, session.account); return await this.ensureVideoMode(session); }
      finally { session.videoModeRetry = false; }
    }
    if (!active){const diagnostic=await this.evaluate(session, `(() => {/*doubao-video-mode-diagnostic*/const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'};const editor=[...document.querySelectorAll('textarea,input,[contenteditable="true"],[role="textbox"],[data-slate-editor="true"],.ProseMirror')].filter(visible).sort((a,b)=>b.getBoundingClientRect().bottom-a.getBoundingClientRect().bottom)[0];return{url:location.href,placeholder:String(editor?.getAttribute('placeholder')||editor?.getAttribute('aria-placeholder')||editor?.querySelector?.('[data-placeholder]')?.getAttribute('data-placeholder')||''),videoButtons:[...document.querySelectorAll('button,[role="button"],a,[tabindex]')].filter(visible).map(e=>String(e.innerText||e.textContent||e.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim()).filter(value=>/视频生成|生成视频/.test(value)).slice(-12),actionbarKeys:[...document.querySelectorAll('[data-input-engine-actionbar-control-key],[data-input-engine-actionbar-render-entry-key],[data-creation-params-panel-id]')].filter(visible).map(e=>({control:e.getAttribute('data-input-engine-actionbar-control-key')||'',render:e.getAttribute('data-input-engine-actionbar-render-entry-key')||'',panel:e.getAttribute('data-creation-params-panel-id')||'',text:String(e.innerText||e.textContent||'').replace(/\s+/g,' ').trim()})),viewport:{width:innerWidth,height:innerHeight}}})()`);throw new Error(`点击后未确认进入豆包视频生成模式：${JSON.stringify({...diagnostic,lastTarget:direct,attempts:maxAttempts})}`);}
    return true;
  }
  async setVideoParameters(session, payload = {}) {
    if (session.testMode) return normalizeVideoParameters(payload);
    const desired=normalizeVideoParameters(payload);
    const waitForAction=async(action,{timeoutMs=5000,intervalMs=200}={})=>{const deadline=Date.now()+timeoutMs;let result=false;while(Date.now()<deadline&&!result){result=await action();if(!result)await new Promise(resolve=>setTimeout(resolve,intervalMs));}return result;};
    const clickPoint=async point=>{const cdp=await this.connect(session);await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:point.x,y:point.y});await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",x:point.x,y:point.y,button:"left",clickCount:1});await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",x:point.x,y:point.y,button:"left",clickCount:1});};
    const findModelControl=()=>this.evaluate(session, `(() => {/*doubao-model-control*/const target=${JSON.stringify(desired.model)},clean=v=>String(v||'').replace(/\\s+/g,'').toLowerCase(),visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'};const targetText=clean(target),control=[...document.querySelectorAll('[data-input-engine-actionbar-control-key="video-model"],button,[role="button"]')].filter(visible).find(e=>e.matches?.('[data-input-engine-actionbar-control-key="video-model"]')||clean(e.innerText||e.textContent||'').includes('seedance2.0'));if(!control)return false;const r=control.getBoundingClientRect(),text=String(control.innerText||control.textContent||'').trim();return{x:r.left+r.width/2,y:r.top+r.height/2,selected:clean(text).includes(targetText),text,state:control.getAttribute('data-state')||'',ariaChecked:control.getAttribute('aria-checked')||''}})()`);
    let modelControl=await waitForAction(findModelControl);
    if(!modelControl){
      const diagnostic=await this.evaluate(session, `(() => {const detectTrustedQuota=${detectTrustedQuotaMessage.toString()};const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'};const editor=[...document.querySelectorAll('textarea,input,[contenteditable="true"],[role="textbox"],[data-slate-editor="true"]')].filter(visible).sort((a,b)=>b.getBoundingClientRect().bottom-a.getBoundingClientRect().bottom)[0];const overlays=[...document.querySelectorAll('[role="alert"],[role="dialog"],[role="status"],[class*="toast"],[class*="Toast"],[class*="notice"],[class*="Notice"],[data-testid*="quota"],[class*="quota"]')].filter(visible).map(node=>String(node.innerText||node.textContent||''));let composer=editor;for(let depth=0;composer&&depth<5;depth+=1){const text=String(composer.innerText||composer.textContent||'').replace(/\s+/g,' ').trim();if(text.length>=20&&text.length<=1600)break;composer=composer.parentElement;}const composerText=String(composer?.innerText||composer?.textContent||'');const quota=detectTrustedQuota([...overlays,composerText]);return{url:location.href,placeholder:String(editor?.getAttribute('placeholder')||editor?.getAttribute('aria-placeholder')||editor?.querySelector?.('[data-placeholder]')?.getAttribute('data-placeholder')||''),quota,quotaSource:quota?(detectTrustedQuota(overlays)?'visible-overlay':'composer-area'):'',videoButtons:[...document.querySelectorAll('button,[role="button"]')].filter(visible).map(e=>String(e.innerText||e.textContent||e.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim()).filter(value=>/视频生成|生成视频/.test(value)).slice(-8),actionbarKeys:[...document.querySelectorAll('[data-input-engine-actionbar-control-key],[data-input-engine-actionbar-render-entry-key],[data-creation-params-panel-id]')].filter(visible).map(e=>({control:e.getAttribute('data-input-engine-actionbar-control-key')||'',render:e.getAttribute('data-input-engine-actionbar-render-entry-key')||'',panel:e.getAttribute('data-creation-params-panel-id')||'',text:String(e.innerText||e.textContent||'').replace(/\s+/g,' ').trim()})),viewport:{width:innerWidth,height:innerHeight}}})()`);
      if(diagnostic?.quota){const error=new Error(diagnostic.quota);error.code="DOUBAO_QUOTA_EXHAUSTED";error.quotaExhausted=true;error.notSentVerified=true;throw error;}
      throw new Error(`没有找到豆包视频模型选择器：${JSON.stringify(diagnostic)}`);
    }
    if(!modelControl.selected){
      const findModelItem=()=>this.evaluate(session, `(() => {/*doubao-model-menu-item*/const target=${JSON.stringify(desired.model)},clean=v=>String(v||'').replace(/\\s+/g,'').toLowerCase(),visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'};const targetText=clean(target),items=[...new Set(document.querySelectorAll('[role="menuitem"],[role="option"],[data-radix-collection-item]'))].filter(visible).map(e=>({e,r:e.getBoundingClientRect(),text:String(e.innerText||e.textContent||'').trim(),state:e.getAttribute('data-state')||'',ariaChecked:e.getAttribute('aria-checked')||''})).filter(x=>clean(x.text)===targetText||clean(x.text).startsWith(targetText)).sort((a,b)=>Number(clean(a.text)!==targetText)-Number(clean(b.text)!==targetText)||a.r.width*a.r.height-b.r.width*b.r.height||a.r.top-b.r.top);if(!items[0])return false;return{x:items[0].r.left+items[0].r.width/2,y:items[0].r.top+items[0].r.height/2,text:items[0].text,state:items[0].state,ariaChecked:items[0].ariaChecked}})()`);
      const isModelMenuOpen=()=>this.evaluate(session, `(() => {/*doubao-model-menu-open*/const clean=v=>String(v||'').replace(/\\s+/g,'').toLowerCase(),visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'};return[...document.querySelectorAll('[role="menu"][data-state="open"],[role="listbox"],[data-radix-popper-content-wrapper]')].filter(visible).some(menu=>{const text=clean(menu.innerText||menu.textContent||'');return text.includes('seedance2.0fast')||text.includes('seedance2.0mini')})})()`);
      const verifyModel=()=>this.evaluate(session, `(() => {/*doubao-model-verified*/const target=${JSON.stringify(desired.model)},clean=v=>String(v||'').replace(/\\s+/g,'').toLowerCase(),visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'};const targetText=clean(target),control=[...document.querySelectorAll('[data-input-engine-actionbar-control-key="video-model"],button,[role="button"]')].filter(visible).find(e=>e.matches?.('[data-input-engine-actionbar-control-key="video-model"]')&&clean(e.innerText||e.textContent||'').includes(targetText));return Boolean(control)})()`);
      const closeModelMenu=async()=>{const cdp=await this.connect(session);await cdp.send("Input.dispatchKeyEvent",{type:"rawKeyDown",key:"Escape",code:"Escape"});await cdp.send("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape"});};
      const maxAttempts=3;
      const verifyTimeoutMs=Math.max(50,Number(session?.modelSelectionVerificationTimeoutMs)||3500);
      let modelVerified=false;
      for(let attempt=1;attempt<=maxAttempts&&!modelVerified;attempt+=1){
        modelControl=await waitForAction(findModelControl,{timeoutMs:attempt===1?2500:1500,intervalMs:100});
        if(modelControl?.selected||await verifyModel()){modelVerified=true;break;}
        let modelItem=await waitForAction(findModelItem,{timeoutMs:350,intervalMs:100});
        if(!modelItem){
          if(!await isModelMenuOpen()){
            if(!modelControl)continue;
            await clickPoint(modelControl);
            await waitForAction(isModelMenuOpen,{timeoutMs:2500,intervalMs:100});
          }
          modelItem=await waitForAction(findModelItem,{timeoutMs:2500,intervalMs:100});
        }
        if(modelItem){
          await clickPoint(modelItem);
          modelVerified=Boolean(await waitForAction(verifyModel,{timeoutMs:verifyTimeoutMs,intervalMs:150}));
        }
        if(!modelVerified&&attempt<maxAttempts)await closeModelMenu();
      }
      if(!modelVerified){
        const diagnostic=await this.evaluate(session, `(() => {/*doubao-model-diagnostic*/const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'},describe=e=>({text:String(e.innerText||e.textContent||'').replace(/\\s+/g,' ').trim(),role:e.getAttribute('role')||'',state:e.getAttribute('data-state')||'',ariaChecked:e.getAttribute('aria-checked')||''});return{target:${JSON.stringify(desired.model)},attempts:${maxAttempts},controls:[...document.querySelectorAll('[data-input-engine-actionbar-control-key="video-model"]')].filter(visible).map(describe),menus:[...document.querySelectorAll('[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]')].filter(visible).map(describe),items:[...document.querySelectorAll('[role="menuitem"],[role="option"],[data-radix-collection-item]')].filter(visible).map(describe).filter(x=>/Seedance/i.test(x.text)).slice(0,12)}})()`);
        throw new Error(`豆包视频模型确认失败：${desired.model} ${JSON.stringify(diagnostic)}`);
      }
    }
    return reconcileVideoParameters(this, session, desired);
  }
  async waitForVideo(session, {jobId, conversationId = "", prompt = "", userMessageId = "", submittedAt = "", timeoutMs = 30000} = {}) {
    if (session.testMode) return {url: `mock://video/${jobId}`, mimeType: "video/mp4", conversationId, videoVid:`mock_vid_${jobId}`, source: "mock"};
    session.currentJobId = String(jobId || session.currentJobId || "");
    if (conversationId) session.conversationId = String(conversationId);
    await this.connect(session);
    // timeoutMs=0 表示持续监听；任务终态只能由豆包明确完成或明确失败决定。
    const requestedTimeoutMs = Number(timeoutMs);
    const deadline = requestedTimeoutMs > 0 ? Date.now() + Math.max(1000, requestedTimeoutMs) : Number.POSITIVE_INFINITY;
    let lastProviderProbeAt = 0;
    while (Date.now() < deadline) {
      // 生成过程中豆包可能在页面上直接报告额度、审核或任务失败。
      // 仅监听 video response 会把这些终态误判成“等待超时”，也无法切换账号。
      if (prompt && Date.now() - lastProviderProbeAt >= 1000) {
        lastProviderProbeAt = Date.now();
        try {
          const provider = await this.readSubmissionState(session, String(prompt), String(userMessageId || ""), String(conversationId || ""), String(submittedAt || ""));
          if (provider?.codeOnlyVideoResponse && !provider?.videoTaskCard) {
            throw Object.assign(new Error("豆包仅返回了生成代码和渲染说明，尚未确认创建真实视频任务"), {
              code:"DOUBAO_VIDEO_TASK_NOT_CREATED", category:"submission", providerTerminal:true,
              submissionUnknown:true, submittedVerified:false, notSentVerified:false, safeToRetry:false,
              conversationId:String(provider.conversationId || conversationId || ""),
              monitorDiagnostic:{after:provider},
            });
          }
          if (provider?.providerTerminal) {
            const failure = Object.assign(new Error(provider.providerMessageRaw || provider.providerMessage || provider.userAction || "豆包已结束生成且未返回视频"), provider);
            failure.providerTerminal = true;
            failure.terminalFailureVerified = true;
            failure.submittedVerified = true;
            failure.notSentVerified = false;
            throw failure;
          }
          // A submitted task can echo its full prompt while its result card is
          // rendering. Planning words do not revoke earlier submission evidence.
          // Keep monitoring; a timeout stays unknown and must not be resubmitted.
          if (provider?.verification) {
            throw Object.assign(new Error("豆包生成过程中需要人工验证"), {code: "DOUBAO_VERIFICATION_REQUIRED", category: "authentication", verificationRequired: true, submittedVerified: true, notSentVerified: false});
          }
        } catch (error) {
          if (error?.providerTerminal || error?.verificationRequired) throw error;
        }
      }
      const candidates = session.captures.filter(item => !session.consumedCaptures.has(item.seq));
      const match = candidates.find(item => {
        const sameJob = !jobId || String(item.jobId || "") === String(jobId);
        const sameConversation = !conversationId || String(item.conversationId || "") === String(conversationId);
        return sameJob && sameConversation;
      });
      if (match) {
        session.consumedCaptures.add(match.seq);
        let videoVid=normalizeVideoVid(match.videoVid)||this.latestVideoVid(session,{jobId,conversationId});
        if(!videoVid){const pageProbe=await this.evaluate(session,`(${probeDoubaoVideoResultPage.toString()})()`);videoVid=normalizeVideoVid(pageProbe?.videoVid);if(videoVid)this.storeVideoIdentifiers(session,[videoVid],{at:Date.now(),jobId:String(jobId||""),conversationId:String(conversationId||session.conversationId||""),messageId:String(pageProbe?.messageId||""),source:"dom-message-before-capture"});}
        return {...match, conversationId: match.conversationId || conversationId || "", videoVid};
      }
      const pageVideo = await this.evaluate(session, `(${probeDoubaoVideoResultPage.toString()})()`);
      if(pageVideo?.videoVid)this.storeVideoIdentifiers(session,[pageVideo.videoVid],{at:Date.now(),jobId:String(jobId||""),conversationId:String(conversationId||session.conversationId||""),messageId:String(pageVideo.messageId||""),source:"dom-message"});
      if (pageVideo?.url) return {seq: `dom-${Date.now()}`, at: Date.now(), url: pageVideo.url, mimeType: "video/mp4", status: 200, jobId: String(jobId || ""), conversationId: String(conversationId || session.conversationId || ""), videoVid:normalizeVideoVid(pageVideo.videoVid)||this.latestVideoVid(session,{jobId,conversationId}), source: "dom-video"};
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    let diagnostic = {};
    try {
      diagnostic = await this.evaluate(session, `(() => {
        const text = String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
        const url = String(location.href || '');
        const videos = [...document.querySelectorAll('video')].map(video => ({url: video.currentSrc || video.src || '', readyState: video.readyState, duration: video.duration}));
        return {url, title: document.title, readyState: document.readyState, bodyTail: text.slice(-1800), videos};
      })()`);
    } catch (error) {
      diagnostic = {probeError: String(error?.message || error)};
    }
    const timeout = new Error("等待当前任务视频资源超时");
    timeout.code = "DOUBAO_VIDEO_RESULT_TIMEOUT";
    timeout.monitorDiagnostic = {
      ...diagnostic,
      captureCount: Array.isArray(session.captures) ? session.captures.length : 0,
      jobCaptureCount: Array.isArray(session.captures) ? session.captures.filter(item => String(item.jobId || '') === String(jobId || '')).length : 0,
      videoIdentifiers: Array.isArray(session.videoIdentifiers) ? session.videoIdentifiers.slice(-10) : [],
      conversationId: String(conversationId || session.conversationId || ''),
    };
    throw timeout;
  }
  async resolveWatermarkFreeVideo(session, {videoVid, conversationId = ""} = {}) {
    if (session.testMode) return null;
    return resolveDoubaoWatermarkFreeVideo({
      evaluate: expression => this.evaluate(session, expression),
      videoVid,
      conversationId,
    });
  }
  async downloadDoubaoVideoWithFallback(session, resource = {}, {jobId, conversationId = "", videoVid = "", fallbackResultVid = ""} = {}) {
    const normalizedVideoVid = normalizeVideoVid(videoVid || resource.videoVid);
    const pageUrl = String(fallbackResultVid || resource.fallbackResultVid || resource.pageUrl || resource.url || "").trim();
    const errors = [];
    let watermark = null;
    if (!session.testMode && normalizedVideoVid) {
      try {
        watermark = await this.resolveWatermarkFreeVideo(session, {videoVid: normalizedVideoVid, conversationId});
      } catch (error) {
        errors.push(summarizeWatermarkFreeError(error));
      }
    } else if (!session.testMode) {
      errors.push("DOUBAO_AISPACE_VIDEO_VID_MISSING: 缺少豆包视频 VID，已使用页面视频地址");
    }
    const candidates = [
      {url: watermark?.mainUrl || "", source: "doubao-aispace-watermark-free", candidate: "main_url", watermarkFree: true},
      {url: watermark?.backupUrl || "", source: "doubao-aispace-watermark-free", candidate: "backup_url", watermarkFree: true},
      {url: pageUrl, source: "doubao-page-fallback", candidate: "page_url", watermarkFree: false},
    ].filter((item, index, items) => item.url && items.findIndex(value => value.url === item.url) === index);
    const allowed = candidates.filter(item => session.testMode ? /^(?:mock|https?):\/\//i.test(item.url) : isTrustedDoubaoVideoUrl(item.url));
    if (!allowed.length) {
      throw Object.assign(new Error(errors.at(-1) || "没有可下载的可信豆包视频地址"), {code: "DOUBAO_RESULT_URL_UNAVAILABLE", watermarkFreeError: errors.join("；")});
    }
    let cookie = "";
    if (!session.testMode) {
      const cdp = await this.connect(session);
      const cookies = await cdp.send("Network.getCookies", {urls: [...allowed.map(item => item.url), "https://www.doubao.com/"]});
      cookie = (cookies.cookies || []).map(item => `${item.name}=${item.value}`).join("; ");
    }
    let lastError = null;
    for (const candidate of allowed) {
      try {
        const downloaded = await this.downloader.download({...resource, url: candidate.url, mimeType: resource.mimeType || "video/mp4"}, {jobId, cookie});
        return {
          ...downloaded,
          videoUrl: candidate.url,
          resultUrls: [candidate.url],
          resultUrlSource: candidate.source,
          resultUrlCandidate: candidate.candidate,
          watermarkFree: candidate.watermarkFree,
          watermarkFreeError: errors.join("；"),
          resultSourceResolvedAt: watermark?.resolvedAt || new Date().toISOString(),
          fallbackResultVid: pageUrl,
          videoVid: normalizedVideoVid,
          resourceDescriptor: {...resource, url: candidate.url, pageUrl, videoVid: normalizedVideoVid, resultUrlSource: candidate.source},
        };
      } catch (error) {
        lastError = error;
        errors.push(`${candidate.candidate} 下载失败：${String(error?.message || error).replace(/https?:\/\/\S+/gi, "[已隐藏签名地址]").slice(0, 300)}`);
      }
    }
    const failure = lastError || new Error("豆包视频下载失败");
    failure.code = failure.code || "DOUBAO_RESULT_DOWNLOAD_FAILED";
    failure.watermarkFreeError = errors.join("；");
    throw failure;
  }
  async findReferenceFileInput(session) {
    const cdp=await this.connect(session);
    await cdp.send("DOM.enable").catch(()=>{});
    const document=await cdp.send("DOM.getDocument",{depth:-1,pierce:true}),rootId=document.root?.nodeId;
    if(!rootId)return null;
    for(const selector of ['input[type="file"][accept*=".png"]','input[type="file"][accept*="image"]','input[type="file"]']){
      const result=await cdp.send("DOM.querySelector",{nodeId:rootId,selector});
      if(result.nodeId)return{cdp,nodeId:result.nodeId};
    }
    return null;
  }
  async clickReferenceUploadTrigger(session) {
    return this.evaluate(session,`(() => {
      const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'};
      const editor=[...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"],[data-slate-editor="true"]')].filter(visible).sort((a,b)=>b.getBoundingClientRect().bottom-a.getBoundingClientRect().bottom)[0];
      const er=editor?.getBoundingClientRect();
      const candidates=[...document.querySelectorAll('button,[role="button"],label,[data-dbx-name="button"],div[tabindex]')].filter(visible).map(el=>{const text=String(el.innerText||el.textContent||el.getAttribute('aria-label')||el.getAttribute('title')||'').replace(/\\s+/g,'').trim(),hint=String(el.outerHTML||'').slice(0,1200),r=el.getBoundingClientRect();let score=0;if(/上传图片|添加图片|参考图|图片参考|上传素材|添加素材|附件/.test(text))score+=220;if(/upload|image|picture|attachment|file|photo/i.test(hint))score+=90;if(er&&r.top>=er.top-140&&r.bottom<=er.bottom+100)score+=80;if(r.top>innerHeight*.45)score+=30;if(/发送|生成|模型|比例|时长/.test(text))score-=240;return{el,text,score}}).filter(item=>item.score>70).sort((a,b)=>b.score-a.score);
      if(!candidates[0])return'';candidates[0].el.click();return candidates[0].text||'图标按钮';
    })()`);
  }
  async setReferenceFile(session, filePath) {
    for(let attempt=0;attempt<5;attempt++){
      const input=await this.findReferenceFileInput(session);
      if(input){await input.cdp.send("DOM.setFileInputFiles",{nodeId:input.nodeId,files:[filePath]});return true;}
      await this.clickReferenceUploadTrigger(session);
      await new Promise(resolve=>setTimeout(resolve,uiTiming(session,"filePickerPollMs")));
    }
    throw referenceUploadError("没有找到豆包参考图片上传入口");
  }
  async resetReferenceFileInput(session) {
    const input = await this.findReferenceFileInput(session);
    if (input) {
      try { await input.cdp.send("DOM.setFileInputFiles", {nodeId: input.nodeId, files: []}); } catch {}
    }
    await this.evaluate(session, `(() => {
      for (const input of document.querySelectorAll('input[type="file"]')) {
        try { input.value = ''; } catch {}
      }
      return true;
    })()`);
    await new Promise(resolve => setTimeout(resolve, uiTiming(session, "filePickerPollMs")));
  }
  async readReferenceUploadState(session) {
    return this.evaluate(session,`(() => {
      const visible=el=>{if(!el)return false;const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'};
      const editor=[...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"],[data-slate-editor="true"]')].filter(visible).sort((a,b)=>b.getBoundingClientRect().bottom-a.getBoundingClientRect().bottom)[0],er=editor?.getBoundingClientRect();
      const near=el=>{const r=el.getBoundingClientRect();return !er||(r.bottom>=Math.max(0,er.top-430)&&r.top<=Math.min(innerHeight,er.bottom+120))};
      const sources=new Set();
      for(const image of [...document.querySelectorAll('img')].filter(el=>visible(el)&&near(el))){const r=image.getBoundingClientRect(),src=String(image.currentSrc||image.src||'');if(r.width>=24&&r.height>=24&&r.width<=520&&r.height<=520&&src)sources.add(src);}
      for(const node of [...document.querySelectorAll('[style*="background-image"]')].filter(el=>visible(el)&&near(el))){const value=String(node.style.backgroundImage||'');if(value&&value!=='none')sources.add(value);}
      const fileNames=[...document.querySelectorAll('[class*="upload"],[class*="attachment"],[class*="file"],[class*="image"],[class*="preview"]')].filter(el=>visible(el)&&near(el)).map(el=>String(el.innerText||el.textContent||'').trim()).filter(text=>/\\.(?:png|jpe?g|webp)/i.test(text));
      const fileCount=[...document.querySelectorAll('input[type="file"]')].reduce((sum,input)=>sum+Number(input.files?.length||0),0);
      const alerts=[...document.querySelectorAll('[role="alert"],[class*="toast"],[class*="Toast"],[class*="notice"],[class*="Notice"]')].filter(visible).map(el=>String(el.innerText||el.textContent||'')).join(' ');
      const bodyTail=String(document.body?.innerText||'').slice(-3000),statusText=(alerts+' '+bodyTail).replace(/\\s+/g,' ');
      return{previewCount:sources.size,fileCount,fileNames:[...new Set(fileNames)].slice(0,20),pending:/(上传中|正在上传|处理中|解析中)/.test(statusText),failure:/(上传失败|解析失败|格式不支持|文件过大|图片违规|素材违规)/.test(statusText)?statusText.slice(-500):''};
    })()`);
  }
  async uploadSingleReferenceImage(session, asset, index, total) {
    const before=await this.readReferenceUploadState(session),startedAt=Date.now();
    session.assetUploadRequests=Array.isArray(session.assetUploadRequests)?session.assetUploadRequests:[];
    session.pendingAssetUpload={assetId:asset.id,name:asset.name,startedAt};session.phase="uploading";
    try{
      await this.setReferenceFile(session,asset.path);
      let stable=0,lastState=before;
      const deadline=Date.now()+30000;
      while(Date.now()<deadline){
        await new Promise(resolve=>setTimeout(resolve,uiTiming(session,"uploadProbeMs")));
        const state=await this.readReferenceUploadState(session);lastState=state;
        if(state?.failure)throw referenceUploadError(`参考图“${asset.name}”上传失败：${state.failure}`);
        const requests=(session.assetUploadRequests||[]).filter(item=>item.assetId===asset.id&&item.at>=startedAt-500),successful=requests.filter(item=>item.status>=200&&item.status<300);
        const previewDelta=Math.max(0,Number(state?.previewCount||0)-Number(before?.previewCount||0));
        const fileDelta=Math.max(0,Number(state?.fileCount||0)-Number(before?.fileCount||0));
        // Some Doubao builds accept the file through the picker and render the
        // preview through an internal channel without exposing a matching HTTP
        // upload response. A new file input entry is valid evidence only after
        // the UI reports a stable, non-pending state.
        const verifiedBy=previewDelta>=1?"reference-preview":successful.length?"upload-response":fileDelta>=1?"file-input":"";
        if(verifiedBy&&!state?.pending&&Date.now()-startedAt>=uiTiming(session,"uploadStableMs"))stable++;else stable=0;
        if(stable>=2)return{assetId:asset.id,name:asset.name,index:index+1,total,path:asset.path,verified:true,verifiedBy,previewDelta,fileDelta,requestIds:successful.map(item=>item.requestId).filter(Boolean),completedAt:new Date().toISOString()};
      }
      throw referenceUploadError(`参考图“${asset.name}”未获得上传完成证据`,{uploadState:lastState});
    }finally{session.pendingAssetUpload=null;}
  }
  async uploadReferenceImages(session, payload = {}) {
    const assets=normalizeReferenceAssets(payload);
    if(!assets.length)return{requestedCount:0,uploadedCount:0,verified:true,items:[]};
    if(session.testMode)return{requestedCount:assets.length,uploadedCount:assets.length,verified:true,items:assets.map((asset,index)=>({assetId:asset.id,name:asset.name,index:index+1,total:assets.length,role:asset.role,label:asset.label,description:asset.description,verified:true,verifiedBy:"test-mode"})),manifest:buildReferenceManifest(assets)};
    const items=[];
    for(let index=0;index<assets.length;index++){
      const asset=assets[index], diagnostics=[];
      let uploaded=null;
      for(let attempt=1;attempt<=3;attempt++){
        if(attempt>1) await this.resetReferenceFileInput(session);
        try {
          uploaded=await this.uploadSingleReferenceImage(session,asset,index,assets.length);
          uploaded.attempt=attempt;
          break;
        } catch(error) {
          diagnostics.push({attempt,message:String(error?.message||error),uploadState:error?.uploadState||null,assetUploadRequests:(session.assetUploadRequests||[]).filter(item=>item.assetId===asset.id),failure:error?.providerMessage||error?.details?.failure||""});
          if(attempt===3){
            error.uploadAttempts=diagnostics;
            error.assetName=asset.name;
            error.safeToRetry=true;
            error.notSentVerified=true;
            throw error;
          }
        }
      }
      items.push(uploaded);
    }
    return{requestedCount:assets.length,uploadedCount:items.length,verified:items.length===assets.length,items:items.map((item,index)=>({...item,role:assets[index]?.role||"other",label:assets[index]?.label||assets[index]?.name||"",description:assets[index]?.description||""})),manifest:buildReferenceManifest(assets),completedAt:new Date().toISOString()};
  }
  async reassertVideoSubmissionReady(session, payload = {}, referenceUpload = {}) {
    const visibleReferenceCount = state => Math.max(
      Number(state?.previewCount || 0),
      Number(state?.fileCount || 0),
      Array.isArray(state?.fileNames) ? state.fileNames.length : 0,
    );
    const before = await this.readReferenceUploadState(session);
    const referenceCountBefore = visibleReferenceCount(before);
    await this.ensureVideoMode(session);
    await this.setVideoParameters(session, payload);
    // Parameter reconciliation opens the popover when the requested ratio or
    // duration differs from the current selection. Close it before probing or
    // using the composer so it cannot cover the send control.
    await this.closeVideoParameterPanel(session);
    await this.waitForComposer(session, 15000);
    let after = await this.readReferenceUploadState(session);
    let referenceCountAfter = visibleReferenceCount(after);
    const expectedCount = Math.max(
      Number(referenceUpload?.requestedCount || 0),
      Number(referenceUpload?.uploadedCount || 0),
    );
    // Upload completion evidence is not the same as attachment evidence after
    // the video editor has been rebuilt.  The old guard only rejected a drop
    // when the *before* probe already saw all files; a 0 -> 0 probe therefore
    // allowed the prompt to be written and sent with no references attached.
    // Wait briefly for the rebuilt editor to expose its previews/file state,
    // then require the requested number before the composer can be filled.
    if (expectedCount > 0 && referenceUpload?.verified !== true) {
      throw referenceUploadError(
        `豆包参考图上传结果未完成校验（${Number(referenceUpload?.uploadedCount || 0)}/${expectedCount}），本次提示词尚未发送`,
        {referenceCountBefore, referenceCountAfter, expectedCount, uploadStateBefore:before, uploadStateAfter:after},
      );
    }
    if (expectedCount > 0 && referenceCountAfter < expectedCount) {
      const deadline = Date.now() + Math.max(1000, Number(session.referenceVerificationTimeoutMs) || 8000);
      while (referenceCountAfter < expectedCount && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, Math.min(200, Math.max(25, deadline - Date.now()))));
        after = await this.readReferenceUploadState(session);
        referenceCountAfter = visibleReferenceCount(after);
        if (after?.failure) break;
      }
    }
    if (expectedCount > 0 && referenceCountAfter < expectedCount) {
      throw referenceUploadError(
        `重新进入视频生成模式后未确认全部参考图（${referenceCountBefore} → ${referenceCountAfter}，需要 ${expectedCount} 张），本次提示词尚未发送`,
        {referenceCountBefore, referenceCountAfter, expectedCount, uploadStateBefore:before, uploadStateAfter:after},
      );
    }
    return {referenceCountBefore, referenceCountAfter, expectedCount, before, after};
  }
  async closeVideoParameterPanel(session) {
    if (!session || session.testMode) return false;
    let open = false;
    try {
      open = Boolean(await this.evaluate(session, `(() => {
        const visible = element => {
          if (!element) return false;
          const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
          return rect.width > 2 && rect.height > 2 && style.display !== "none" && style.visibility !== "hidden";
        };
        return [...document.querySelectorAll('[data-input-engine-actionbar-render-entry-key="video-generation-params-panel"],[data-creation-params-panel-id]')]
          .filter(visible)
          .some(element => element.getAttribute('data-state') === 'open' || element.getAttribute('aria-expanded') === 'true');
      })()`));
    } catch {}
    if (!open) return false;
    const cdp = await this.connect(session);
    for (let index = 0; index < 2; index += 1) {
      await cdp.send("Input.dispatchKeyEvent", {type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27});
      await cdp.send("Input.dispatchKeyEvent", {type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27});
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    return true;
  }
  async checkPageBlocker(session, {dismissPromotion = false} = {}) {
    const blocker = await this.evaluate(session, `(${probePageBlocker.toString()})()`);
    session.lastPageBlocker = blocker || {kind:""};
    if (blocker?.kind === "asset_authorization") {
      const item = this.embeddedBrowserProvider?.()?.automationSessions?.get(session.account?.id);
      if (item) item.blockedForUser = true;
      throw Object.assign(new Error(blocker.message), {code:"DOUBAO_ASSET_AUTHORIZATION_REQUIRED",category:"manual_action",safeToRetry:false,
        notSentVerified:session.phase!=="submitting"&&session.phase!=="generating",submittedVerified:false,
        submissionUnknown:session.phase==="submitting",verificationRequired:true,
        conversationId:session.conversationId||"",monitorDiagnostic:{blocker}});
    }
    if (dismissPromotion && blocker?.kind === "desktop_promotion") {
      await this.dispatchHumanClick(session, blocker.dismissPoint, async () => {
        const fresh = await this.evaluate(session, `(${probePageBlocker.toString()})()`);
        return fresh?.kind === "desktop_promotion" && Math.hypot(fresh.dismissPoint.x-blocker.dismissPoint.x,fresh.dismissPoint.y-blocker.dismissPoint.y)<4;
      });
    }
    return blocker;
  }
  async readComposerReadiness(session, prepare = false, findSend = false) {
    const expected = session.composerExpected;
    if (!expected) return {ready: false, reason: "composer-expectation-missing"};
    return await this.evaluate(session, `(${probeComposer.toString()})(${JSON.stringify(expected.prompt)},${JSON.stringify(expected.token)},${prepare},${findSend})`) || {ready: false, reason: "composer-probe-empty"};
  }
  async readConversationTurn(session, expected = "") {
    const value = await this.evaluate(session, `(${probeConversationTurn.toString()})(${JSON.stringify(expected)})`);
    const requests = (session.submissionRequests || []).filter(item => item.jobId === session.currentJobId && item.promptMatched && /completion/i.test(item.url));
    return {...value, known: value?.known === true, replyFailed: requests.some(item => item.failed), responding: value?.responding === true || requests.some(item => !item.finishedAt)};
  }
  async waitForAssistantReply(session, {timeoutMs = 90000} = {}) {
    const deadline = Date.now() + timeoutMs;
    do {
      const state = await this.readConversationTurn(session);
      session.lastConfirmationDiagnostic = {...session.lastConfirmationDiagnostic, reply: state};
      if (state.replyFailed) throw Object.assign(new Error("豆包上一条回复连接中断，确认话术未发送；请检查原会话，不要重复提交任务"), {code:"DOUBAO_REPLY_STREAM_FAILED",category:"submission",submissionUnknown:true,safeToRetry:false,notSentVerified:false});
      if (state.known && !state.responding) return state;
      await new Promise(resolve => setTimeout(resolve, uiTiming(session, "submissionProbeMs")));
    } while (Date.now() < deadline);
    throw Object.assign(new Error("豆包上一条回复尚未结束，确认话术未发送；请在原会话查看回复状态，不要重复提交任务"), {
      code: "DOUBAO_REPLY_NOT_FINISHED", category: "submission", submissionUnknown: true, safeToRetry: false, notSentVerified: false,
      monitorDiagnostic: {confirmation: session.lastConfirmationDiagnostic},
    });
  }
  async waitForConfirmationDelivery(session, prompt, conversationId, {timeoutMs = 15000} = {}) {
    const deadline = Date.now() + timeoutMs;
    let state;
    do {
      state = await this.readConversationTurn(session, prompt);
      session.lastConfirmationDiagnostic = {...session.lastConfirmationDiagnostic, delivery: state};
      if (state.delivered && state.userMessageId && state.userMessageId !== session.pendingSubmission?.confirmationBeforeMessageId
        && state.conversationId === conversationId) return state;
      await new Promise(resolve => setTimeout(resolve, uiTiming(session, "submissionProbeMs")));
    } while (Date.now() < deadline);
    throw Object.assign(new Error(state?.queued ? "确认话术仍在豆包待发送区域，尚未送达当前会话；已停止自动重复发送，请检查原会话" : "尚未确认豆包收到确认话术，已停止自动重复发送，请检查原会话"), {
      code: state?.queued ? "DOUBAO_CONFIRMATION_QUEUED" : "DOUBAO_CONFIRMATION_DELIVERY_UNKNOWN", category: "submission",
      submissionUnknown: true, safeToRetry: false, notSentVerified: false, conversationId,
      monitorDiagnostic: {confirmation: session.lastConfirmationDiagnostic},
    });
  }
  async fillComposer(session, prompt, {timeoutMs = 15000, stableMs = uiTiming(session, "composerStableMs")} = {}) {
    await this.checkPageBlocker(session);
    const source = String(prompt || "");
    session.composerExpected = {prompt: source, token: `composer-${Date.now()}-${Math.random().toString(36).slice(2)}`, verified: false};
    if (!source.trim()) return false;
    const deadline = Date.now() + timeoutMs;
    let inserted = false, stableSince = 0;
    while (Date.now() < deadline) {
      const result = await this.readComposerReadiness(session, !inserted);
      session.lastComposerDiagnostic = result;
      if (!inserted && result.prepared) {
        const cdp = await this.connect(session);
        // Native input updates the editor's state; never fake success by assigning textContent.
        await cdp.send("Input.insertText", {text: source});
        inserted = true;
      } else if (inserted && result.ready) {
        stableSince ||= Date.now();
        if (Date.now() - stableSince >= stableMs) {
          session.composerExpected.verified = true;
          return true;
        }
      } else {
        stableSince = 0;
        // React may replace the editor after the assistant stream ends. It is
        // safe to reselect and rewrite the draft; this method never sends it.
        if (inserted && result.reason === "composer-replaced") inserted = false;
      }
      await new Promise(resolve => setTimeout(resolve, uiTiming(session, "composerPollMs")));
    }
    return false;
  }
  async dispatchHumanClick(session, point, beforePress = null) {
    if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return false;
    const cdp=await this.connect(session),x=Number(point.x),y=Number(point.y);
    const trail=[{x:x-9,y:y+5},{x:x-5,y:y+2},{x:x-2,y:y+1},{x,y}];
    for(const item of trail){await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:item.x,y:item.y,button:"none"});await new Promise(resolve=>setTimeout(resolve,uiTiming(session,"mouseMoveMs")));}
    if (beforePress && !await beforePress()) return false;
    await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",buttons:1,clickCount:1});
    await new Promise(resolve=>setTimeout(resolve,uiTiming(session,"mousePressMs")));
    await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",buttons:0,clickCount:1});
    return true;
  }
  async clickComposerSend(session, {requireIdleReply = false} = {}) {
    if (session.rehearsal) throw Object.assign(new Error("页面预演禁止发送"), {code: "DOUBAO_REHEARSAL_SEND_BLOCKED"});
    const deadline=Date.now()+5000;
    let diagnostic={reason:"send-control-not-found"};
    if (!session.composerExpected?.verified) {
      session.lastSendDiagnostic = {reason: "composer-not-verified"};
      return false;
    }
    while(Date.now()<deadline){
      if (requireIdleReply) {
        const turn = await this.readConversationTurn(session);
        if (!turn.known || turn.responding) { session.lastSendDiagnostic = {reason: "assistant-reply-not-finished"}; return false; }
      }
      const readiness = await this.readComposerReadiness(session, false, true);
      if (!readiness.ready) { session.lastSendDiagnostic = readiness; return false; }
      const point = readiness.sendPoint;
      diagnostic = readiness;
      if (point?.x !== undefined && point?.y !== undefined) {
        let current;
        const clicked = await this.dispatchHumanClick(session, point, async () => {
          if (requireIdleReply) {
            const turn = await this.readConversationTurn(session);
            if (!turn.known || turn.responding) return false;
          }
          current = await this.readComposerReadiness(session, false, true);
          return current.ready && current.sendPoint?.x === point.x && current.sendPoint?.y === point.y;
        });
        if (clicked) {
          session.lastSendDiagnostic = {...point, clickedAt: new Date().toISOString(), clickMode: "cdp-human"};
          session.composerExpected.verified = false;
          // A click is only an attempt, not delivery. A delayed/queued send
          // must never trigger another click; verify the user message below.
          return true;
        }
        // No mouse press occurred. Layout/hover changes may move or briefly
        // disable the button; reacquire it within the existing bounded wait.
        // A changed editor or prompt still stops immediately.
        diagnostic = {...current, reason: current?.reason || "send-control-moved"};
        session.lastSendDiagnostic = diagnostic;
        if (!current?.ready) { session.composerExpected.verified = false; return false; }
      }
      await new Promise(resolve=>setTimeout(resolve,uiTiming(session,"sendRetryMs")));
    }
    session.lastSendDiagnostic={...diagnostic,failedAt:new Date().toISOString(),clickMode:"cdp-human"};
    return false;
  }
  async clearComposerAfterFailedSend(session) {
    try {
      const cdp = await this.connect(session);
      const press = async (type, key, code, modifiers = 0) => cdp.send("Input.dispatchKeyEvent", {type, key, code, modifiers});
      await press("rawKeyDown", "a", "KeyA", 2);
      await press("keyUp", "a", "KeyA", 2);
      await press("rawKeyDown", "Backspace", "Backspace");
      await press("keyUp", "Backspace", "Backspace");
      session.composerExpected = null;
    } catch {}
  }
  async readSubmissionState(session, prompt, expectedUserMessageId = "", expectedConversationId = "", submittedAt = "") {
    await this.checkPageBlocker(session);
    let state=await this.evaluate(session, `(() => {
      const classifyFailure=${classifyDoubaoFailureMessage.toString()};
      const isPaidQuotaConfirmation=${isPaidQuotaConfirmation.toString()};
      const allowPaidQuota=${session.allowPaidQuota === true ? "true" : "false"};
      const shouldRequestGenerationConfirmation=${shouldRequestGenerationConfirmation.toString()};
      const match=location.pathname.match(/\\/chat\\/(\\d{6,})/);
      const conversationId=match?match[1]:'';
      const expectedConversationId=${JSON.stringify(String(expectedConversationId||""))};
      const conversationMatches=!expectedConversationId||conversationId===expectedConversationId;
      const submittedAtMs=Date.parse(${JSON.stringify(String(submittedAt||""))})||0;
      const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'};
      const input=[...document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"],[data-slate-editor="true"]')].filter(visible).sort((a,b)=>b.getBoundingClientRect().bottom-a.getBoundingClientRect().bottom)[0];
      const inputText=String(input?.value||input?.textContent||'').trim();
      const normalizeComparableText=${normalizeComparableText.toString()};
      const token=normalizeComparableText(${JSON.stringify(prompt)}).slice(0,48);
      const expectedUserMessageId=${JSON.stringify(String(expectedUserMessageId||""))};
      const compact=value=>normalizeComparableText(value);
      const ownText=node=>String(node?.innerText||node?.textContent||'').replace(/\\s+/g,' ').trim();
      const roots=[...document.querySelectorAll('[class*="message-list"],[class*="message-container"],[data-testid*="message-list"]')].filter(visible).sort((a,b)=>b.querySelectorAll('[data-message-id]').length-a.querySelectorAll('[data-message-id]').length);
      const root=roots[0]||document.querySelector('main')||document.body;
      const primary=[...root.querySelectorAll('[data-message-id]')];
      const fallback=primary.length?[]:[...root.querySelectorAll('article,[class*="message-item"],[class*="message-block"],[class*="chat-message"]')].filter(visible).filter(node=>ownText(node).length>0);
      const messages=[...new Set(primary.length?primary:fallback)];
      const isUser=node=>{const cls=String(node?.className||'');const role=String(node?.getAttribute?.('data-role')||node?.getAttribute?.('data-author')||'');const bubble=node?.querySelector?.('[class*="g-send-msg-bubble"],[class*="send-msg-bubble"],[class*="user-message"]');return /user/i.test(role)||/(^|\\s)justify-end(\\s|$)/.test(cls)||Boolean(bubble)};
      const reversed=[...messages].reverse();
      const exactUserNode=expectedUserMessageId?messages.find(node=>node.getAttribute('data-message-id')===expectedUserMessageId):null;
      const promptUserNode=token?reversed.find(node=>isUser(node)&&compact(ownText(node)).includes(token)):null;
      const latestUserNode=!expectedUserMessageId&&conversationMatches&&submittedAtMs?reversed.find(isUser):null;
      const userNode=exactUserNode||promptUserNode||latestUserNode||null;
      const currentConversationText=ownText(root);
      const promptPresentInCurrentConversation=conversationMatches&&Boolean(token)&&compact(currentConversationText).includes(token);
      const bindingMode=exactUserNode?'message-id':promptUserNode?'prompt-token':latestUserNode?'recovery-latest-user':promptPresentInCurrentConversation&&submittedAtMs?'recovery-current-conversation-text':'';
      const userIndex=userNode?messages.indexOf(userNode):-1;
      const messageTime=node=>{const raw=node?.getAttribute?.('data-created-at')||node?.getAttribute?.('data-timestamp')||node?.querySelector?.('time')?.getAttribute?.('datetime')||'';const value=Date.parse(raw);return Number.isFinite(value)?value:0};
      const signalNodes=(userIndex>=0?messages.slice(userIndex+1):[]).filter(node=>{const at=messageTime(node);return !submittedAtMs||!at||at>=submittedAtMs-5000});
      const visibleUserNodes=messages.filter(isUser);
      const hasUnmatchedVisibleUser=visibleUserNodes.some(node=>node!==exactUserNode&&node!==promptUserNode&&node!==latestUserNode);
      const recoveryTailEligible=conversationMatches&&Boolean(expectedConversationId)&&Boolean(submittedAtMs)&&!userNode&&!promptPresentInCurrentConversation&&!hasUnmatchedVisibleUser;
       const recentSignalNodes=(userIndex>=0?signalNodes:recoveryTailEligible?messages.slice(-4).filter(node=>!isUser(node)):[]).filter(node=>{const at=messageTime(node);return !submittedAtMs||!at||at>=submittedAtMs-5000});
       const assistantNodes=signalNodes.filter(node=>!isUser(node));
       const followingText=assistantNodes.map(ownText).join(' ');
      const latestAssistant=assistantNodes[assistantNodes.length-1];
      const latestAssistantText=ownText(latestAssistant);
      // Model, ratio and duration also appear in ordinary prose and user input.
      const pageTaskCard=conversationMatches&&Boolean(userNode)&&Boolean(latestAssistant?.querySelector?.('video')||latestAssistant?.querySelector?.('[class*="block-video"],[class*="video-player"],[class*="play-icon-wrapper"]'));
      const videoTaskCard=pageTaskCard;
      const planningConfirmation=!videoTaskCard&&shouldRequestGenerationConfirmation(latestAssistantText);
      const codeOnlyVideoResponse=!videoTaskCard&&/已生成代码/.test(latestAssistantText)&&/(视频|Seedance)/i.test(latestAssistantText);
       const alerts=[...document.querySelectorAll('[role="alert"],[role="dialog"],[class*="toast"],[class*="Toast"],[class*="notice"],[class*="Notice"]')].filter(visible).map(node=>String(node.innerText||node.textContent||'')).join(' ');
      const verificationOverlays=[...document.querySelectorAll('body *')].filter(node=>{if(!visible(node))return false;const hint=String(node.className||'')+' '+String(node.id||'')+' '+String(node.getAttribute?.('aria-label')||'');const own=String(node.innerText||node.textContent||'').replace(/\\s+/g,' ').trim();const style=getComputedStyle(node);return(/captcha|verify|verification|slider/i.test(hint)||['fixed','sticky'].includes(style.position))&&own.length<500&&/(安全验证|人工验证|拖动滑块|请完成验证|身份验证|captcha)/i.test(own)}).map(node=>String(node.innerText||node.textContent||'')).join(' ');
      const scopedGenerating=conversationMatches&&!planningConfirmation&&!codeOnlyVideoResponse&&/(视频生成已提交|视频生成中|正在生成视频|排队生成|排队中|已加入队列|任务已创建|任务创建成功|创作中|预计等待|你的视频生成好了|视频生成完成)/.test(latestAssistantText);
      const explicitFallback=/(本轮内容生成时请不要进行澄清，直接生成)/.test(followingText)&&!scopedGenerating;
      const recoveryScopedText=conversationMatches&&submittedAtMs&&promptPresentInCurrentConversation?currentConversationText.slice(-8000):'';
      const recoveryTailText=recoveryTailEligible?recentSignalNodes.map(ownText).join(' '):'';
      const taskBound=Boolean(userNode||promptPresentInCurrentConversation||(recoveryTailEligible&&recentSignalNodes.length));
      const scopedAlerts=conversationMatches&&taskBound?alerts:'';
      const providerSignal=[followingText,recoveryScopedText,recoveryTailText,scopedAlerts].join(' ').replace(/\\s+/g,' ').trim();
      let providerFailure=conversationMatches&&taskBound?classifyFailure([latestAssistantText||recoveryTailText,scopedAlerts].join(' ')):classifyFailure('');
      const paidQuotaPrompt=isPaidQuotaConfirmation([latestAssistantText||recoveryTailText,scopedAlerts].join(' '));
      const paidQuotaConfirmation=Boolean(allowPaidQuota&&paidQuotaPrompt);
      if(paidQuotaConfirmation) providerFailure={...providerFailure,failed:false,terminal:false,providerTerminal:false,terminalFailureVerified:false,code:'',outcomeCode:'',category:'',retryMode:'',quotaExhausted:false,accountAction:'hold',userAction:'',providerMessage:'',providerMessageRaw:'',evidence:null};
      if(providerFailure.failed){providerFailure.submittedVerified=Boolean(videoTaskCard);providerFailure.promptDelivered=Boolean(userNode);providerFailure.notSentVerified=!userNode&&!submittedAtMs;if(!userNode&&!promptPresentInCurrentConversation)providerFailure.evidence={...(providerFailure.evidence||{}),source:"doubao-current-conversation-tail",confidence:0.78};}
      const fingerprintNodes=signalNodes.length?signalNodes:recentSignalNodes;
      const fingerprintSource=[conversationId,userNode?.getAttribute?.('data-message-id')||'',...fingerprintNodes.map(node=>node.getAttribute?.('data-message-id')||ownText(node).slice(0,160)),providerFailure.code||''].join('|');
      let hash=5381;for(let index=0;index<fingerprintSource.length;index++)hash=((hash<<5)+hash)^fingerprintSource.charCodeAt(index);const evidenceFingerprint=fingerprintSource?conversationId+':'+(hash>>>0).toString(16):'';
      const latestSignalAt=fingerprintNodes.map(messageTime).filter(Boolean).sort((a,b)=>b-a)[0]||0;
      return {verification:conversationMatches&&/(安全验证|人工验证|拖动滑块|请完成验证|身份验证|captcha)/i.test([scopedAlerts,verificationOverlays].join(' ')),conversationId,expectedConversationId,conversationMatches,bindingMode,promptPresentInCurrentConversation,inputText,userMessage:Boolean(userNode||promptPresentInCurrentConversation||pageTaskCard),userMessageId:userNode?.getAttribute('data-message-id')||'',videoTaskCard,pageTaskCard,planningConfirmation,paidQuotaConfirmation,paidQuotaPrompt,codeOnlyVideoResponse,latestAssistantText:latestAssistantText.slice(-1200),scopedGenerating,explicitFallback,providerSignal:providerSignal.slice(-1200),providerSignalAt:latestSignalAt?new Date(latestSignalAt).toISOString():(providerSignal?new Date().toISOString():''),evidenceFingerprint,signalCount:fingerprintNodes.length,...providerFailure,quotaMessage:providerFailure.quotaExhausted?(providerFailure.providerMessageRaw||providerFailure.providerMessage):''};
    })()`);
    // Embedded WebContents can briefly return undefined while the SPA swaps
    // its message tree after a send. Treat that sample as an empty probe and
    // keep polling instead of crashing the submission pipeline.
    state = state && typeof state === "object" ? state : {conversationId:"", conversationMatches:false, userMessage:false, providerSignal:"", evidenceFingerprint:""};
    // A matching chat message is durable context, not proof of video creation.
    if (state.conversationMatches && state.userMessageId && state.conversationId) {
      session.conversationId = state.conversationId;
      const key = `${session.currentJobId}:${state.conversationId}:${state.userMessageId}`;
      if (session.contextProgressKey !== key && this.onProgress) {
        await this.onProgress({jobId:session.currentJobId,accountId:session.account?.id,
          state:session.phase === "generating" ? "generating" : "submitting",conversationId:state.conversationId,
          submittedEvidence:{conversationId:state.conversationId,userMessageId:state.userMessageId,
            submittedAt:submittedAt ? new Date(submittedAt).toISOString() : new Date().toISOString(),evidenceType:"chat-message-delivered",promptDelivered:true,confirmed:false}});
        session.contextProgressKey = key;
      }
    }
    if (state.providerTerminal || state.planningConfirmation || state.paidQuotaConfirmation || isPaidQuotaConfirmation(state.latestAssistantText)) state.scopedGenerating = false;
    state.isNewSignal=Boolean(state.evidenceFingerprint&&state.evidenceFingerprint!==session.lastEvidenceFingerprint);
    if(state.evidenceFingerprint)session.lastEvidenceFingerprint=state.evidenceFingerprint;
    return state;
  }
  async validateSubmissionContext(command) {
    const session=await this.open(command.account),sourcePrompt=String(command.payload?.prompt||"").trim();
    if(!sourcePrompt)throw new Error("人工核对缺少任务提示词");
    const expectedConversationId=String(command.payload?.conversationId||"").trim();
    let state;
    if(session.testMode){const currentConversationId=String(command.payload?.simulateConversationId||expectedConversationId||"mock-context");const promptMatched=command.payload?.simulatePromptMatched!==false;state={conversationId:currentConversationId,conversationMatches:!expectedConversationId||currentConversationId===expectedConversationId,promptPresentInCurrentConversation:promptMatched,userMessage:promptMatched,userMessageId:promptMatched?"mock-user-message":"",bindingMode:promptMatched?"prompt-token":""};}
    else{
      await this.connect(session);const login=await this.detect(command.account);
      if(!login.loggedIn)return {ok:false,matched:false,code:"DOUBAO_LOGIN_REQUIRED",category:"authentication",message:"当前豆包账号尚未登录，请先登录并打开正确会话",monitorProbe:{conversationId:"",requestedConversationId:expectedConversationId,promptMatched:false,conversationMatched:false}};
      state=await this.readSubmissionState(session,sourcePrompt,command.payload?.userMessageId||"",expectedConversationId,command.payload?.submittedAt||"");
    }
    const validation=validateSubmissionContextState(state,expectedConversationId),monitorProbe={conversationId:validation.conversationId,requestedConversationId:validation.expectedConversationId,promptMatched:validation.promptMatched,conversationMatched:validation.conversationMatched,bindingMode:validation.bindingMode,userMessageId:validation.userMessageId};
    if(!validation.matched){session.phase="submission_unknown";return {ok:false,matched:false,code:"DOUBAO_SUBMISSION_CONTEXT_MISMATCH",category:"monitor_binding",conversationId:validation.conversationId,userMessageId:validation.userMessageId,monitorProbe,message:validation.conversationMatched?"当前豆包会话没有匹配到该任务提示词，请先打开包含该提示词的正确会话":"当前豆包会话与任务记录不一致，请先打开该任务对应的正确会话"};}
    session.conversationId=validation.conversationId;session.phase="submission_unknown";
    return {ok:true,matched:true,conversationId:validation.conversationId,userMessageId:validation.userMessageId,monitorProbe,message:"当前会话与任务提示词匹配成功"};
  }
  async runGeneration(command) {
    const session = await this.open(command.account);
    session.phase = "preparing";
    session.currentJobId = String(command.payload?.jobId || command.id || "");
    if(command.action === "generate") session.conversationId = "";
    session.allowPaidQuota = command.payload?.allowPaidQuota === true;
    const sourcePrompt = String(command.payload?.prompt || "").trim();
    const referenceAssets=normalizeReferenceAssets(command.payload||{});
    const prompt=buildReferencePrompt(sourcePrompt,referenceAssets);
    if (!sourcePrompt) throw new Error("生成任务缺少提示词");
    if (session.testMode) {
      session.phase = "idle";
      const testDelayMs = Math.max(0, Number(process.env.DOUBAO_TEST_DELAY_MS || 0));
      if (testDelayMs) await new Promise(resolve => setTimeout(resolve, testDelayMs));
      if (command.payload?.simulateQuotaExhausted) return {ok:false,quotaExhausted:true,notSentVerified:true,code:"DOUBAO_VIDEO_QUOTA_EXHAUSTED",message:"豆包明确提示视频额度没有了，本次未创建生成任务"};
      if (command.payload?.simulateProviderFailureMessage) return {ok:false,...classifyDoubaoFailureMessage(command.payload.simulateProviderFailureMessage),message:String(command.payload.simulateProviderFailureMessage)};
      if (command.action === "resume") return {ok: true, resumed: true, generating: true, verificationRequired: false, message: "人工验证已解除，继续监控原任务；未重新发送提示词"};
      if (command.payload?.simulateVerification) return {ok: true, paused: true, verificationRequired: true, submittedEvidence: {prompt,sourcePrompt,referenceManifest:buildReferenceManifest(referenceAssets), commandId: command.id}, message: "测试模式检测到人工验证，任务已暂停"};
      const conversationId = `mock-${command.payload?.jobId || command.id}`;
      session.conversationId = conversationId;
      const referenceUpload=await this.uploadReferenceImages(session,{imageAssets:referenceAssets});
      return {ok: true, generating: true, conversationId, submittedEvidence: {prompt,sourcePrompt,referenceManifest:buildReferenceManifest(referenceAssets), commandId: command.id, conversationId, referenceUpload}, message: "测试模式已提交生成任务"};
    }
    await this.connect(session);
    const login = await this.detect(command.account);
    if (login.verificationRequired) { session.phase = "verification"; return {ok:true,paused:true,verificationRequired:true,loginState:login.state,notSentVerified:command.action==="generate",message:"豆包需要人工验证，请完成后继续"}; }
    if (!login.loggedIn) { session.phase = "idle"; return {ok:true,loginRequired:true,loginState:login.state||"unknown",notSentVerified:true,code:"DOUBAO_LOGIN_REQUIRED",category:"authentication",retryMode:"reauthenticate",requiresPromptEdit:false,userAction:"请打开该豆包账号完成登录，然后点击继续。",providerMessage:login.message||"豆包账号尚未登录",quotaConsumed:false,message:login.message||"豆包账号尚未登录"}; }
    if (command.action === "monitor" || command.action === "resume_monitor") {
      const stateArgs=[sourcePrompt,command.payload?.userMessageId||"",command.payload?.conversationId||"",command.payload?.submittedAt||""];
      let monitorState = await this.readSubmissionState(session,...stateArgs);
      const currentPageBound=Boolean(monitorState?.conversationMatches&&(monitorState?.providerTerminal||monitorState?.verification||monitorState?.userMessage||monitorState?.promptPresentInCurrentConversation||monitorState?.scopedGenerating));
      if(!currentPageBound){await this.restoreConversation(session, command);monitorState=await this.readSubmissionState(session,...stateArgs);}
      const conversationId = String(monitorState?.conversationId || session.conversationId || command.payload?.conversationId || "");
      session.conversationId = conversationId;
      if (monitorState?.quotaExhausted && !monitorState?.scopedGenerating) {
        session.phase = "idle";
        return {ok:false,quotaExhausted:true,notSentVerified:true,safeToRetry:true,submissionRejected:true,code:"DOUBAO_VIDEO_QUOTA_EXHAUSTED",conversationId,message:`豆包明确提示视频额度已用完，当前账号停止执行并允许安全换号${monitorState.quotaMessage?`：${monitorState.quotaMessage}`:""}`};
      }
      if (monitorState?.providerTerminal) { session.phase="idle";return {ok:false,...monitorState,conversationId,message:monitorState.providerMessageRaw||monitorState.providerMessage||monitorState.userAction||"豆包明确结束本次生成"}; }
      if (monitorState?.verification) { session.phase = "verification"; return {ok: true, paused: true, verificationRequired: true, conversationId, message: "豆包出现人工验证，请在本机窗口完成后继续"}; }
      if ((monitorState?.planningConfirmation || monitorState?.paidQuotaConfirmation) && !monitorState?.videoTaskCard && !monitorState?.scopedGenerating) {
        if (monitorState.paidQuotaConfirmation && command.payload?.allowPaidQuota !== true) throw Object.assign(new Error("原会话要求使用付费额度，任务未允许付费；未发送确认"), {code: "DOUBAO_VIDEO_QUOTA_EXHAUSTED", quotaExhausted: true, conversationId, notSentVerified: false, safeToRetry: false});
        const turn = await this.readConversationTurn(session, "不需要，直接帮我生成视频。");
        if (command.payload?.confirmPending === true && !turn?.delivered && !turn?.responding && (turn?.queued || monitorState.planningConfirmation) && monitorState.conversationMatches) {
          const confirmationPrompt = monitorState.paidQuotaConfirmation ? "确认生成" : "不需要，直接帮我生成视频。";
          const beforeConfirmation = await this.readConversationTurn(session, confirmationPrompt);
          const confirmationFilled = await this.fillComposer(session, confirmationPrompt);
          if (!confirmationFilled) {
            throw Object.assign(new Error("豆包确认输入框未就绪，未重复上传素材"), {
              code: "DOUBAO_CONFIRMATION_INPUT_NOT_READY", category: "submission", submissionUnknown: true,
              safeToRetry: false, notSentVerified: false, conversationId,
            });
          }
          session.phase = "submitting";
          session.submissionRequests = [];
          const confirmationAt = Date.now();
          session.pendingSubmission = {
            jobId: session.currentJobId, prompt: confirmationPrompt, providerPrompt: confirmationPrompt,
            kind: "generation-confirmation", startedAt: confirmationAt,
            confirmationBeforeMessageId: beforeConfirmation.userMessageId || "",
          };
          await this.onProgress?.({jobId: session.currentJobId, accountId: session.account?.id, confirmationAttempt: {at: new Date().toISOString(), source: "original-conversation-confirmation"}});
          const confirmationSent = await this.clickComposerSend(session, {requireIdleReply: true});
          if (!confirmationSent) {
            throw Object.assign(new Error("豆包确认发送控件未就绪，未重复上传素材"), {
              code: "DOUBAO_CONFIRMATION_SEND_FAILED", category: "submission", submissionUnknown: true,
              safeToRetry: false, notSentVerified: false, conversationId,
            });
          }
          const delivered = await this.waitForConfirmationDelivery(session, confirmationPrompt, conversationId);
          session.pendingSubmission = null;
          const checked=await this.readSubmissionState(session,sourcePrompt,delivered.userMessageId||"",conversationId,confirmationAt);
          const verified=classifySubmissionEvidence({after:checked});
          if(!verified.confirmed) throw Object.assign(new Error("确认消息已送达，尚未发现真实视频任务；请继续核对原会话，不要重复发送确认"),{code:"DOUBAO_CONFIRMATION_DELIVERED_WAITING",submissionUnknown:true,safeToRetry:false,notSentVerified:false,submittedVerified:false,conversationId,userMessageId:delivered.userMessageId||""});
          session.phase = "generating";
          return {
            ok: true, generating: true, resumed: true, conversationId,
            submittedEvidence: {
              prompt, sourcePrompt, conversationId,
              userMessageId: String(delivered.userMessageId || ""),
              submittedAt: new Date(confirmationAt).toISOString(),
              evidenceType: "confirmed-video-request", requestConfirmed: true,
            },
            message: "已发送原会话确认指令，继续监控原视频任务；未重新上传素材",
          };
        }
        session.phase = "submission_unknown";
        throw Object.assign(new Error(turn.queued
          ? "确认话术仍在豆包待发送区域，尚未创建视频任务；恢复监听不能代替发送确认，请检查原会话"
          : "豆包仍停在生成方案或参数确认，尚未发现视频任务；已停止空等，请检查原会话"), {
          code:turn.queued?"DOUBAO_CONFIRMATION_QUEUED":"DOUBAO_VIDEO_TASK_NOT_CREATED",category:"submission",submissionUnknown:true,safeToRetry:false,notSentVerified:false,
          conversationId,userMessageId:String(monitorState.userMessageId||""),submittedAt:command.payload?.submittedAt||"",
          monitorDiagnostic:{confirmation:{delivery:turn}},
        });
      }
      if (command.payload?.terminalProbe) {
        const recovered=Boolean(!monitorState?.codeOnlyVideoResponse&&monitorState?.conversationId&&monitorState?.userMessage&&monitorState?.promptPresentInCurrentConversation&&(monitorState?.scopedGenerating||monitorState?.videoTaskCard));
        if(recovered){
          session.phase="generating";
          return {ok:true,generating:true,resumed:true,submissionRecovered:true,conversationId:monitorState.conversationId,submittedEvidence:{prompt:buildReferencePrompt(sourcePrompt,referenceAssets),sourcePrompt,conversationId:monitorState.conversationId,userMessageId:String(monitorState.userMessageId||""),evidenceType:"terminal-audit-current-conversation",scopedGenerating:Boolean(monitorState.scopedGenerating),providerSignalExcerpt:String(monitorState.providerSignal||"").slice(-500),referenceManifest:buildReferenceManifest(referenceAssets)},message:"已在原豆包会话确认提交，继续监控；未重新发送提示词"};
        }
        session.phase="submission_unknown";return {ok:true,unchanged:true,submissionUnknown:true,conversationId,message:"未发现豆包明确终止信息，继续保持提交状态未知；不会重新提交"};
      }
      session.phase = "generating";
      return {ok: true, verificationRequired: false, generating: true, resumed: true, conversationId, monitorProbe:{conversationMatches:monitorState?.conversationMatches===true,bindingMode:String(monitorState?.bindingMode||""),promptPresentInCurrentConversation:monitorState?.promptPresentInCurrentConversation===true,signalCount:Number(monitorState?.signalCount||0),evidenceFingerprint:String(monitorState?.evidenceFingerprint||""),providerSignalExcerpt:String(monitorState?.providerSignal||"").slice(-500)}, message: "已恢复原会话，继续监控；未重新发送提示词"};
    }
    const state = await this.evaluate(session, `(() => { const text=String(document.body?.innerText||'').replace(/\\s+/g,' '); return {verification:/(安全验证|人工验证|拖动滑块|请完成验证|captcha)/i.test(text)}; })()`);
    if (state?.verification) { session.phase = "verification"; return {ok: true, paused: true, verificationRequired: true, message: "豆包出现人工验证，请在本机窗口完成后继续"}; }
    if (command.action === "resume") { session.phase = "generating"; return {ok: true, verificationRequired: false, generating: true, resumed: true, conversationId:session.conversationId||String(command.payload?.conversationId||""), message: "人工验证已解除，继续监控原任务；未重新发送提示词"}; }
    await this.checkPageBlocker(session, {dismissPromotion:true});
    await this.prepareFreshConversation(session, command.account);
    try{await this.ensureVideoMode(session);await this.setVideoParameters(session, command.payload || {});}
    catch(error){if(error?.notSentVerified!==true)Object.assign(error,{safeToRetry:true,notSentVerified:true,submittedVerified:false,code:error?.code||"DOUBAO_PARAMETER_CONFIG_FAILED",category:error?.category||"parameters",retryMode:error?.retryMode||"adjust_parameters",userAction:error?.userAction||"豆包页面参数没有配置成功，本次提示词尚未发送。请确认模型、比例和时长后安全重试。",quotaConsumed:false});throw error;}
    await this.closeVideoParameterPanel(session);
    await this.waitForComposer(session, 12000);
    const referenceUpload=await this.uploadReferenceImages(session,{imageAssets:referenceAssets});
    session.phase="preparing";
    // 上传参考图会重建编辑器并可能退出视频模式；发送前恢复模式和参数，
    // 同时确认模式切换没有清掉已经上传的附件。
    await this.reassertVideoSubmissionReady(session, command.payload || {}, referenceUpload);
    const filled = await this.fillComposer(session, prompt);
    if (!filled) throw Object.assign(new Error("豆包尚未完整接收提示词，已停止提交；请检查输入框后重试"), {code:"DOUBAO_PROMPT_NOT_READY",category:"submission",notSentVerified:true,submittedVerified:false,safeToRetry:true,quotaConsumed:false,monitorDiagnostic:{composer:session.lastComposerDiagnostic}});
    const beforeConversationId = String(await this.evaluate(session, `location.pathname.match(/\\/chat\\/(\\d{6,})/)?.[1] || ''`) || "");
    let clickedAt = Date.now();
    session.phase = "submitting";
    session.submissionRequests = [];
    session.pendingSubmission = {jobId:session.currentJobId,prompt:sourcePrompt,providerPrompt:prompt,beforeConversationId,startedAt:clickedAt};
    const sent = await this.clickComposerSend(session);
    if (!sent) { session.pendingSubmission = null; session.phase = "idle"; throw Object.assign(new Error(`提示词或发送按钮尚未就绪，已停止提交：${JSON.stringify(session.lastSendDiagnostic||{})}`), {code:"DOUBAO_COMPOSER_NOT_READY",category:"submission",notSentVerified:true,submittedVerified:false,safeToRetry:true,quotaConsumed:false}); }
    let after = {};
    let requestEvidence = null;
    let submissionEvidence = classifySubmissionEvidence({prompt:sourcePrompt,beforeConversationId,after});
    const submissionStartedAt = clickedAt;
    let trackedUserMessageId = "";
    // Do not bind the post-send probe to the pre-send URL. Doubao can create
    // a fresh conversation ID after the first message is accepted.
    let trackedConversationId = "";
    const evidenceTimeoutMs = Math.max(60000, Number(process.env.DOUBAO_SUBMISSION_EVIDENCE_TIMEOUT_MS || 90000));
    let evidenceDeadline = Date.now() + evidenceTimeoutMs;
    while (true) {
      after = await this.readSubmissionState(session, sourcePrompt, trackedUserMessageId, trackedConversationId, submissionStartedAt);
      if (after?.userMessageId) trackedUserMessageId = String(after.userMessageId);
      if (!trackedConversationId && after?.conversationId) trackedConversationId = String(after.conversationId);
      if (session.pendingSubmission) session.pendingSubmission = {...session.pendingSubmission, userMessageId: trackedUserMessageId, conversationId: trackedConversationId};
      if (after?.verification) break;
      requestEvidence = (session.submissionRequests || []).find(item => item.jobId === session.currentJobId && item.at >= clickedAt - 250 && item.videoGenerationRequest) || null;
      submissionEvidence = classifySubmissionEvidence({prompt:sourcePrompt,beforeConversationId,after,request:requestEvidence});
      if (after?.providerTerminal) break;
      if (submissionEvidence.confirmed) break;
      // A bound assistant confirmation is actionable now. Waiting for a task
      // that cannot exist until we confirm used to add the entire 90s budget.
      if (after?.conversationMatches && !after?.codeOnlyVideoResponse
        && !after?.videoTaskCard && !after?.pageTaskCard && !after?.scopedGenerating
        && (after?.planningConfirmation || after?.paidQuotaConfirmation || shouldRequestGenerationConfirmation(after?.latestAssistantText))) break;
      if (Date.now() >= evidenceDeadline) break;
      await new Promise(resolve => setTimeout(resolve, uiTiming(session, "submissionProbeMs")));
    }
    session.pendingSubmission = null;
    // 豆包部分账号/会话会先询问“需要我直接帮你生成这条视频吗？”，
    // 此时视频任务尚未真正创建，自动确认一次后再进入提交监听。
    const confirmationText = String(after?.providerSignal || "");
    let pageConfirmationText = "";
    if (!submissionEvidence.confirmed && !after?.providerTerminal && !after?.planningConfirmation && !after?.paidQuotaConfirmation) {
      try { pageConfirmationText = String(await this.evaluate(session, `String(document.body?.innerText||'')`)); } catch {}
    }
    // Some Doubao builds virtualize message nodes and leave the full assistant
    // reply only in body text. Use that page text as a confirmation fallback;
    // shouldRequestGenerationConfirmation is deliberately strict enough to
    // avoid treating ordinary prompts as confirmation requests.
    const confirmationProbeText = [after?.latestAssistantText, confirmationText, pageConfirmationText]
      .filter(Boolean).join("\n");
    const paidQuotaConfirmation = Boolean(command.payload?.allowPaidQuota === true && (after?.paidQuotaConfirmation || isPaidQuotaConfirmation(confirmationProbeText)));
    const needsGenerationConfirmation = !submissionEvidence.confirmed && !after?.providerTerminal && !after?.codeOnlyVideoResponse
      && (after?.planningConfirmation === true || paidQuotaConfirmation || shouldRequestGenerationConfirmation(confirmationProbeText));
    session.lastConfirmationDiagnostic = {detected: needsGenerationConfirmation, providerSignal: confirmationText.slice(-600), pageText: pageConfirmationText.slice(-1200)};
    if (needsGenerationConfirmation) {
      try {
        // 豆包的确认态要求短指令；长解释容易再次触发普通对话/分镜回复。
        const confirmationPrompt = paidQuotaConfirmation ? "确认生成" : "不需要，直接帮我生成视频。";
        await this.waitForAssistantReply(session);
        // Streaming can end with a real task or a refusal after the early
        // parameter summary. Recheck before sending a follow-up.
        const settled = await this.readSubmissionState(session, sourcePrompt, trackedUserMessageId, trackedConversationId, submissionStartedAt);
        if (settled?.verification) { session.phase = "verification"; return {ok:true,paused:true,verificationRequired:true,message:"豆包出现人工验证，请在本机窗口完成后继续"}; }
        if (settled?.providerTerminal) { session.phase = "idle"; return {ok:false,...settled,message:settled.providerMessageRaw||settled.providerMessage||"豆包明确结束本次生成"}; }
        const settledEvidence = classifySubmissionEvidence({prompt:sourcePrompt,beforeConversationId,after:settled});
        if (settledEvidence.confirmed) {
          after = settled;
          submissionEvidence = settledEvidence;
        } else {
          const beforeConfirmation = await this.readConversationTurn(session, confirmationPrompt);
          const confirmationFilled = await this.fillComposer(session, confirmationPrompt);
          if (!confirmationFilled) throw Object.assign(new Error("豆包生成确认输入未就绪，请检查原页面"), {code: "DOUBAO_CONFIRMATION_INPUT_NOT_READY", category: "submission", safeToRetry: false, notSentVerified: false, monitorDiagnostic:{composer:session.lastComposerDiagnostic,blocker:session.lastPageBlocker}});
          session.phase = "submitting";
          session.submissionRequests = [];
          const confirmationAt = Date.now();
          session.pendingSubmission = {jobId: session.currentJobId, prompt: confirmationPrompt, providerPrompt: confirmationPrompt, kind: "generation-confirmation", beforeConversationId, startedAt: confirmationAt, confirmationBeforeMessageId: beforeConfirmation.userMessageId || ""};
          await this.onProgress?.({jobId: session.currentJobId, accountId: session.account?.id, confirmationAttempt: {at: new Date().toISOString(), source: "automatic-confirmation"}});
          const confirmationSent = await this.clickComposerSend(session, {requireIdleReply: true});
          if (!confirmationSent) {
            throw Object.assign(new Error("豆包确认发送控件未就绪，确认话术未点击发送；请检查原会话"), {code: "DOUBAO_CONFIRMATION_SEND_FAILED", category: "submission", submissionUnknown:true, safeToRetry: false, notSentVerified: false, conversationId:trackedConversationId, monitorDiagnostic: {send: session.lastSendDiagnostic || null}});
          }
          await this.waitForConfirmationDelivery(session, confirmationPrompt, trackedConversationId);
          let confirmedAfter = {};
          let confirmedRequest = null;
          let confirmedEvidence = {confirmed: false};
          const confirmationTimeoutMs = Math.max(30000, Number(process.env.DOUBAO_CONFIRMATION_TIMEOUT_MS || 90000));
          const confirmationDeadline = Date.now() + confirmationTimeoutMs;
          while (Date.now() < confirmationDeadline) {
            confirmedAfter = await this.readSubmissionState(session, sourcePrompt, trackedUserMessageId, trackedConversationId, submissionStartedAt);
            if (confirmedAfter?.userMessageId) trackedUserMessageId = String(confirmedAfter.userMessageId);
            if (!trackedConversationId && confirmedAfter?.conversationId) trackedConversationId = String(confirmedAfter.conversationId);
            if (session.pendingSubmission) session.pendingSubmission = {...session.pendingSubmission, userMessageId: trackedUserMessageId, conversationId: trackedConversationId};
            confirmedRequest = (session.submissionRequests || []).find(item => item.jobId === session.currentJobId && item.at >= confirmationAt - 250 && item.videoGenerationRequest) || null;
            confirmedEvidence = classifySubmissionEvidence({prompt: sourcePrompt, beforeConversationId, after: confirmedAfter, request: confirmedRequest});
            // A video request observed on the explicit confirmation turn is
            // already enough to enter result monitoring; do not spend the full
            // confirmation timeout waiting for a late task card.
            if (confirmedAfter?.verification || confirmedAfter?.providerTerminal || confirmedEvidence.confirmed || confirmedRequest?.videoGenerationRequest) break;
            await new Promise(resolve => setTimeout(resolve, uiTiming(session, "submissionProbeMs")));
          }
          after = confirmedAfter;
          requestEvidence = confirmedRequest;
          submissionEvidence = confirmedEvidence;
          // A confirmation turn is the provider's explicit go-ahead.  When its
          // bound request contains the video-generation payload, it is enough to
          // enter result monitoring even if the task card appears later than the
          // confirmation timeout.  The initial planning request is still never
          // accepted as submission evidence.
          if (!submissionEvidence.confirmed && confirmedRequest?.videoGenerationRequest
            && confirmedAfter?.conversationMatches && confirmedAfter?.userMessage
            && !confirmedAfter?.providerTerminal && !confirmedAfter?.verification) {
            submissionEvidence = {
              ...submissionEvidence,
              confirmed: true,
              evidenceType: "confirmed-video-request",
              requestConfirmed: true,
              requestObserved: true,
            };
          }
          session.pendingSubmission = null;
        }
      } catch (error) {
        session.pendingSubmission = null;
        session.phase = "submission_unknown";
        // The original prompt already left the editor. Any confirmation
        // failure must preserve that conversation and prohibit resubmission.
        Object.assign(error, {submissionUnknown:true,safeToRetry:false,notSentVerified:false,
          conversationId:trackedConversationId,userMessageId:trackedUserMessageId,submittedAt:new Date(submissionStartedAt).toISOString()});
        throw error;
      }
    }
    if (after?.verification) { session.phase = "verification"; return {ok: true, paused: true, verificationRequired: true, message: "豆包出现人工验证，请在本机窗口完成后继续"}; }
    if (after?.quotaExhausted && !submissionEvidence.confirmed && !requestEvidence?.videoGenerationRequest && !after?.scopedGenerating) { session.phase="idle";return {ok:false,quotaExhausted:true,notSentVerified:true,code:"DOUBAO_VIDEO_QUOTA_EXHAUSTED",conversationId:String(after.conversationId||""),message:`豆包明确提示视频额度已用完，本次未创建生成任务${after.quotaMessage?`：${after.quotaMessage}`:""}`}; }
    if (after?.providerTerminal) { session.phase="idle";return {ok:false,...after,conversationId:String(after.conversationId||""),message:after.providerMessageRaw||after.providerMessage||after.userAction||"豆包明确结束本次生成"}; }
    if (!submissionEvidence.confirmed) {
      session.phase = "submission_unknown";
      throw Object.assign(new Error(after?.codeOnlyVideoResponse ? "豆包仅返回了生成代码和渲染说明，尚未确认创建真实视频任务" : "豆包返回了文字回复，尚未确认创建真实视频任务"), {
        code:"DOUBAO_VIDEO_TASK_NOT_CREATED",
        category:"submission",
        submissionUnknown:true,
        conversationId:String(after?.conversationId || ""),
        userMessageId:String(trackedUserMessageId || after?.userMessageId || ""),
        submittedAt:new Date(submissionStartedAt).toISOString(),
        submittedVerified:false,
        notSentVerified:false,
        safeToRetry:false,
        monitorDiagnostic: {
          after: {
            conversationId: String(after?.conversationId || ""),
            conversationMatches: Boolean(after?.conversationMatches),
            userMessage: Boolean(after?.userMessage),
            userMessageId: String(after?.userMessageId || ""),
            videoTaskCard: Boolean(after?.videoTaskCard),
            pageTaskCard: Boolean(after?.pageTaskCard),
            planningConfirmation: Boolean(after?.planningConfirmation),
            codeOnlyVideoResponse: Boolean(after?.codeOnlyVideoResponse),
            scopedGenerating: Boolean(after?.scopedGenerating),
            providerSignal: String(after?.providerSignal || "").slice(-1200),
            signalCount: Number(after?.signalCount || 0),
          },
          submissionEvidence,
          requestEvidence: requestEvidence ? {url: String(requestEvidence.url || "").split("?", 1)[0], requestId: String(requestEvidence.requestId || ""), videoGenerationRequest: Boolean(requestEvidence.videoGenerationRequest)} : null,
          confirmation: session.lastConfirmationDiagnostic || null,
          pageConfirmationText: String(pageConfirmationText || "").slice(-2000),
        },
      });
    }
    session.conversationId = String(submissionEvidence.conversationId || session.conversationId || "");
    session.phase = "generating";
    const submittedUserMessageId = trackedUserMessageId || String(after?.userMessageId || "");
    const submittedConversationId = String(session.conversationId || trackedConversationId || after?.conversationId || "");
    return {ok: true, generating: true, conversationId: submittedConversationId, submittedEvidence: {prompt,sourcePrompt,referenceManifest:buildReferenceManifest(referenceAssets), commandId: command.id, conversationId: submittedConversationId, submittedAt:new Date(submissionStartedAt).toISOString(), evidenceType:submissionEvidence.evidenceType, userMessageId:submittedUserMessageId, requestId:String(requestEvidence?.requestId||""), requestUrl:String(requestEvidence?.url||"").split("?",1)[0], scopedGenerating:Boolean(after?.scopedGenerating), retryCount:0,referenceUpload}, message: after?.scopedGenerating ? "豆包当前会话已确认正在生成" : `豆包提交已确认（${submissionEvidence.evidenceType}）`};
  }
  async execute(command) {
    if (!command || !command.account) throw new Error("服务器命令缺少账号信息");
    if (command.action === "open") {
      const manager = this.embeddedBrowserProvider?.();
      if (manager?.open) await manager.open(command.account, {focus: true});
      else await this.open(command.account);
      return {ok: true, loggedIn: false, verificationRequired: false, embedded: Boolean(manager), message: manager ? "已打开内置豆包窗口，请完成登录或验证" : "已在本机打开独立 Chrome 窗口，请完成登录或验证"};
    }
    if (command.action === "detect") {
      const result = await this.detect(command.account);
      return {ok: true, ...result, message: result.verificationRequired ? "豆包需要人工验证" : (result.loggedIn ? "豆包账号已登录" : "豆包账号尚未登录")};
    }
    if (command.action === "validate_submission_context") return this.validateSubmissionContext(command);
    if (command.action === "recover_result") {
      const session = await this.open(command.account);
      const resultUrl = String(command.payload?.resultUrl || command.payload?.resultUrls?.[0] || "").trim();
      const videoVid = normalizeVideoVid(command.payload?.videoVid);
      if (!videoVid && !/^https?:\/\//i.test(resultUrl) && !session.testMode) throw new Error("豆包结果回传缺少视频 VID 或有效的视频地址");
      session.phase = "downloading";
      const jobId = command.payload?.jobId || command.id;
      const resource = {...(command.payload?.resourceDescriptor || {}), url: resultUrl, pageUrl: command.payload?.fallbackResultVid || resultUrl, videoVid, mimeType: command.payload?.mimeType || command.payload?.resourceDescriptor?.mimeType || "video/mp4"};
      const downloaded = await this.downloadDoubaoVideoWithFallback(session, resource, {jobId, conversationId: command.payload?.conversationId || "", videoVid, fallbackResultVid: command.payload?.fallbackResultVid || resultUrl});
      session.phase = "idle";
      return {ok: true, state: "completed", jobId, ...downloaded, conversationId: String(command.payload?.conversationId || ""), conversationVid:String(command.payload?.conversationVid||command.payload?.conversationId||""), videoVid:downloaded.videoVid||videoVid||this.latestVideoVid(session,{jobId,conversationId:command.payload?.conversationId||""})};
    }
    if (command.action === "generate") {
      return this.withSubmissionLock(command.account.id, () => this.runGeneration(command));
    }
    if (command.action === "resume") {
      return this.runGeneration(command);
    }
    if (command.action === "resume_monitor") {
      return this.runGeneration(command);
    }
    if (command.action === "monitor") {
      const result = await this.runGeneration(command);
      if (result.verificationRequired || result.paused) return result;
      if (result.generating || result.resumed) {
        const session = await this.open(command.account);
        const jobId = command.payload?.jobId || command.id;
        let video;
        try {
          video = await this.waitForVideo(session, {jobId, conversationId: result.conversationId || "", timeoutMs: Number(command.payload?.monitorTimeoutMs || 10000)});
        } catch (error) {
          return {...result, state: "generating", videoPending: true, videoError: String(error.message || error), conversationVid:result.conversationVid||result.conversationId||"", videoVid:normalizeVideoVid(result.videoVid)||this.latestVideoVid(session,{jobId,conversationId:result.conversationId||""})};
        }
        try {
          const downloaded = await this.downloadDoubaoVideoWithFallback(session, video, {jobId, conversationId: video.conversationId || result.conversationId || "", videoVid: normalizeVideoVid(video.videoVid)||normalizeVideoVid(result.videoVid)||this.latestVideoVid(session,{jobId,conversationId:video.conversationId||result.conversationId||""}), fallbackResultVid: video.url});
          session.phase = "idle";
          return {...result, ...downloaded, state: "completed", jobId, conversationId: video.conversationId || result.conversationId || "", conversationVid:result.conversationVid||result.conversationId||video.conversationId||"", videoVid:downloaded.videoVid||normalizeVideoVid(video.videoVid)||normalizeVideoVid(result.videoVid)||this.latestVideoVid(session,{jobId,conversationId:video.conversationId||result.conversationId||""})};
        } catch (error) {
          session.phase = "downloading";
          const diagnostic = error.downloadDiagnostic ? `；响应类型 ${error.downloadDiagnostic.contentType || "未知"}，大小 ${error.downloadDiagnostic.bytes || 0} 字节` : "";
          return {...result, state: "downloading", resultDownloadFailed: true, videoPending: true, videoError: `${String(error.message || error)}${diagnostic}`, videoUrl: video.url, resultUrls: [video.url], fallbackResultVid:video.url, watermarkFree:false, watermarkFreeError:String(error.watermarkFreeError||""), resultUrlSource:"doubao-page-fallback", resultSourceResolvedAt:new Date().toISOString(), resourceDescriptor: video, conversationId: video.conversationId || result.conversationId || "", conversationVid:result.conversationVid||result.conversationId||video.conversationId||"", videoVid:normalizeVideoVid(video.videoVid)||normalizeVideoVid(result.videoVid)||this.latestVideoVid(session,{jobId,conversationId:video.conversationId||result.conversationId||""}), code: "DOUBAO_RESULT_DOWNLOAD_FAILED", category: "result_download", retryMode: "recover_result", accountAction: "hold", submittedVerified: true, safeToRetry: false, notSentVerified: false, terminalFailureVerified: false, userAction: "豆包结果已经生成并绑定到原任务，正在仅恢复视频下载与素材回填；不会重新提交生成。", message: `豆包结果下载或校验失败，稍后仅恢复结果回传：${String(error.message || error)}${diagnostic}`};
        }
      }
      return result;
    }
    throw new Error(`不支持的命令：${command.action}`);
  }
  closeAll() {
    for (const session of this.sessions.values()) {
      if (session.process && session.process.exitCode === null) try { session.process.kill(); } catch {}
    }
    this.sessions.clear();
    this.submissionTails.clear();
  }
  closeAccount(accountOrId, options = {}) {
    const accountId = safeAccountId(typeof accountOrId === "object" ? accountOrId?.id || accountOrId?.accountId : accountOrId);
    const session = this.sessions.get(accountId);
    if (session) {
      if (session.embedded) {
        const manager = this.embeddedBrowserProvider?.();
        if (manager) {
          const closed=manager.close({id: accountId}, {force: options.force === true,reason:options.reason||"controller"});
          if(closed?.closed===false&&closed?.ok===false) return closed;
        }
        else if (session.window && !session.window.isDestroyed?.()) session.window.destroy?.();
      } else if (session.process && session.process.exitCode === null) {
        session.process.kill();
      }
      try { session.cdp?.close(); } catch {}
      this.sessions.delete(accountId);
    } else if (options.closeEmbedded !== false) {
      this.embeddedBrowserProvider?.()?.close({id: accountId}, {force: options.force === true,reason:options.reason||"controller"});
    }
    this.submissionTails.delete(accountId);
    return {ok: true, closed: Boolean(session), accountId};
  }
}

module.exports = {BrowserController, classifySubmissionEvidence, classifyDoubaoFailureMessage, shouldRequestGenerationConfirmation, isPaidQuotaConfirmation, validateSubmissionContextState, probeDoubaoVideoResultPage, findBrowser, freePort, safeAccountId, normalizeComparableText, normalizeVideoParameters, normalizeReferenceAssets, normalizeReferenceRole, inferReferenceRole, defaultReferenceDescription, buildReferenceManifest, buildReferencePrompt, referenceUploadError, detectQuotaMessage, detectTrustedQuotaMessage, REFERENCE_ROLE_LABELS, DOUBAO_VIDEO_MODELS, DOUBAO_VIDEO_RATIOS};

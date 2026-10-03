"use strict";

const DOUBAO_AISPACE_QUERY = "aid=497858&device_platform=web&samantha_web=1&use-olympus-account=1&version_code=20800&pkg_type=release_version";
const TRUSTED_VIDEO_HOST_SUFFIXES = [
  "doubao.com",
  "douyin.com",
  "douyinvod.com",
  "bytecdn.cn",
  "bytedance.com",
  "ibytedtos.com",
  "volces.com",
];

function resolverError(code, message, extra = {}) {
  return Object.assign(new Error(String(message || "豆包无水印地址解析失败")), {
    code: String(code || "DOUBAO_AISPACE_FAILED"),
    category: "result_source",
    ...extra,
  });
}

function decodeUrlValue(value) {
  let current = String(value || "").trim().replace(/&amp;/gi, "&");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (/^https:\/\//i.test(current)) break;
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current;
}

function isTrustedDoubaoVideoUrl(value) {
  try {
    const parsed = new URL(decodeUrlValue(value));
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return TRUSTED_VIDEO_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function normalizeTrustedDoubaoVideoUrl(value) {
  const decoded = decodeUrlValue(value);
  return isTrustedDoubaoVideoUrl(decoded) ? decoded : "";
}

async function resolveDoubaoWatermarkFreeInPage(options = {}) {
  const videoVid = String(options.videoVid || "").trim();
  const expectedConversationId = String(options.conversationId || "").trim();
  const pageSize = Math.max(1, Math.min(100, Number(options.pageSize) || 50));
  const maxPages = Math.max(1, Math.min(50, Number(options.maxPages) || 20));
  const timeoutMs = Math.max(1000, Math.min(60000, Number(options.timeoutMs) || 15000));
  const apiBaseQuery = String(options.apiBaseQuery || DOUBAO_AISPACE_QUERY);
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const clean = value => String(value == null ? "" : value).trim();
  const dataOf = payload => payload?.data && typeof payload.data === "object" ? payload.data : {};
  const childrenOf = payload => {
    const data = dataOf(payload);
    for (const value of [data.children, data.nodes, data.list, data.items]) {
      if (Array.isArray(value)) return value;
    }
    return [];
  };
  const findNamedNode = (items, name, depth = 0) => {
    if (!Array.isArray(items) || depth > 5) return null;
    for (const item of items) {
      if (clean(item?.name) === name) return item;
      const nested = findNamedNode(item?.children, name, depth + 1);
      if (nested) return nested;
    }
    return null;
  };
  const nodeVid = node => clean(node?.key || node?.vid || node?.video_id || node?.videoId || node?.content?.vid || node?.content?.video_id || node?.content?.video_id_str);
  const nodeConversation = node => clean(node?.conversation_id || node?.conversationId || node?.content?.conversation_id || node?.content?.conversation_id_str);
  const nodeMessage = node => clean(node?.message_id || node?.messageId || node?.content?.message_id || node?.content?.message_id_str);
  const failure = (code, message, extra = {}) => ({ok: false, code, message, ...extra});
  const post = async (endpoint, body) => {
    let last = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${endpoint}?${apiBaseQuery}`, {
          method: "POST",
          credentials: "include",
          headers: {"content-type": "application/json"},
          body: JSON.stringify(body || {}),
          signal: controller.signal,
        });
        const text = await response.text();
        let payload = {};
        try { payload = text ? JSON.parse(text) : {}; }
        catch { return failure("DOUBAO_AISPACE_INVALID_JSON", "豆包 AI 创作空间返回了无效数据", {status: response.status}); }
        if (response.status === 401 || response.status === 403) return failure("DOUBAO_AISPACE_AUTH_REQUIRED", "豆包登录状态无权访问 AI 创作空间", {status: response.status});
        if ((response.status === 429 || response.status >= 500) && attempt < 3) {
          last = {status: response.status, payload};
          await sleep(250 * attempt);
          continue;
        }
        if (!response.ok) return failure(response.status === 429 ? "DOUBAO_AISPACE_RATE_LIMITED" : "DOUBAO_AISPACE_HTTP_ERROR", `豆包 AI 创作空间请求失败（HTTP ${response.status}）`, {status: response.status});
        if (payload?.code !== undefined && Number(payload.code) !== 0) return failure("DOUBAO_AISPACE_BUSINESS_ERROR", `豆包 AI 创作空间返回业务错误（${clean(payload.code)}）`, {status: response.status, businessCode: payload.code});
        return {ok: true, status: response.status, payload};
      } catch (error) {
        last = error;
        if (attempt < 3 && error?.name !== "AbortError") {
          await sleep(250 * attempt);
          continue;
        }
        return failure(error?.name === "AbortError" ? "DOUBAO_AISPACE_TIMEOUT" : "DOUBAO_AISPACE_NETWORK_ERROR", error?.name === "AbortError" ? "豆包 AI 创作空间请求超时" : "豆包 AI 创作空间网络请求失败");
      } finally {
        clearTimeout(timer);
      }
    }
    return failure("DOUBAO_AISPACE_NETWORK_ERROR", "豆包 AI 创作空间网络请求失败", {lastStatus: last?.status || 0});
  };

  if (!/(^|\.)doubao\.com$/i.test(String(globalThis.location?.hostname || ""))) return failure("DOUBAO_AISPACE_WRONG_PAGE", "当前账号窗口不是豆包页面");
  if (!videoVid) return failure("DOUBAO_AISPACE_VIDEO_VID_MISSING", "缺少豆包视频 VID，无法解析无水印地址");

  const homepage = await post("/samantha/aispace/homepage", {});
  if (!homepage.ok) return homepage;
  const creation = findNamedNode(childrenOf(homepage.payload), "我的创作");
  const creationId = clean(creation?.id || creation?.node_id || creation?.nodeId);
  if (!creationId) return failure("DOUBAO_AISPACE_CREATION_FOLDER_MISSING", "豆包 AI 创作空间没有找到“我的创作”目录");

  let cursor = "";
  const seenCursors = new Set();
  let conversationMismatch = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const body = {
      node_id: creationId,
      need_full_path: true,
      size: pageSize,
      sort_param: {need_sort_config: true, sort_order: 1, sort_type: 0},
    };
    if (cursor) body.cursor = cursor;
    const nodes = await post("/samantha/aispace/node_info", body);
    if (!nodes.ok) return nodes;
    const list = childrenOf(nodes.payload);
    for (const node of list) {
      if (nodeVid(node) !== videoVid) continue;
      const actualConversationId = nodeConversation(node);
      if (expectedConversationId && actualConversationId !== expectedConversationId) {
        conversationMismatch = actualConversationId;
        continue;
      }
      const nodeId = clean(node?.id || node?.node_id || node?.nodeId);
      if (!nodeId) return failure("DOUBAO_AISPACE_NODE_ID_MISSING", "已匹配豆包视频 VID，但创作节点缺少 ID");
      const download = await post("/samantha/aispace/get_download_info", {requests: [{node_id: nodeId}]});
      if (!download.ok) return download;
      const downloadData = dataOf(download.payload);
      const info = (Array.isArray(downloadData.download_infos) ? downloadData.download_infos : Array.isArray(downloadData.downloadInfos) ? downloadData.downloadInfos : [])[0] || {};
      return {
        ok: true,
        source: "doubao-aispace-watermark-free",
        node: {
          id: nodeId,
          key: nodeVid(node),
          conversationId: actualConversationId,
          messageId: nodeMessage(node),
          name: clean(node?.name),
          nodeType: Number(node?.node_type || node?.nodeType || 0),
          size: Number(node?.size || 0),
        },
        mainUrl: clean(info.main_url || info.mainUrl),
        backupUrl: clean(info.backup_url || info.backupUrl),
        page,
      };
    }
    const data = dataOf(nodes.payload);
    const nextCursor = clean(data.next_cursor ?? data.nextCursor ?? data.cursor);
    const explicitHasMore = data.has_more ?? data.hasMore;
    const hasMore = explicitHasMore === true || explicitHasMore === 1 || explicitHasMore === "1" || Boolean(nextCursor && nextCursor !== cursor);
    if (!hasMore || !nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  if (conversationMismatch) return failure("DOUBAO_AISPACE_CONVERSATION_MISMATCH", "创作空间中的视频 VID 与任务会话不一致", {actualConversationId: conversationMismatch});
  return failure("DOUBAO_AISPACE_VIDEO_NOT_FOUND", "豆包 AI 创作空间没有找到当前任务的视频 VID");
}

async function resolveDoubaoWatermarkFreeVideo({evaluate, videoVid, conversationId = "", pageSize = 50, maxPages = 20, timeoutMs = 15000} = {}) {
  if (typeof evaluate !== "function") throw resolverError("DOUBAO_AISPACE_EVALUATOR_MISSING", "豆包页面执行器不可用");
  const normalizedVid = String(videoVid || "").trim();
  if (!/^[a-z0-9_-]{8,240}$/i.test(normalizedVid)) throw resolverError("DOUBAO_AISPACE_VIDEO_VID_MISSING", "缺少有效的豆包视频 VID");
  const options = {videoVid: normalizedVid, conversationId: String(conversationId || "").trim(), pageSize, maxPages, timeoutMs, apiBaseQuery: DOUBAO_AISPACE_QUERY};
  let result;
  try {
    result = await evaluate(`(${resolveDoubaoWatermarkFreeInPage.toString()})(${JSON.stringify(options)})`);
  } catch (error) {
    throw resolverError("DOUBAO_AISPACE_PAGE_EXECUTION_FAILED", "豆包页面执行无水印解析失败", {cause: error});
  }
  if (!result?.ok) throw resolverError(result?.code, result?.message, {status: Number(result?.status || 0), retryable: ![401, 403].includes(Number(result?.status || 0)), details: result});
  const mainUrl = normalizeTrustedDoubaoVideoUrl(result.mainUrl);
  const backupUrl = normalizeTrustedDoubaoVideoUrl(result.backupUrl);
  if (!mainUrl && !backupUrl) throw resolverError("DOUBAO_AISPACE_UNTRUSTED_URL", "豆包 AI 创作空间没有返回可信的 HTTPS 视频地址", {details: {node: result.node, page: result.page}});
  return {
    source: "doubao-aispace-watermark-free",
    mainUrl,
    backupUrl,
    node: result.node || null,
    page: Number(result.page || 0),
    resolvedAt: new Date().toISOString(),
  };
}

function summarizeWatermarkFreeError(error) {
  const code = String(error?.code || "DOUBAO_AISPACE_FAILED");
  const message = String(error?.message || error || "豆包无水印地址解析失败").replace(/https?:\/\/\S+/gi, "[已隐藏签名地址]").slice(0, 500);
  return `${code}: ${message}`;
}

module.exports = {
  DOUBAO_AISPACE_QUERY,
  TRUSTED_VIDEO_HOST_SUFFIXES,
  resolverError,
  decodeUrlValue,
  isTrustedDoubaoVideoUrl,
  normalizeTrustedDoubaoVideoUrl,
  resolveDoubaoWatermarkFreeInPage,
  resolveDoubaoWatermarkFreeVideo,
  summarizeWatermarkFreeError,
};

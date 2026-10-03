"use strict";

// Executed in the page. Never searches a different conversation or sends input.
function probeExistingVideos({conversationId, originalUserMessageId = "", prompt = "", allowContinuation = false, selectedId = "", activate = false} = {}) {
  const current = location.pathname.match(/\/chat\/(\d{6,})(?:\/|$)/)?.[1] || "";
  if (!conversationId || current !== String(conversationId)) return {conversationMatches: false, conversationId: current, candidates: []};
  const httpUrl = value => {try {const u = new URL(String(value || "")); return ["https:", "http:"].includes(u.protocol) ? u.href : "";} catch {return "";}};
  const compact = value => String(value || "").replace(/\s+/g, "").toLowerCase();
  const textOf = node => String(node?.innerText || node?.textContent || "").trim();
  const isUser = node => /user/i.test(node.getAttribute("data-role") || node.getAttribute("data-author") || "") || /(^|\s)justify-end(\s|$)/.test(String(node.className)) || !!node.querySelector('[class*="send-msg-bubble"],[class*="user-message"]');
  const messages = [...document.querySelectorAll('[data-message-id]')].filter(node => !node.parentElement?.closest('[data-message-id]'));
  const token = compact(prompt).slice(0, 48);
  const originalIndex = messages.findIndex(node => node.getAttribute("data-message-id") === originalUserMessageId || (token && isUser(node) && compact(textOf(node)).includes(token)));
  const hash = value => {let h = 2166136261; for (const char of value) h = Math.imul(h ^ char.charCodeAt(0), 16777619); return (h >>> 0).toString(16);};
  const selector = 'video,[class*="block-video"],[class*="video-player"],[class*="play-icon-wrapper"]';
  const candidates = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (isUser(message) || (originalIndex >= 0 && index <= originalIndex)) continue;
    const messageId = message.getAttribute("data-message-id");
    const cards = [...message.querySelectorAll(selector)].filter(node => !node.parentElement?.closest(selector) || !message.contains(node.parentElement.closest(selector)));
    for (let cardIndex = 0; cardIndex < cards.length; cardIndex++) {
      const card = cards[cardIndex], descriptors = [], seen = new WeakSet();
      let budget = 2500;
      const scan = (value, depth = 0) => {
        if (!value || depth > 9 || --budget < 0) return;
        if (typeof value === "string") {if (value.length < 200000 && /"(?:vid|video_id|videoId)"\s*:/.test(value)) try {scan(JSON.parse(value), depth + 1);} catch {} return;}
        if (typeof value !== "object" || seen.has(value)) return;
        seen.add(value);
        const vid = String(value.vid || value.video_id || value.videoId || "");
        if (/^[a-z0-9_-]{8,240}$/i.test(vid)) descriptors.push({videoVid: vid, url: httpUrl(value.download_url || value.downloadUrl || value.url)});
        for (const [key, child] of Object.entries(value)) if (!["ref", "_owner", "stateNode", "return", "alternate", "child", "sibling"].includes(key) && !key.startsWith("__react")) scan(child, depth + 1);
      };
      // Stop at the message boundary: a parent list's props contain other tasks.
      for (const node of [card, ...(cards.length === 1 ? [message] : [])]) for (const key of Object.keys(node)) {
        if (key.startsWith("__reactProps$")) scan(node[key]);
        if (key.startsWith("__reactFiber$")) {
          let fiber = node[key];
          for (let n = 0; fiber && n < 12; n++, fiber = fiber.return) {
            if (fiber.stateNode instanceof Element && fiber.stateNode !== message && !message.contains(fiber.stateNode)) break;
            scan(fiber.memoizedProps); scan(fiber.pendingProps);
            if (fiber.stateNode === message) break;
          }
        }
      }
      const vids = [...new Set(descriptors.map(d => d.videoVid))];
      const video = card.matches("video") ? card : card.querySelector("video");
      const url = httpUrl(video?.currentSrc || video?.src || video?.querySelector("source")?.src) || (vids.length === 1 ? descriptors.find(d => d.url)?.url || "" : "");
      const videoVid = vids.length === 1 ? vids[0] : "";
      const label = textOf(message).slice(0, 500);
      const ready = !!(url || videoVid || /你的视频生成好了|视频(?:已)?生成(?:完成|成功)|生成结果/.test(label));
      const intervening = messages.slice(originalIndex + 1, index).filter(isUser);
      const anchored = originalIndex >= 0 && (allowContinuation || intervening.every(node => /^(不需要，直接帮我生成视频。|确认生成|直接生成)[。！!\s]*$/.test(textOf(node))));
      const id = `${messageId}:${cardIndex}`;
      const content = message.cloneNode(true);
      for (const node of content.querySelectorAll(selector)) node.remove();
      const contentFingerprint = hash(JSON.stringify([messageId,cardIndex,compact(content.textContent)]));
      const resourceKey = videoVid || (url ? new URL(url).origin + new URL(url).pathname : "");
      const fingerprint = hash(JSON.stringify([contentFingerprint, resourceKey]));
      const item = {id, fingerprint, contentFingerprint, messageId, cardIndex, videoVid, url, ready, anchored, text: label, poster: httpUrl(video?.poster || card.querySelector("img")?.src), ambiguous: vids.length > 1};
      if (selectedId === id && activate && !url && !item.ambiguous) {
        // Only open the identified video card, never a page-wide button.
        card.click(); item.activated = true;
      }
      candidates.push(item);
    }
  }
  return {conversationMatches: true, conversationId: current, originalMatched: originalIndex >= 0, candidates};
}

module.exports = {probeExistingVideos};

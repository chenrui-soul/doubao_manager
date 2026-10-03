"use strict";

const VIDEO_RESOURCE_ENDPOINT = /\/creativity\/resource\/get_without_watermark(?:[/?#]|$)/i;
const VIDEO_ID_KEYS = new Set(["vid", "video_id", "videoid"]);

function normalizeVideoVid(value) {
  const text = String(value || "").trim();
  if (!text || /^https?:\/\//i.test(text) || /\s/.test(text)) return "";
  return /^[a-z0-9_-]{8,240}$/i.test(text) ? text : "";
}

function collectVideoVids(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) collectVideoVids(item, output);
    return output;
  }
  for (const [key, item] of Object.entries(value)) {
    if (VIDEO_ID_KEYS.has(String(key).toLowerCase())) {
      const values = Array.isArray(item) ? item : [item];
      for (const candidate of values) {
        const vid = normalizeVideoVid(candidate);
        if (vid && !output.includes(vid)) output.push(vid);
      }
    }
    if (item && typeof item === "object") collectVideoVids(item, output);
  }
  return output;
}

function parseStructuredText(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  try {
    const params = new URLSearchParams(text);
    const object = {};
    for (const [key, item] of params.entries()) {
      if (Object.hasOwn(object, key)) object[key] = Array.isArray(object[key]) ? [...object[key], item] : [object[key], item];
      else object[key] = item;
    }
    return object;
  } catch { return null; }
}

function extractVideoVids({url = "", postData = "", responseBody = "", value = null} = {}) {
  const output = [];
  for (const source of [value, parseStructuredText(postData), parseStructuredText(responseBody)]) collectVideoVids(source, output);
  try {
    const parsed = new URL(String(url || ""));
    for (const [key, item] of parsed.searchParams.entries()) {
      if (!VIDEO_ID_KEYS.has(String(key).toLowerCase())) continue;
      const vid = normalizeVideoVid(item);
      if (vid && !output.includes(vid)) output.push(vid);
    }
  } catch {}
  return output;
}

function extractVideoVid(input = {}) { return extractVideoVids(input)[0] || ""; }

function isVideoResourceRequest(url) { return VIDEO_RESOURCE_ENDPOINT.test(String(url || "")); }

module.exports = {VIDEO_RESOURCE_ENDPOINT, normalizeVideoVid, extractVideoVids, extractVideoVid, isVideoResourceRequest};

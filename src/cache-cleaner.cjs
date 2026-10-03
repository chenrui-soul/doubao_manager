"use strict";

const fs = require("fs");
const path = require("path");

function unlinkIfExists(file) {
  try { if (file && fs.existsSync(file) && fs.statSync(file).isFile()) fs.unlinkSync(file); } catch {}
}

function walkFiles(root) {
  const output = [];
  if (!root || !fs.existsSync(root)) return output;
  const visit = current => {
    let entries = [];
    try { entries = fs.readdirSync(current, {withFileTypes: true}); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else output.push(full);
    }
  };
  visit(root);
  return output;
}

function cleanupJobTemp(tempRoot, jobOrId) {
  const id = typeof jobOrId === "object" ? jobOrId?.id : jobOrId;
  const token = String(id || "").trim();
  if (!tempRoot || !token) return 0;
  let removed = 0;
  for (const file of walkFiles(tempRoot)) {
    const name = path.basename(file);
    if (!(name.startsWith(`${token}_`) || name.startsWith(`${token}.mp4`))) continue;
    try { fs.unlinkSync(file); removed += 1; } catch {}
  }
  return removed;
}

const BROWSER_CACHE_DIRS = new Set(["Cache", "Code Cache", "GPUCache", "DawnCache", "ShaderCache", "GrShaderCache", "Network Cache", "CacheStorage"]);

function cleanupBrowserCaches(root) {
  let removed = 0;
  if (!root || !fs.existsSync(root)) return removed;
  for (const file of walkFiles(root)) {
    const relative = path.relative(root, file);
    const parts = relative.split(path.sep);
    if (!parts.some(part => BROWSER_CACHE_DIRS.has(part))) continue;
    try { fs.unlinkSync(file); removed += 1; } catch {}
  }
  return removed;
}

function cleanupOwnedAssets(job) {
  let removed = 0;
  for (const asset of job?.payload?.imageAssets || []) {
    if (asset?.ownedByService !== true || !asset.path) continue;
    try { if (fs.existsSync(asset.path)) { fs.unlinkSync(asset.path); removed += 1; } } catch {}
  }
  return removed;
}

function cleanupOrphanTemp(tempRoot, {maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now()} = {}) {
  let removed = 0;
  for (const file of walkFiles(tempRoot)) {
    try {
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs < maxAgeMs) continue;
      fs.unlinkSync(file);
      removed += 1;
    } catch {}
  }
  return removed;
}

function truncateLog(file, {maxBytes = 2 * 1024 * 1024, keepBytes = 512 * 1024} = {}) {
  try {
    const stat = fs.statSync(file);
    if (stat.size <= maxBytes) return false;
    const fd = fs.openSync(file, "r");
    const start = Math.max(0, stat.size - keepBytes);
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    fs.writeFileSync(file, Buffer.concat([Buffer.from("[日志已自动截断，保留最近记录]\n", "utf8"), buffer]));
    return true;
  } catch { return false; }
}

function scrubJobAssets(job) {
  if (!job || !Array.isArray(job.payload?.imageAssets)) return job;
  const imageAssets = job.payload.imageAssets.map(asset => {
    const {path: _path, ownedByService: _ownedByService, ...metadata} = asset || {};
    return metadata;
  });
  return {...job, payload: {...job.payload, imageAssets}};
}

module.exports = {unlinkIfExists, cleanupJobTemp, cleanupOwnedAssets, cleanupOrphanTemp, cleanupBrowserCaches, truncateLog, scrubJobAssets};

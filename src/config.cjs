"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const sourceDefault = path.resolve(ROOT, "..", "03 灵帧AI桌面客户端源码-V0.12.2", "lingzhen_ai_desktop_v1");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function loadAccounts() {
  const value = readJson(process.env.DOUBAO_ACCOUNTS_FILE || path.join(ROOT, "config", "accounts.json"), {accounts: []});
  const accounts = Array.isArray(value.accounts) ? value.accounts : [];
  return accounts.map(item => ({
    id: String(item?.id || "").trim(),
    name: String(item?.name || item?.id || "").trim(),
    platform: "豆包",
  })).filter(item => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(item.id));
}

module.exports = {
  ROOT,
  DATA_ROOT: path.resolve(process.env.DOUBAO_DATA_ROOT || path.join(ROOT, "data")),
  PROFILE_ROOT: path.resolve(process.env.DOUBAO_PROFILE_ROOT || path.join(process.env.DOUBAO_DATA_ROOT || path.join(ROOT, "data"), "profiles")),
  TEMP_ROOT: path.resolve(process.env.DOUBAO_TEMP_ROOT || path.join(process.env.DOUBAO_DATA_ROOT || path.join(ROOT, "data"), "temp")),
  ACCOUNTS_FILE: path.resolve(process.env.DOUBAO_ACCOUNTS_FILE || path.join(ROOT, "config", "accounts.json")),
  SOURCE_ROOT: path.resolve(process.env.LINGZHEN_SOURCE_ROOT || sourceDefault),
  PORT: Number(process.env.DOUBAO_SERVICE_PORT || 8787),
  HOST: process.env.DOUBAO_SERVICE_HOST || "127.0.0.1",
  loadAccounts,
  readJson,
};

"use strict";
const fs = require("node:fs");
const path = require("node:path");
const {performance} = require("node:perf_hooks");
const {getDeviceCode, protect} = require("./license-device.cjs");
const VERIFY_URL = "https://nexusapi.center/api/v1/device-activation/verify";
const CHECK_INTERVAL_MS = 30000;
const deny = (code, message) => ({valid: false, code, message});
// Temporary project-level switch. Set verificationEnabled to true to restore licensing.
function isLicenseVerificationEnabled() {
  if (process.env.DOUBAO_LICENSE_VERIFICATION === "1") return true;
  if (process.env.DOUBAO_LICENSE_VERIFICATION === "0") return false;
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "license-policy.json"), "utf8")).verificationEnabled !== false;
  } catch { return true; }
}
const verificationDisabled = () => ({valid: true, verificationDisabled: true, expiresAt: null, message: "授权验证已暂时停用"});

// HTTP 200 alone does not authorize use. An undocumented response fails closed.
function parseVerification(body, httpOk, deviceCode, now) {
  if (!httpOk || body?.success !== true || body?.data?.valid !== true || body?.data?.status !== "active") {
    return deny("DOUBAO_LICENSE_REJECTED", "密钥中心拒绝授权，请检查密钥有效期、停用状态和设备绑定");
  }
  const data = body.data;
  if (!data || typeof data !== "object") return deny("DOUBAO_LICENSE_RESPONSE_INVALID", "密钥中心响应缺少授权信息，请联系管理员核对接口格式");
  const binding = data.device_code ?? data.deviceCode;
  if (binding && binding !== deviceCode) return deny("DOUBAO_LICENSE_DEVICE_MISMATCH", "密钥绑定的设备与本机不一致");
  const expires = data.expires_at ?? data.expiresAt;
  // The key center omits expiry for long-term keys. Require explicit approval,
  // so an incomplete success envelope cannot grant unlimited authorization.
  if (expires == null && data.valid === true && data.status === "active") {
    return {valid: true, permanent: true, expiresAt: null, message: "已激活（长期有效）"};
  }
  const expiresMs = typeof expires === "string" && /(?:Z|[+-]\d{2}:\d{2})$/i.test(expires) ? Date.parse(expires) : NaN;
  if (!Number.isFinite(expiresMs)) return deny("DOUBAO_LICENSE_RESPONSE_INVALID", "密钥中心响应缺少含时区的到期时间，请联系管理员核对接口格式");
  if (now >= expiresMs) return deny("DOUBAO_LICENSE_EXPIRED", "授权已到期，请续期或更换密钥");
  return {valid: true, expiresAt: new Date(expiresMs).toISOString(), message: "已激活"};
}
class OnlineLicense {
  constructor({file, device = getDeviceCode, vault = protect, fetcher = fetch, wall = Date.now, monotonic = () => performance.now()} = {}) {
    this.file = file;
    this.device = device;
    this.vault = vault;
    this.fetcher = fetcher;
    this.wall = wall;
    this.monotonic = monotonic;
    this.state = deny("DOUBAO_LICENSE_REQUIRED", "请输入设备密钥激活豆包工具");
    this.checkedAt = -Infinity;
    this.expiresTick = -Infinity;
    this.pending = null;
  }
  status() {
    if (this.state.valid && !this.state.permanent && (this.wall() >= Date.parse(this.state.expiresAt) || this.monotonic() >= this.expiresTick)) {
      this.state = deny("DOUBAO_LICENSE_EXPIRED", "授权已到期，请续期或更换密钥");
    }
    let deviceCode = "";
    try { deviceCode = this.deviceCode ||= this.device(); }
    catch { return deny("DOUBAO_LICENSE_DEVICE_ERROR", "无法读取本机设备码，请检查 Windows 系统权限"); }
    return {...this.state, deviceCode, verificationUrl: VERIFY_URL};
  }
  async query(secret) {
    const deviceCode = this.status().deviceCode;
    if (!deviceCode) return this.status();
    try {
      const response = await this.fetcher(VERIFY_URL, {method: "POST", redirect: "error", headers: {"content-type": "application/json"}, body: JSON.stringify({secret, device_code: deviceCode}), signal: AbortSignal.timeout(10000)});
      const body = await response.json();
      return parseVerification(body, response.ok, deviceCode, this.wall());
    } catch {
      return deny("DOUBAO_LICENSE_UNAVAILABLE", "无法连接密钥中心，暂不能使用；请检查网络后重新验证");
    }
  }
  update(state) {
    this.checkedAt = this.monotonic();
    this.expiresTick = state.valid ? (state.permanent ? Infinity : this.checkedAt + Math.max(0, Date.parse(state.expiresAt) - this.wall())) : -Infinity;
    this.state = state;
    return this.status();
  }
  async check({force = false} = {}) {
    if (this.pending) { await this.pending; return this.status(); }
    if (!force && this.monotonic() - this.checkedAt < CHECK_INTERVAL_MS) return this.status();
    this.pending = (async () => {
      try {
        let saved;
        try { saved = JSON.parse(fs.readFileSync(this.file, "utf8")); }
        catch (error) { if (error.code === "ENOENT") return this.update(deny("DOUBAO_LICENSE_REQUIRED", "请输入设备密钥激活豆包工具")); throw error; }
        if (saved.deviceCode !== this.status().deviceCode || typeof saved.encryptedSecret !== "string") throw new Error("invalid vault");
        const secret = await this.vault(saved.encryptedSecret, true);
        return this.update(await this.query(secret));
      } catch { return this.update(deny("DOUBAO_LICENSE_STORAGE_ERROR", "本机授权记录无法读取，请重新输入密钥激活")); }
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }
  async activate(secret) {
    if (typeof secret !== "string" || !secret.trim() || secret.length > 4096) return deny("DOUBAO_LICENSE_INPUT", "请输入有效的设备密钥");
    if (this.pending) return deny("DOUBAO_LICENSE_BUSY", "正在验证授权，请稍后重试");
    this.pending = (async () => {
      const checked = await this.query(secret.trim());
      // Never replace a saved key with an invalid candidate.
      if (!checked.valid) return {...checked, deviceCode: this.status().deviceCode};
      try {
        const saved = {version: 1, deviceCode: this.status().deviceCode, encryptedSecret: await this.vault(secret.trim())};
        fs.mkdirSync(path.dirname(this.file), {recursive: true});
        fs.writeFileSync(this.file + ".tmp", JSON.stringify(saved) + "\n", {encoding: "utf8", mode: 0o600});
        fs.renameSync(this.file + ".tmp", this.file);
        return this.update(checked);
      } catch { return deny("DOUBAO_LICENSE_STORAGE_ERROR", "授权通过但本机保存失败，请检查数据目录权限后重试"); }
    })();
    try { return await this.pending; } finally { this.pending = null; }
  }
}
async function getStoredLicenseSecret(file = path.join(require("./config.cjs").DATA_ROOT, "online-license.json")) {
  if (!isLicenseVerificationEnabled()) return "";
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof saved?.encryptedSecret !== "string" || !saved.encryptedSecret) return "";
    return await protect(saved.encryptedSecret, true);
  } catch {
    return "";
  }
}
let instance;
function manager() {
  return instance ||= new OnlineLicense({file: path.join(require("./config.cjs").DATA_ROOT, "online-license.json")});
}
const checkLicense = async options => isLicenseVerificationEnabled() ? manager().check(options) : verificationDisabled();
const activateLicense = async secret => isLicenseVerificationEnabled() ? manager().activate(secret) : verificationDisabled();
async function requireLicense(options) {
  const state = await checkLicense(options);
  if (!state.valid) throw Object.assign(new Error(state.message), {code: state.code, statusCode: 403});
  return state;
}
module.exports = {OnlineLicense, parseVerification, VERIFY_URL, checkLicense, requireLicense, getStoredLicenseSecret, activateLicense, isLicenseVerificationEnabled};

"use strict";

const fs = require("fs");
const path = require("path");
const {normalizeMembership} = require("./vendor/doubao-membership.cjs");

class AccountStore {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), {recursive: true});
  }
  read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(value.accounts) ? value.accounts : [];
    } catch {
      return [];
    }
  }
  write(accounts) {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({accounts}, null, 2)}\n`, "utf8");
    fs.renameSync(temp, this.file);
    return accounts;
  }
  normalize(item) {
    const quotaDisabledUntil = Number(item?.quotaDisabledUntil || 0);
    return {
      id: String(item?.id || "").trim(),
      name: String(item?.name || item?.id || "").trim(),
      platform: "豆包",
      loginState: ["logged_in", "not_logged_in", "verification"].includes(item?.loginState) ? item.loginState : "unknown",
      ...normalizeMembership(item),
      generationHealth: item?.generationHealth && typeof item.generationHealth === "object" ? item.generationHealth : {blocked:false,kind:"",count:0},
      quotaDisabledUntil: Number.isFinite(quotaDisabledUntil) && quotaDisabledUntil > 0 ? quotaDisabledUntil : null,
      quotaRequiresRecheck: item?.quotaRequiresRecheck === true,
      quotaWindowDays: [7, 30].includes(item?.quotaWindowDays) ? item.quotaWindowDays : null,
      quotaProviderMessage: String(item?.quotaProviderMessage || "").slice(0, 500),
      quotaDetectedAt: Number(item?.quotaDetectedAt || 0),
      quotaClearedAt: Number(item?.quotaClearedAt || 0),
      dailyQuotaLimit: Number.isInteger(item?.dailyQuotaLimit) && item.dailyQuotaLimit >= 0 ? item.dailyQuotaLimit : 10,
      miniCost: Number.isInteger(item?.miniCost) && item.miniCost > 0 ? item.miniCost : 2,
      fastCost: Number.isInteger(item?.fastCost) && item.fastCost > 0 ? item.fastCost : 3,
      quotaAdjustment: Number.isFinite(item?.quotaAdjustment) ? item.quotaAdjustment : 0,
      quotaAdjustmentDay: String(item?.quotaAdjustmentDay || ""),
    };
  }
  list() { return this.read().map(item => this.normalize(item)).filter(item => item.id); }
  add({name = ""} = {}) {
    const accounts = this.list();
    const base = String(name || "豆包账号").trim().slice(0, 80) || "豆包账号";
    let index = accounts.length + 1;
    let id = `account-${String(index).padStart(3, "0")}`;
    while (accounts.some(item => item.id === id)) id = `account-${String(++index).padStart(3, "0")}`;
    const account = {id, name: base, platform: "豆包", loginState: "not_logged_in", quotaDisabledUntil: null};
    this.write([...accounts, account]);
    return account;
  }
  remove(id) {
    const key = String(id || "").trim();
    const accounts = this.list();
    const next = accounts.filter(item => item.id !== key);
    if (next.length === accounts.length) return false;
    this.write(next);
    return true;
  }
  rename(id, name) {
    const key = String(id || "").trim();
    const value = String(name || "").trim().slice(0, 80);
    if (!value) throw new Error("账号名称不能为空");
    const accounts = this.list();
    const account = accounts.find(item => item.id === key);
    if (!account) return null;
    account.name = value;
    this.write(accounts);
    return account;
  }
  updateQuota(id, patch) {
    const accounts = this.list(), account = accounts.find(item => item.id === id);
    if (!account) return null;
    Object.assign(account, patch);
    this.write(accounts);
    return account;
  }
  setLoginState(id, loginState) {
    const key = String(id || "").trim();
    const accounts = this.list();
    const account = accounts.find(item => item.id === key);
    if (!account) return null;
    account.loginState = ["logged_in", "not_logged_in", "verification"].includes(loginState) ? loginState : "unknown";
    if (account.loginState !== "logged_in") Object.assign(account, normalizeMembership());
    this.write(accounts);
    return account;
  }
  setGenerationHealth(id, health) {
    const accounts=this.list(), account=accounts.find(item=>item.id===id);
    if(!account) return null;
    account.generationHealth=health;
    this.write(accounts);
    return account;
  }
  setMembership(id, detected = {}) {
    const key = String(id || "").trim();
    const accounts = this.list();
    const account = accounts.find(item => item.id === key);
    if (!account) return null;
    Object.assign(account, normalizeMembership({...detected, membershipCheckedAt: new Date().toISOString()}));
    this.write(accounts);
    return account;
  }
  setQuotaDisabledUntil(id, quotaDisabledUntil) {
    const key = String(id || "").trim();
    const accounts = this.list();
    const account = accounts.find(item => item.id === key);
    if (!account) return null;
    const value = Number(quotaDisabledUntil || 0);
    account.quotaDisabledUntil = Number.isFinite(value) && value > 0 ? value : null;
    this.write(accounts);
    return account;
  }
  setQuotaExhaustion(id, details, until = null) {
    const accounts = this.list(), account = accounts.find(item => item.id === id);
    if (!account) return null;
    // A later daily-limit message cannot clear a rolling-window hold.
    if (account.quotaRequiresRecheck && !details.quotaRequiresRecheck) return account;
    Object.assign(account, details, {quotaDisabledUntil: until});
    this.write(accounts);
    return account;
  }
  clearQuotaExhaustion(id) {
    const accounts = this.list(), account = accounts.find(item => item.id === id);
    if (!account) return null;
    Object.assign(account, {quotaRequiresRecheck: false, quotaWindowDays: null, quotaDisabledUntil: null, quotaProviderMessage: "", quotaDetectedAt: 0, quotaClearedAt: Date.now()});
    this.write(accounts);
    return account;
  }
}

module.exports = {AccountStore};

"use strict";

class AccountScheduler {
  constructor(accounts, {quotaProvider = null} = {}) {
    this.accounts = [];
    this.busy = new Set();
    this.disabledUntil = new Map();
    this.disabledReasons = new Map();
    this.quotaProvider = typeof quotaProvider === "function" ? quotaProvider : null;
    this.replaceAccounts(accounts);
  }
  quotaEstimate(account) {
    if (!this.quotaProvider) return null;
    try {
      const quota = this.quotaProvider(account);
      return quota && typeof quota === "object" ? quota : null;
    } catch {
      // A quota display failure must not make the account scheduler unusable.
      return null;
    }
  }
  estimatedExhausted(account) {
    const quota = this.quotaEstimate(account);
    return quota?.quotaSource === "local_estimate" && Number(quota.quotaRemaining) <= 0;
  }
  pruneExpired(now = Date.now()) {
    for (const [id, until] of this.disabledUntil.entries()) {
      if (Number(until || 0) > now) continue;
      if (this.accounts.some(account => account.id === id && account.quotaRequiresRecheck === true)) {
        this.disabledUntil.set(id, Infinity);
        this.disabledReasons.set(id, "quota_exhausted");
        continue;
      }
      this.disabledUntil.delete(id);
      this.disabledReasons.delete(id);
    }
  }
  replaceAccounts(accounts) {
    const next = Array.isArray(accounts) ? accounts.slice() : [];
    this.accounts = next;
    const valid = new Set(next.map(item => item.id));
    for (const id of this.busy) if (!valid.has(id)) this.busy.delete(id);
    for (const id of this.disabledUntil.keys()) if (!valid.has(id)) this.disabledUntil.delete(id);
    for (const id of this.disabledReasons.keys()) if (!valid.has(id)) this.disabledReasons.delete(id);
    const now = Date.now();
    for (const account of next) {
      const persistedQuotaUntil = Number(account?.quotaDisabledUntil || 0);
      if (account.quotaRequiresRecheck === true) {
        this.disabledUntil.set(account.id, Infinity);
        this.disabledReasons.set(account.id, "quota_exhausted");
      } else if (persistedQuotaUntil > now) {
        this.disabledUntil.set(account.id, Math.max(persistedQuotaUntil, Number(this.disabledUntil.get(account.id) || 0)));
        this.disabledReasons.set(account.id, "quota_exhausted");
      } else if (this.disabledReasons.get(account.id) === "quota_exhausted") {
        this.disabledUntil.delete(account.id);
        this.disabledReasons.delete(account.id);
      }
    }
    this.pruneExpired(now);
  }
  add(account) { if (account?.id && !this.accounts.some(item => item.id === account.id)) this.accounts.push(account); }
  remove(accountId) { this.accounts = this.accounts.filter(item => item.id !== String(accountId)); this.busy.delete(String(accountId)); this.disabledUntil.delete(String(accountId)); this.disabledReasons.delete(String(accountId)); }
  available({allowPaidQuota = false} = {}) {
    const now = Date.now();
    this.pruneExpired(now);
    // Do not dispatch work to accounts whose login state has never been
    // verified. An "unknown" profile can open a login page and then stall the
    // submission pipeline; only an explicit logged_in check is safe for video
    // generation.
    return this.accounts.filter(account => {
      if (account.loginState !== "logged_in" || this.busy.has(account.id) || account.generationHealth?.blocked) return false;
      // Local limits and model costs are estimates, not a provider balance.
      // Only a provider-confirmed cooldown blocks free generation.
      const disabledUntil = Number(this.disabledUntil.get(account.id) || 0);
      if (disabledUntil <= now) return true;
      return allowPaidQuota === true && this.disabledReasons.get(account.id) === "quota_exhausted";
    });
  }
  shuffle(values) {
    const output = values.slice();
    for (let i = output.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [output[i], output[j]] = [output[j], output[i]];
    }
    return output;
  }
  async acquire(timeoutMs = 30 * 60 * 1000, accountId = "", excludedIds = [], {monitorExisting = false, allowPaidQuota = false} = {}) {
    const deadline = Date.now() + timeoutMs;
    const excluded = new Set(Array.isArray(excludedIds) || excludedIds instanceof Set ? excludedIds : []);
    while (Date.now() < deadline) {
      const available = monitorExisting && accountId
        ? this.accounts.filter(account => account.id === accountId && account.loginState === "logged_in" && !this.busy.has(account.id) && (!this.disabledUntil.has(account.id) || this.disabledReasons.get(account.id) === "quota_exhausted" || this.disabledUntil.get(account.id) <= Date.now()))
        : this.available({allowPaidQuota});
      const candidates = this.shuffle(available.filter(account => !excluded.has(account.id) && (!accountId || account.id === accountId)));
      if (candidates[0]) {
        this.busy.add(candidates[0].id);
        return candidates[0];
      }
      if (!monitorExisting && !allowPaidQuota) {
        const eligible = this.accounts.filter(account => account.loginState === "logged_in" && !excluded.has(account.id) && (!accountId || account.id === accountId));
        if(eligible.length && eligible.every(account=>account.generationHealth?.blocked)) throw Object.assign(new Error("所选账号的生成流程需要检查，已暂停分配新任务"),{code:"DOUBAO_ACCOUNTS_NEED_CHECK",safeToRetry:false,notSentVerified:true});
        const hasBusyEligible = eligible.some(account => this.busy.has(account.id));
        if (eligible.length > 0 && !hasBusyEligible && eligible.every(account => this.disabledReasons.get(account.id) === "quota_exhausted" && Number(this.disabledUntil.get(account.id) || 0) > Date.now())) {
          throw Object.assign(new Error("豆包已明确提示所选可用账号的视频额度耗尽，请等待额度恢复或使用其他账号"), {
            code: "DOUBAO_ACCOUNTS_QUOTA_EXHAUSTED",
            category: "quota",
            notSentVerified: true,
            submittedVerified: false,
            quotaConsumed: false,
            safeToRetry: true,
          });
        }
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw Object.assign(new Error("当前所有豆包账号都在执行任务或暂不可用"), {code: "DOUBAO_ACCOUNTS_BUSY"});
  }
  release(account) { if (account?.id) this.busy.delete(account.id); }
  disable(account, ms = 5 * 60 * 1000, reason = "temporary") { if (account?.id) { this.disabledUntil.set(account.id, Date.now() + Math.max(0, Number(ms) || 0)); this.disabledReasons.set(account.id, String(reason || "temporary")); } }
  enable(accountId, {force = false} = {}) {
    const id = String(accountId || "");
    if (!id) return false;
    if (!force && this.disabledReasons.get(id) === "quota_exhausted" && Number(this.disabledUntil.get(id) || 0) > Date.now()) return false;
    this.disabledUntil.delete(id);
    this.disabledReasons.delete(id);
    return true;
  }
  status(accountId = "") {
    this.pruneExpired();
    return this.accounts.filter(account => !accountId || account.id === accountId).map(account => {
      const estimatedExhausted = this.estimatedExhausted(account);
      return {
      id: account.id,
      generationHealth: account.generationHealth || {blocked:false},
      name: account.name,
      busy: this.busy.has(account.id),
      disabledUntil: Number.isFinite(this.disabledUntil.get(account.id)) ? this.disabledUntil.get(account.id) : null,
      quotaRequiresRecheck: account.quotaRequiresRecheck === true,
      disabledReason: this.disabledReasons.get(account.id) || null,
      quotaEstimatedExhausted: estimatedExhausted,
      dispatchBlockedReason: account.generationHealth?.blocked ? "generation_check_required" : this.disabledReasons.get(account.id) || null,
      };
    });
  }
}

module.exports = {AccountScheduler};

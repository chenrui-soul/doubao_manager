"use strict";

// A local estimate from persisted submission evidence, never an official balance.
function beijingDay(value = Date.now()) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time + 8 * 3600000).toISOString().slice(0, 10) : "";
}
function accountQuota(account, jobs, now = Date.now()) {
  const day = beijingDay(now), counted = new Set();
  let recorded = 0, reserved = 0, completedCount = 0, lastUsedAt = null;
  const miniCost = account.miniCost ?? 2, fastCost = account.fastCost ?? 3;
  for (const job of jobs) {
    const cost = /fast/i.test(job.payload?.model || "") ? fastCost : miniCost;
    const add = (accountId, at, key, uncertain = true) => {
      if (accountId !== account.id) return;
      if (at && (!lastUsedAt || at > lastUsedAt)) lastUsedAt = at;
      if (beijingDay(at) !== day || counted.has(key)) return;
      counted.add(key); recorded += cost;
      if(uncertain) reserved += cost;
    };
    // Unknown submissions reserve the estimated cost until the user reconciles it.
    const evidence = job.payload?.submittedEvidence || job.result?.submittedEvidence;
    if(job.account_id===account.id&&job.state==="completed"&&beijingDay(job.updated_at||job.created_at)===day) completedCount++;
    const charged = ["completed", "generating", "downloading", "submission_unknown"].includes(job.state)
      || evidence || job.error?.submittedVerified === true;
    if (charged && job.error?.quotaConsumed !== false && job.error?.notSentVerified !== true) {
      add(job.account_id, job.payload?.submittedAt || evidence?.submittedAt || job.updated_at || job.created_at, `${job.id}:${job.account_id}`, job.state!=="completed");
    }
    for (const attempt of job.payload?.attemptHistory || []) {
      if (attempt.submittedVerified && !attempt.notSentVerified && attempt.quotaConsumed !== false) {
        add(attempt.accountId, attempt.submittedAt || attempt.at, `${job.id}:${attempt.accountId}`);
      }
    }
  }
  const limit = account.dailyQuotaLimit ?? 10;
  const adjustment = account.quotaAdjustmentDay === day ? (account.quotaAdjustment || 0) : 0;
  const used = Math.max(0, recorded + adjustment);
  const exhausted = account.quotaRequiresRecheck === true || Number(account.quotaDisabledUntil || 0) > now;
  const remaining = exhausted ? 0 : Math.max(0, limit - used);
  return {dailyQuotaLimit: limit, quotaUsedToday: used, quotaRemaining: remaining,
    quotaReservedToday: reserved, quotaCompletedEstimateToday: recorded-reserved, completedToday:completedCount,
    quotaRecordedToday: recorded, quotaDay: day, miniCost, fastCost,
    miniRuns: Math.floor(remaining / miniCost), fastRuns: Math.floor(remaining / fastCost),
    quotaSource: "local_estimate", quotaExhausted: exhausted,
    quotaWindowDays: exhausted ? account.quotaWindowDays || null : null,
    quotaRequiresRecheck: account.quotaRequiresRecheck === true,
    quotaProviderMessage: exhausted ? account.quotaProviderMessage || "" : "",
    quotaDetectedAt: account.quotaDetectedAt || null,
    // A free-quota warning does not establish the remaining paid balance.
    actualQuotaRemaining: null,
    actualFreeQuotaRemaining: exhausted ? 0 : null,
    quotaStatus: exhausted ? "provider_exhausted" : "unknown", lastUsedAt};
}
module.exports = {accountQuota, beijingDay};

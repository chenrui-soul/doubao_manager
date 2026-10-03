"use strict";

// Call only after a trusted provider quota failure, never on arbitrary prompts.
function quotaFailureDetails(failure = {}, now = Date.now()) {
  const text = [failure.providerMessageRaw, failure.providerMessage, failure.message, failure.quotaMessage].filter(Boolean).join(" ");
  const matches = [...text.matchAll(/(?:最近|近|过去)\s*(30|7|三十|七)\s*天\s*(?:的\s*)?(?:免费\s*)?额度\s*(?:已\s*)?(?:用完|耗尽)/g)];
  const days = matches.map(match => ({"7": 7, "30": 30, "七": 7, "三十": 30})[match[1]]);
  const windowDays = days.length ? Math.max(...days) : null;
  const daily = /(?:今日|今天|当日|每日).{0,25}(?:额度|次数).{0,12}(?:用完|耗尽)/.test(text);
  return {quotaWindowDays: windowDays, quotaRequiresRecheck: Boolean(windowDays) || !daily,
    quotaProviderMessage: String(failure.providerMessageRaw || failure.providerMessage || failure.message || "豆包确认额度耗尽").slice(0, 1000), quotaDetectedAt: Number(now)};
}

module.exports = {quotaFailureDetails};

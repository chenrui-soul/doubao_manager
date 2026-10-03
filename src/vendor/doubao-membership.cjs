"use strict";

// Official taxonomy: https://www.doubao.com/legal/ey01, section 4.1.
// These are plan labels, never balances, payment receipts or renewal status.
const MEMBERSHIP_VERSION = 2;
const PLAN_LABELS = Object.freeze({
  standard_member: "标准套餐",
  enhanced_member: "加强套餐",
  premium_member: "高级套餐",
  no_member: "普通账号",
});
const LABEL_STATES = Object.freeze({
  标准套餐: "standard_member", 加强套餐: "enhanced_member", 高级套餐: "premium_member",
  普通账号: "no_member", 普通用户: "no_member", 非会员: "no_member", 免费版: "no_member",
});

function classifyMembership(probe = {}, authenticated = false) {
  const unknown = {membershipState: "unknown", membershipLabel: "", membershipSource: "", membershipVersion: MEMBERSHIP_VERSION};
  if (!authenticated || probe.probeError) return unknown;
  // Only a badge inside the current account control counts. Page-wide
  // marketing cards, chat text, nicknames and old loose candidates do not.
  const evidence = (Array.isArray(probe.membershipEvidence) ? probe.membershipEvidence : [])
    .filter(item => item?.source === "account-control" && Object.hasOwn(LABEL_STATES, item.text));
  const states = [...new Set(evidence.map(item => LABEL_STATES[item.text]))];
  if (states.length !== 1) return unknown;
  return {...unknown, membershipState: states[0], membershipLabel: PLAN_LABELS[states[0]], membershipSource: "account-control"};
}

function normalizeMembership(value = {}) {
  const known = value.membershipVersion === MEMBERSHIP_VERSION && Object.hasOwn(PLAN_LABELS, value.membershipState) && value.membershipSource === "account-control";
  return {
    membershipState: known ? value.membershipState : "unknown",
    membershipLabel: known ? PLAN_LABELS[value.membershipState] : "",
    membershipSource: known ? value.membershipSource : "",
    membershipCheckedAt: value.membershipVersion === MEMBERSHIP_VERSION ? String(value.membershipCheckedAt || "") : "",
    membershipVersion: MEMBERSHIP_VERSION,
  };
}

module.exports = {MEMBERSHIP_VERSION, PLAN_LABELS, classifyMembership, normalizeMembership};

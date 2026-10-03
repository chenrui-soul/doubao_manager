"use strict";

const {classifyMembership} = require("./doubao-membership.cjs");

const LOGIN_STATES = new Set(["logged_in", "logged_out", "verification_required", "loading", "unknown", "unchecked"]);
const AUTH_COOKIE_PATTERN = /^(sessionid|sessionid_ss|sid_tt|sid_guard|uid_tt|uid_tt_ss|passport_auth_status|passport_auth_status_ss)$/i;

const DOUBAO_LOGIN_PROBE_EXPRESSION = `(() => {
  const visible = el => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 2 && rect.height > 2 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  };
  const label = el => String(el?.innerText || el?.getAttribute?.('aria-label') || el?.getAttribute?.('title') || '').replace(/\\s+/g, '').trim();
  const text = String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
  const verificationRequired = /(安全验证|人工验证|拖动滑块|请完成验证|验证码校验|captcha)/i.test(text);
  const loginEntry = [...document.querySelectorAll('button,a,[role="button"]')].some(el => visible(el) && /^(登录|注册|立即登录|扫码登录|手机号登录|验证码登录)$/.test(label(el)));
  const avatar = [...document.querySelectorAll('img,[class*="avatar"],[data-testid*="avatar"]')].find(el => {
    if (!visible(el)) return false;
    const src = String(el.currentSrc || el.src || '');
    const identity = String(el.getAttribute?.('data-testid') || el.className || '');
    return src.includes('passport.byteacctimg.com/img/user-avatar') || src.includes('user-avatar/assets') || /(?:^|[-_])avatar(?:$|[-_])/i.test(identity);
  });
  const accountControl = [...document.querySelectorAll('button,a,[role="button"]')].find(el => visible(el) && /(个人中心|账号设置|退出登录)/.test(label(el)));
  const accountHost = avatar?.closest?.('button,[role="button"],header') || accountControl;
  const platformAccountName = String(accountHost?.innerText || accountHost?.getAttribute?.('aria-label') || avatar?.getAttribute?.('alt') || avatar?.getAttribute?.('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  // Restrict membership evidence to the avatar's compact account control.
  // A header, pricing panel or conversation can contain unrelated plan names.
  const membershipEvidence = [];
  if (accountHost && accountHost.tagName !== 'HEADER' && visible(accountHost) &&
      String(accountHost.innerText || '').length <= 160 &&
      !/(升级|开通|购买|领取|已到期|已过期|已失效|套餐对比)/.test(String(accountHost.innerText || ''))) {
    const nodes = [...accountHost.querySelectorAll('*')];
    const avatarName = String(avatar?.getAttribute?.('alt') || avatar?.getAttribute?.('title') || '').trim();
    for (const el of nodes) {
      if (!visible(el) || el.children.length || el.tagName === 'IMG') continue;
      const value = String(el.innerText || el.textContent || '').trim();
      if (!/^(标准套餐|加强套餐|高级套餐|普通账号|普通用户|非会员|免费版)$/.test(value) || value === avatarName) continue;
      // A name nested in an upgrade/expired offer is not a current badge.
      let parent = el.parentElement, offer = false;
      while (parent && parent !== accountHost) {
        if (/(升级|开通|购买|领取|到期|过期|失效|套餐对比)/.test(String(parent.innerText || ''))) { offer = true; break; }
        parent = parent.parentElement;
      }
      if (!offer) membershipEvidence.push({text: value, source: 'account-control'});
    }
  }
  return {
    onPlatform: /(^|\\.)doubao\\.com$|(^|\\.)dola\\.com$/i.test(location.hostname),
    loginEntry,
    avatarFound: Boolean(avatar),
    accountControlFound: Boolean(accountControl),
    verificationRequired,
    platformAccountName,
    membershipEvidence,
    url: location.href,
    readyState: document.readyState,
    bodyTextLength: text.length
  };
})()`;

function hasAuthenticatedCookie(cookies = []) {
  return (Array.isArray(cookies) ? cookies : []).some(cookie => AUTH_COOKIE_PATTERN.test(String(cookie?.name || "")) && String(cookie?.value || ""));
}

function hasDecisivePageLoginSignal(probe = {}) {
  return probe.verificationRequired === true || probe.loginEntry === true || probe.avatarFound === true || probe.accountControlFound === true || Boolean(String(probe.platformAccountName || "").trim());
}

function classifyDoubaoLoginState(probe = {}, cookies = []) {
  const explicitState = LOGIN_STATES.has(String(probe.state || "")) ? String(probe.state) : "";
  const probeFailed = Boolean(String(probe.probeError || "").trim());
  const sessionAuthenticated = probe.sessionAuthenticated === true || hasAuthenticatedCookie(cookies);
  const pageAuthenticated = probe.avatarFound === true || probe.accountControlFound === true || Boolean(String(probe.platformAccountName || "").trim());
  const onPlatform = probe.onPlatform === true || /https:\/\/(?:www\.)?(?:doubao\.com|dola\.com)(?:\/|$)/i.test(String(probe.url || ""));
  const pageReady = probe.readyState === "complete" && Number(probe.bodyTextLength || 0) > 20;
  let state = explicitState;
  if (!state) {
    if (probe.verificationRequired === true) state = "verification_required";
    else if (onPlatform && probe.loginEntry === true) state = "logged_out";
    else if (onPlatform && pageAuthenticated) state = "logged_in";
    else if (probeFailed || !onPlatform || !pageReady) state = "loading";
    else if (onPlatform && sessionAuthenticated) state = "logged_in";
    else state = "unknown";
  }
  if (probe.verificationRequired === true) state = "verification_required";
  else if (onPlatform && probe.loginEntry === true) state = "logged_out";
  else if (probeFailed && !pageAuthenticated) state = "loading";
  const membership = classifyMembership(probe, state === "logged_in");
  const messages = {
    logged_in: "豆包账号已登录",
    logged_out: "豆包账号尚未登录",
    verification_required: "豆包需要人工验证",
    loading: "豆包页面正在加载",
    unknown: "暂时无法确认豆包登录状态",
    unchecked: "尚未检测豆包登录状态",
  };
  return {
    ...probe,
    state,
    loginState: state,
    loggedIn: state === "logged_in",
    verificationRequired: state === "verification_required",
    probeFailed,
    sessionAuthenticated,
    pageAuthenticated,
    ...membership,
    onPlatform,
    message: probe.message || messages[state] || messages.unknown,
  };
}

module.exports = {AUTH_COOKIE_PATTERN, DOUBAO_LOGIN_PROBE_EXPRESSION, hasAuthenticatedCookie, hasDecisivePageLoginSignal, classifyDoubaoLoginState};

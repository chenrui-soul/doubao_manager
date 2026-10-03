"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {DOUBAO_LOGIN_PROBE_EXPRESSION, classifyDoubaoLoginState} = require("../src/vendor/doubao-login-state.cjs");
const {normalizeMembership} = require("../src/vendor/doubao-membership.cjs");
const {AccountStore} = require("../src/account-store.cjs");
const base = {onPlatform: true, avatarFound: true, readyState: "complete", bodyTextLength: 100};
function probePage(labels, {nickname = "示例账号", header = false, hidden = false, prefix = "", outside = ""} = {}) {
  const rect = () => ({width: 200, height: 40});
  const host = {tagName: header ? "HEADER" : "BUTTON", innerText: [nickname, prefix, ...labels].join(" "), getBoundingClientRect: rect};
  const leaves = labels.map(text => ({tagName: "SPAN", innerText: text, children: [], parentElement: host, getBoundingClientRect: hidden ? () => ({width: 0, height: 0}) : rect}));
  host.querySelectorAll = () => leaves;
  const avatar = {src: "https://passport.byteacctimg.com/img/user-avatar/example", getBoundingClientRect: rect, getAttribute: name => name === "alt" ? nickname : "", closest: () => host};
  return vm.runInNewContext(DOUBAO_LOGIN_PROBE_EXPRESSION, {
    document: {body: {innerText: host.innerText + outside}, readyState: "complete", querySelectorAll: selector => selector.startsWith("img,") ? [avatar] : []},
    location: {hostname: "www.doubao.com", href: "https://www.doubao.com/chat/"},
    getComputedStyle: () => ({display: "block", visibility: "visible", opacity: "1"})
  });
}
for (const [label, state] of [["标准套餐", "standard_member"], ["加强套餐", "enhanced_member"], ["高级套餐", "premium_member"], ["普通账号", "no_member"], ["免费版", "no_member"]]) {
  const detected = classifyDoubaoLoginState(probePage([label]));
  assert.equal(detected.membershipState, state, label);
  assert.equal(detected.membershipSource, "account-control");
}
for (const text of ["标准会员", "普通会员", "超级会员", "SVIP", "开通标准套餐", "升级标准会员", "开通会员", "会员中心", "会员权益", "标准套餐已到期", "领取30天标准套餐"]) {
  assert.equal(classifyDoubaoLoginState(probePage([text])).membershipState, "unknown", text);
}
for (const options of [{nickname: "标准套餐"}, {header: true}, {hidden: true}, {prefix: "升级"}, {prefix: "已到期"}]) {
  assert.equal(classifyDoubaoLoginState(probePage(["标准套餐"], options)).membershipState, "unknown");
}
assert.equal(classifyDoubaoLoginState(probePage([], {outside: "标准套餐 加强套餐 高级套餐"})).membershipState, "unknown");
assert.equal(classifyDoubaoLoginState(probePage(["标准套餐", "高级套餐"])).membershipState, "unknown");
for (const overrides of [{loginEntry: true}, {verificationRequired: true}, {probeError: "timeout"}]) {
  assert.equal(classifyDoubaoLoginState({...probePage(["标准套餐"]), ...overrides}).membershipState, "unknown");
}
assert.equal(classifyDoubaoLoginState({...base, membershipCandidates: ["标准套餐"], platformAccountName: "小陈 标准套餐"}).membershipState, "unknown");
assert.equal(normalizeMembership({membershipState: "premium_member", membershipLabel: "SVIP"}).membershipState, "unknown");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "doubao-membership-test-"));
try {
  const store = new AccountStore(path.join(directory, "accounts.json"));
  const account = store.add();
  store.setMembership(account.id, classifyDoubaoLoginState(probePage(["加强套餐"])));
  let saved = store.list()[0];
  assert.equal(saved.membershipState, "enhanced_member");
  assert.equal(saved.membershipLabel, "加强套餐");
  assert.ok(saved.membershipCheckedAt);
  store.rename(account.id, "测试重命名");
  assert.equal(store.list()[0].membershipState, "enhanced_member");
  store.setMembership(account.id, classifyDoubaoLoginState(probePage([])));
  assert.equal(store.list()[0].membershipState, "unknown");
  store.setMembership(account.id, classifyDoubaoLoginState(probePage(["标准套餐"])));
  store.setLoginState(account.id, "not_logged_in");
  assert.equal(store.list()[0].membershipState, "unknown");
} finally { fs.rmSync(directory, {recursive: true, force: true}); }
console.log("membership taxonomy, scoped probe, ambiguity and persistence tests ok");

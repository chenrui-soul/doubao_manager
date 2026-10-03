"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const {shouldBlockRequest, rehearseAccount} = require("../src/browser-rehearsal.cjs");
const {BrowserController} = require("../src/vendor/browser-controller.cjs");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../references/browser-rehearsal.json"), "utf8"));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rehearsal-test-"));
function fakeController(fail) {
  let guard, destroyed = false, released = false, filled = false;
  const account = {id: "test-account"};
  const session = {embedded: true, window: {isVisible: () => false}, webContents: {id: 51, isDestroyed: () => destroyed, getOSProcessId: () => 1, capturePage: async () => ({toPNG: () => Buffer.from("fixture")}), session: {webRequest: {onBeforeRequest(fn) { if (!fn) assert.ok(destroyed, "destroy before unblocking requests"); guard = fn; }}}}};
  const request = (method, url, id = 51) => { let response; guard({method, url, webContentsId: id}, r => { response = r; }); return response.cancel; };
  const controller = {
    embeddedBrowserProvider: () => ({retainAutomation: () => () => { released = true; }, closeAutomationSession: () => { destroyed = true; }}),
    open: async () => session, detect: async () => ({loggedIn: true}), prepareFreshConversation: async () => {}, ensureVideoMode: async () => {},
    setVideoParameters: async () => { if (fail) throw new Error("component failed"); return fixture.payload; }, closeVideoParameterPanel: async () => {}, waitForComposer: async () => {},
    fillComposer: async () => {
      assert.equal(session.rehearsal, true);
      assert.equal(request("POST", "https://www.doubao.com/unrecognized-send"), true);
      assert.equal(request("GET", "https://www.doubao.com/resource"), false);
      assert.equal(request("POST", "https://www.doubao.com/unrecognized-send", 99), false, "other pages unaffected");
      filled = true; return true;
    },
    readComposerReadiness: async () => ({ready: true, sendPoint: {x: 1, y: 1}}),
    connect: async () => ({send: async (_method, params) => assert.equal(params.key, "Backspace", "cleanup must never press Enter")}),
    navigateSession: async (_s, url) => assert.equal(url, "about:blank"),
    closeAccount: () => { destroyed = true; },
    clickComposerSend: async () => { throw new Error("must never reach send"); },
  };
  return {controller, account, verify() { assert.ok(destroyed && released); assert.equal(filled, !fail); assert.equal(guard, null); }};
}
(async () => {
  for (const r of fixture.requests) assert.equal(shouldBlockRequest(r, r.strict), r.blocked);
  await assert.rejects(() => new BrowserController({}).clickComposerSend({rehearsal: true}), e => e.code === "DOUBAO_REHEARSAL_SEND_BLOCKED");
  for (const fail of [false, true]) {
    const fake = fakeController(fail), result = await rehearseAccount(fake.controller, fake.account, fixture.payload, temp);
    assert.equal(result.ok, !fail); fake.verify();
    if (!fail) assert.equal(result.stoppedBeforeSend, true);
  }
  fs.mkdirSync(path.join(__dirname, "log"), {recursive: true});
  fs.writeFileSync(path.join(__dirname, "log/browser-rehearsal-guards.json"), JSON.stringify({passed: true, verified: ["send guard", "unknown POST blocked before input", "other pages unaffected", "failure cleanup", "hidden page", "draft cleanup without Enter"]}, null, 2));
  console.log("browser rehearsal guards passed");
})().catch(e => { console.error(e); process.exitCode = 1; });

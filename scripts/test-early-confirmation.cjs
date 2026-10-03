"use strict";
const assert = require("node:assert/strict");
const {BrowserController} = require("../src/vendor/browser-controller.cjs");
async function run({planning = true, terminal = false, createsTaskAfterReply = false, refusesAfterReply = false} = {}) {
  const c = Object.create(BrowserController.prototype), session = {};
  let sent = 0, probes = 0, replyFinished = false;
  const prompts = [];
  c.open = async () => session;
  c.connect = async () => ({});
  c.detect = async () => ({loggedIn:true});
  for (const method of ["closeVideoParameterPanel", "prepareFreshConversation", "ensureVideoMode", "setVideoParameters", "waitForComposer", "reassertVideoSubmissionReady"]) c[method] = async () => ({});
  c.uploadReferenceImages = async () => ({requestedCount:0,uploadedCount:0});
  c.evaluate = async (_s, expression) => expression.includes("location.pathname") ? "" : ({verification:false});
  c.fillComposer = async (_s, prompt) => { prompts.push(prompt); return true; };
  c.waitForAssistantReply = async () => { replyFinished = true; };
  c.readConversationTurn = async () => ({known:true});
  c.waitForConfirmationDelivery = async () => ({delivered:true});
  c.clickComposerSend = async () => {
    if (sent === 1) assert.equal(replyFinished, true, "never queue confirmation while the planning reply is streaming");
    sent++; return true;
  };
  c.readSubmissionState = async () => {
    probes++;
    if (planning && !terminal && probes > 1 && sent < 2 && !replyFinished) throw new Error("confirmation reply was ignored; still waiting for task creation");
    const base = {conversationId:"123456789",conversationMatches:true,userMessage:true,userMessageId:"original-msg"};
    if (terminal) return {...base,providerTerminal:true,providerMessage:"生成失败"};
    if (replyFinished && createsTaskAfterReply) return {...base,scopedGenerating:true};
    if (replyFinished && refusesAfterReply) return {...base,providerTerminal:true,providerMessage:"素材版权拒绝"};
    if (sent === 1 && planning) return {...base,planningConfirmation:true,latestAssistantText:"确认后我再开始生成视频。",providerSignal:"确认后我再开始生成视频。"};
    return {...base,scopedGenerating:true,latestAssistantText:"视频生成中"};
  };
  const result = await c.runGeneration({id:"test-early-confirm",account:{id:"fixture"},payload:{prompt:"fixture video"}});
  return {result,sent,probes,prompts};
}
(async () => {
  const confirmation = await run();
  assert.equal(confirmation.result.generating,true);
  assert.equal(confirmation.sent,2);
  assert.deepEqual(confirmation.prompts,["fixture video","不需要，直接帮我生成视频。"]);
  assert.equal(confirmation.probes,3,"recheck the finished reply before sending confirmation, without a fixed delay");
  assert.equal((await run({createsTaskAfterReply:true})).sent,1,"a task created at the end of streaming must not get a duplicate confirmation");
  assert.equal((await run({refusesAfterReply:true})).sent,1,"a late refusal must not receive confirmation");
  assert.equal((await run({planning:false})).sent,1,"a created task must not receive another message");
  assert.equal((await run({terminal:true})).sent,1,"provider refusal must not receive confirmation");
  console.log("Early confirmation: immediate branch, single confirmation, no duplicate for active/rejected tasks passed");
})().catch(error => { console.error(error.message); process.exitCode=1; });

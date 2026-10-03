"use strict";
// Local diagnostic launcher; no credentials or request headers are logged.
const fs = require("node:fs");
const path = require("node:path");
const out = path.resolve(__dirname, "../assets/20260924-api-test");
const {BrowserController} = require("../src/vendor/browser-controller.cjs");
const original = BrowserController.prototype.readSubmissionState;
BrowserController.prototype.readSubmissionState = async function(session, ...args) {
  const result = await original.call(this, session, ...args);
  const summary = JSON.stringify(result);
  if (session.diagnosticLast !== summary) {
    fs.appendFileSync(path.join(out, "states.jsonl"), JSON.stringify({at:new Date().toISOString(), jobId:session.currentJobId, ...result}) + "\n");
    session.diagnosticLast = summary;
  }
  return result;
};
process.env.DOUBAO_CLOSE_BROWSER_AFTER_RESULT = "0";
require("../desktop/main.cjs");
if (process.env.DOUBAO_INSPECT_FAILED_CONVERSATION === "1") setTimeout(async () => {
  try {
    const manager = globalThis.__doubaoEmbeddedBrowserManager;
    const item = await manager.automationSession({id:"account-001"});
    await item.webContents.loadURL("https://www.doubao.com/chat/38443878371403522");
    setTimeout(async () => {
      const result = await item.webContents.executeJavaScript(`({text:document.body.innerText,messages:[...document.querySelectorAll('[data-message-id]')].map(m=>({id:m.getAttribute('data-message-id'),html:m.outerHTML})),images:[...document.querySelectorAll('[data-message-id] img')].map(i=>({src:i.currentSrc,complete:i.complete,width:i.naturalWidth,html:i.outerHTML.slice(0,1000)}))})`);
      fs.writeFileSync(path.join(out,"failed-conversation.json"), JSON.stringify(result,null,2));
    }, 8000);
  } catch (error) { fs.writeFileSync(path.join(out,"diagnostic-error.txt"),error.stack); }
}, 6000);

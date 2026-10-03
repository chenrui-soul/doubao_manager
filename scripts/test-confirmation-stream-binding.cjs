"use strict";
const assert = require("node:assert/strict");
const {BrowserController} = require("../src/vendor/browser-controller.cjs");
(async () => {
  const c = Object.create(BrowserController.prototype);
  c.evaluate = async () => ({known:true,responding:false});
  for (const prompt of ['参考图顺序：\n图片 1 = P1（商品）\n图片 2 = P2（商品）','{"title": "通勤咖啡时光", "script": "穿搭展示"}']) {
    const s={currentJobId:"fixture",phase:"submitting",pendingSubmission:{jobId:"fixture",prompt},submissionRequests:[]};
    c.recordSubmissionRequest(s,{requestId:"stream",request:{url:"https://www.doubao.com/chat/completion",method:"POST",postData:JSON.stringify({messages:[{content:prompt}]})}});
    assert.equal(s.submissionRequests[0].promptMatched,true,"JSON-escaped newlines/quotes must bind to the original prompt");
    assert.equal((await c.readConversationTurn(s)).responding,true,"bound streaming blocks early confirmation");
    c.finishSubmissionRequest(s,{requestId:"stream"});
    assert.equal((await c.readConversationTurn(s)).responding,false);
    c.recordSubmissionRequest(s,{requestId:"other",request:{url:"https://www.doubao.com/chat/completion",method:"POST",postData:JSON.stringify({content:"unrelated fixture"})}});
    assert.equal(s.submissionRequests[1].promptMatched,false);
    assert.equal((await c.readConversationTurn(s)).responding,false,"unrelated requests cannot stall the task");
  }
  console.log('Confirmation stream binding passed: multiline and JSON prompts, finished streams, unrelated requests');
})().catch(error=>{console.error(error);process.exitCode=1;});

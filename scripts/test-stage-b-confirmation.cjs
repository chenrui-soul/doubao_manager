"use strict";
const assert=require("node:assert/strict"),{BrowserController}=require("../src/vendor/browser-controller.cjs");
(async()=>{
 const c=Object.create(BrowserController.prototype),session={account:{id:"original"},currentJobId:"job"};
 c.open=async()=>session;c.connect=async()=>({});c.detect=async()=>({loggedIn:true});
 const command={action:"resume_monitor",account:{id:"original"},id:"job",payload:{prompt:"leaf",conversationId:"123456789",userMessageId:"initial",confirmPending:true,allowPaidQuota:false}};
 let sends=0,writes=0,persisted=0,delivered=false,paid=false;
 c.readSubmissionState=async()=>({conversationId:"123456789",conversationMatches:true,userMessage:true,planningConfirmation:!paid&&sends===0,paidQuotaConfirmation:paid,scopedGenerating:sends>0,videoTaskCard:sends>0});
 c.readConversationTurn=async()=>({conversationId:"123456789",known:true,queued:false,delivered,userMessageId:delivered?"already-confirmed":"initial",responding:false});
 c.fillComposer=async()=>{writes++;return true;};c.clickComposerSend=async()=>{assert.equal(persisted,1,"must persist before sending");sends++;return true;};
 c.onProgress=async p=>{assert.ok(p.confirmationAttempt);persisted++;};
 c.waitForConfirmationDelivery=async()=>({delivered:true,userMessageId:"new-confirmation",conversationId:"123456789"});
 paid=true;await assert.rejects(()=>c.runGeneration(command),e=>e.quotaExhausted===true);assert.equal(writes,0);assert.equal(sends,0);
 paid=false;delivered=true;await assert.rejects(()=>c.runGeneration(command));assert.equal(sends,0);
 delivered=false;const result=await c.runGeneration(command);assert.equal(result.generating,true);assert.equal(sends,1);assert.equal(persisted,1);
 sends=0;persisted=0;c.onProgress=async()=>{throw Error("cannot persist attempt");};await assert.rejects(()=>c.runGeneration(command),/cannot persist/);assert.equal(sends,0);
 console.log("Stage B confirmation: paid refusal, already delivered refusal, idle ordinary confirmation, durable attempt before click, storage failure stops send passed");
})().catch(e=>{console.error(e);process.exitCode=1;});

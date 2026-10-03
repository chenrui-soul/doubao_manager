"use strict";
// Isolated UI fixtures: never contacts the real manager or Doubao.
const now=new Date().toISOString();
const rows=Array.from({length:35},(_,i)=>({requestId:`fixture-${i}`,accountId:"account-014",title:i===0?"镜头 01 · 林间晨光":`镜头 ${i+1} · 产品展示`,promptPreview:"柔和晨光中的绿色树叶，缓缓转动，固定镜头。",prompt:"柔和晨光中的绿色树叶，缓缓转动，固定镜头。".repeat(14),source:"创作平台",model:"Seedance 2.0 Fast",ratio:"16:9",duration:10,state:i%3===0?"submission_unknown":i%3===1?"completed":"failed",createdAt:now,updatedAt:now,conversationId:i===2?"":"123456789",actions:{canOpen:i!==2,canRecheck:i!==2,canTakeover:i!==2,canRecover:i%3===0,reason:i===2?"尚未关联豆包会话":""},error:i%3===0?{code:"DOUBAO_SUBMISSION_UNKNOWN",message:"提交结果尚未取得，请在原会话核对。".repeat(25)}:null,timings:{queuedAt:now},actionHistory:[]}));
window.fixtureCalls=[];
window.fetch=async(url,options={})=>{
 const p=new URL(url).pathname;window.fixtureCalls.push({p,method:options.method||"GET"});
 let data=p.includes("/license/")?{valid:true,verificationDisabled:true}:p==="/health"?{ok:true,queue:{active:0,waiting:0}}:p==="/api/v1/accounts"?{accounts:[{id:"account-014",name:"主账号",loginState:"logged_in",dailyQuotaLimit:10,quotaUsedToday:4,completedToday:2},{id:"account-002",name:"备用账号",loginState:"logged_in",disabledReason:"quota_exhausted",quotaWindowDays:7,quotaRequiresRecheck:true},{id:"account-009",name:"待检查账号",loginState:"logged_in",generationHealth:{blocked:true}}]}:p==="/api/v1/video/jobs"?{jobs:rows,summary:{queued:0,active:0,attention:12,todayCompleted:12,todayCalls:35}}:rows.find(x=>p.endsWith("/"+x.requestId))||{job:rows[0],result:{message:"fixture operation"}};
 return {ok:true,status:200,json:async()=>data};
};
window.doubaoDesktop={licenseStatus:async()=>({valid:true,verificationDisabled:true}),licenseSecret:async()=>({secret:""}),showLicense:async()=>({ok:true}),browserAction:async()=>({ok:true}),openData:async()=>({ok:true})};

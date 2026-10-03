"use strict";

function generationFault(error = {}) {
  const code=String(error.code||""), message=String(error.message||"");
  // Explicitly outside this repair: duration/prompt errors never poison an account.
  if(/时长|滑杆/.test(message)) return "";
  if(code==="DOUBAO_ASSET_AUTHORIZATION_REQUIRED") return "asset_authorization";
  if(["DOUBAO_CONFIRMATION_INPUT_NOT_READY","DOUBAO_COMPOSER_NOT_READY","DOUBAO_PROMPT_NOT_READY"].includes(code)) return "composer";
  if(code==="DOUBAO_PARAMETER_CONFIG_FAILED"&&/视频生成模式|视频模式/.test(message)) return "video_mode";
  return "";
}
function nextGenerationHealth(previous={}, error, jobId="") {
  if(!error) return {blocked:false,kind:"",count:0,checkedAt:new Date().toISOString()};
  const kind=generationFault(error);
  if(!kind) return previous;
  if(previous.lastJobId===jobId&&previous.kind===kind) return previous;
  const count=previous.kind===kind?Number(previous.count||0)+1:1;
  return {blocked:previous.blocked===true||kind==="asset_authorization"||count>=2,kind,count,lastJobId:jobId,code:error.code,message:String(error.message||"").slice(0,500),updatedAt:new Date().toISOString()};
}
module.exports={generationFault,nextGenerationHealth};

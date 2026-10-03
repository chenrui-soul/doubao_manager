"use strict";
const fs=require("node:fs"),path=require("node:path"),{execFileSync}=require("node:child_process");
const root=path.resolve(__dirname,"../assets/20260911-gu-yanzhen");
const out=path.resolve(__dirname,"../assets/20260924-api-test");
const base="http://127.0.0.1:8787";
const spec=JSON.parse(fs.readFileSync(path.join(root,"request.json"),"utf8"));
async function submit(label){
  const form=new FormData();
  const fields={model:spec.model,ratio:spec.ratio,duration:spec.duration,timeoutMs:spec.timeoutMs,prompt:fs.readFileSync(path.join(root,spec.promptFile),"utf8"),preferredAccountId:"account-001",accountLockRequired:true};
  for(const [key,value]of Object.entries(fields))form.append(key,String(value));
  for(const name of spec.files)form.append("files",new Blob([fs.readFileSync(path.join(root,name))],{type:"image/jpeg"}),name);
  const response=await fetch(base+"/api/v1/video/generate",{method:"POST",body:form,signal:AbortSignal.timeout(30000)});
  const job=await response.json();
  fs.writeFileSync(path.join(out,label+"-submission.json"),JSON.stringify(job,null,2));
  if(response.status!==202)throw Error(JSON.stringify(job));
  console.log(JSON.stringify({label,httpStatus:response.status,id:job.requestId}));
  let previous="";
  const deadline=Date.now()+20*60*1000;
  while(Date.now()<deadline){
    const current=await(await fetch(base+"/api/v1/video/jobs/"+job.requestId)).json();
    fs.writeFileSync(path.join(out,label+"-result.json"),JSON.stringify(current,null,2));
    if(current.state!==previous){console.log(JSON.stringify({label,at:new Date().toISOString(),state:current.state,error:current.error}));previous=current.state;}
    if(current.state==="completed"){await probe(label,current);return;}
    if(["failed","submission_unknown","awaiting_login","awaiting_verification"].includes(current.state))throw Error(JSON.stringify(current));
    await new Promise(resolve=>setTimeout(resolve,4000));
  }
  throw Error("Monitoring time limit; retain the existing task, do not resubmit");
}
async function probe(label,job){
  const url=job.watermarkFreeUrl||job.watermarkedUrl;
  const response=await fetch(url,{method:"HEAD",signal:AbortSignal.timeout(20000)});
  const info=JSON.parse(execFileSync("ffprobe",["-v","error","-show_entries","format=duration:stream=codec_type,codec_name,width,height","-of","json",url],{encoding:"utf8",windowsHide:true,timeout:60000}));
  const evidence={httpStatus:response.status,contentType:response.headers.get("content-type"),...info};
  fs.writeFileSync(path.join(out,label+"-probe.json"),JSON.stringify(evidence,null,2));
  if(!response.ok||!info.streams?.some(s=>s.codec_type==="video")||Number(info.format?.duration)<9)throw Error("Invalid returned video");
  console.log(JSON.stringify({label,verified:evidence}));
}
(async()=>{
  if(process.argv[2]==="probe-recovered")await probe("recovered",JSON.parse(fs.readFileSync(path.join(out,"recovered-result.json"),"utf8")));
  else {await submit("repeat-1");await submit("repeat-2");}
})().catch(error=>{console.error(error.message);process.exitCode=1;});

"use strict";
const fs=require("fs"),path=require("path");
(async()=>{
 const dir=path.join(__dirname,"..","assets","20260911-gu-yanzhen"), spec=JSON.parse(fs.readFileSync(path.join(dir,"request.json"),"utf8"));
 const form=new FormData(); for(const f of ["model","ratio","duration","timeoutMs"]) form.append(f,String(spec[f]));
 form.append("prompt",fs.readFileSync(path.join(dir,spec.promptFile),"utf8").trim());
 for(const file of spec.files) form.append("files",new Blob([fs.readFileSync(path.join(dir,file))],{type:"image/jpeg"}),file);
 const res=await fetch("http://127.0.0.1:8787/api/v1/video/generate",{method:"POST",body:form,signal:AbortSignal.timeout(90000)}); const body=await res.json(); console.log(JSON.stringify(body,null,2));
 if(!res.ok||!body.requestId) process.exitCode=1;
 else { const end=Date.now()+720000; while(Date.now()<end){ await new Promise(r=>setTimeout(r,10000)); const jr=await fetch(`http://127.0.0.1:8787/api/v1/video/jobs/${encodeURIComponent(body.requestId)}`); const job=await jr.json(); console.log(JSON.stringify({requestId:body.requestId,state:job.state,code:job.code,videoUrl:job.watermarkFreeUrl||job.watermarkedUrl||"",message:job.message,attempts:job.attempts},null,2)); if(["completed","failed","error"].includes(String(job.state))) break; } }
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});

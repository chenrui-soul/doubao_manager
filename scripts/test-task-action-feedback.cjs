"use strict";
// B replaces quick generation with task actions. Exercise their real UI handler.
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const nodes=new Map();function node(selector){if(!nodes.has(selector))nodes.set(selector,{hidden:false,disabled:false,dataset:{},style:{},textContent:"",value:"",innerHTML:"",setAttribute(){},addEventListener(){}});return nodes.get(selector);}
let release,requests=0;const pending=new Promise(resolve=>release=resolve);
const context=vm.createContext({URL,document:{hidden:false,querySelector:node,querySelectorAll:()=>[]},window:{doubaoDesktop:{}},setTimeout:()=>1,clearTimeout(){},fetch:async(url,options)=>{
 if(options?.method==="POST"){requests++;return pending;}return {ok:true,json:async()=>({})};
}});
for(const name of ["renderer.js","task-workspace.js"])vm.runInContext(fs.readFileSync(path.join(__dirname,"../desktop",name),"utf8"),context);
(async()=>{
 await new Promise(r=>setImmediate(r));
 vm.runInContext('refreshAccounts=async()=>{};refreshTasks=async()=>{};dashboardJobs=[{requestId:"original",state:"submission_unknown",actions:{canRecover:true}}];',context);
 const first=vm.runInContext('performTaskAction("original","recover-result")',context);
 await vm.runInContext('performTaskAction("original","recover-result")',context);
 assert.equal(requests,1,"duplicate clicks must not start a second recovery");
 assert.equal(vm.runInContext('pendingActions.has("original")',context),true);
 release({ok:false,status:409,json:async()=>({error:"账号正在人工接管"})});await first;
 assert.equal(vm.runInContext('pendingActions.has("original")',context),false);
 assert.match(node("#windowMeta").textContent,/人工接管/);
 assert.match(node("#tasks").innerHTML,/核对并补取视频/);assert.doesNotMatch(node("#tasks").innerHTML,/disabled/);
 node("#taskSearch").value="original";vm.runInContext('taskQuery="original";renderTasks()',context);assert.equal(node("#taskSearch").value,"original");
 console.log("task action feedback passed: duplicate recovery blocked, server refusal visible, retry control restored, search retained");
})().catch(e=>{console.error(e);process.exitCode=1;});

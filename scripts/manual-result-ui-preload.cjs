"use strict";
const {ipcRenderer}=require("electron");
window.fetch=async(url,options={})=>{const r=await ipcRenderer.invoke("manual-result-test-http",new URL(url).pathname,options);return {ok:r.status>=200&&r.status<300,status:r.status,json:async()=>r.data};};
window.doubaoDesktop={licenseStatus:async()=>({valid:true,verificationDisabled:true}),licenseSecret:async()=>({secret:""}),browserAction:async()=>({ok:true}),openData:async()=>({ok:true})};

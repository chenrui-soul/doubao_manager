"use strict";

// Serialized into Chromium. Inspect visible, actionable overlays, never prose
// in a chat message or the prompt editor. Do not accept a rights declaration.
function probePageBlocker() {
  const visible = el => { const r=el.getBoundingClientRect(),s=getComputedStyle(el); return r.width>2&&r.height>2&&s.display!=="none"&&s.visibility!=="hidden"; };
  const text = el => String(el.innerText||el.textContent||"").replace(/\s+/g," ").trim();
  const roots = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="modal"],[class*="Modal"],[class*="popover"],[class*="Popover"]')];
  for(const el of document.querySelectorAll('body *')) {
    if(getComputedStyle(el).position==="fixed" && text(el).length<1200) roots.push(el);
  }
  const candidates=[...new Set(roots)].filter(visible).sort((a,b)=>text(a).length-text(b).length);
  for(const el of candidates) {
    const value=text(el);
    const buttons=[...el.querySelectorAll('button,[role="button"]')].filter(visible);
    if(/安全确认/.test(value)&&/素材|授权|侵权/.test(value)&&buttons.some(b=>/^(确认|同意|确认并继续)$/.test(text(b)))) return {kind:"asset_authorization",message:"豆包等待素材授权安全确认，请在原账号页面核实并处理",excerpt:value.slice(0,400)};
    const dismiss=buttons.find(b=>/^(下次提醒我|暂不下载|暂不安装)$/.test(text(b)));
    if(/下载电脑版|AI桌面助手/.test(value)&&dismiss) {
      const r=dismiss.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);
      if(hit&&(hit===dismiss||dismiss.contains(hit))) return {kind:"desktop_promotion",dismissPoint:{x,y},excerpt:value.slice(0,180)};
    }
  }
  return {kind:""};
}

module.exports={probePageBlocker};

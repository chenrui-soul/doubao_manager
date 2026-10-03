"use strict";
const http = require("http");
const WebSocket = require("ws");
const port = Number(process.argv[2] || 63863);

function evalCdp(socket, expression, id) {
  socket.send(JSON.stringify({id, method: "Runtime.evaluate", params: {expression, returnByValue: true}}));
}

http.get(`http://127.0.0.1:${port}/json`, response => {
  let body = "";
  response.on("data", chunk => body += chunk);
  response.on("end", () => {
    const target = JSON.parse(body).find(item => item.type === "page" && /doubao\.com/.test(item.url));
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    socket.on("open", () => evalCdp(socket, `(() => {
      const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 2 && r.height > 2 && s.display !== "none" && s.visibility !== "hidden"; };
      const button = [...document.querySelectorAll("button,[role=button]")].find(e => visible(e) && /^(视频生成|生成视频)$/.test(String(e.innerText || e.textContent || "").replace(/\\s+/g, " ").trim()));
      if (!button) return {clicked: false};
      button.click();
      return {clicked: true, html: button.outerHTML.slice(0, 500)};
    })()`, 1));
    socket.on("message", data => {
      const message = JSON.parse(data);
      if (message.id !== 1) return;
      setTimeout(() => evalCdp(socket, `(() => ({
        url: location.href,
        placeholder: String([...document.querySelectorAll("textarea,[contenteditable=true],[role=textbox]")].find(e => { const r=e.getBoundingClientRect(),s=getComputedStyle(e); return r.width>2&&r.height>2&&s.display!=="none"&&s.visibility!=="hidden"; })?.getAttribute("placeholder") || ""),
        body: String(document.body.innerText || "").replace(/\\s+/g, " ").slice(-1200),
        controls: [...document.querySelectorAll("[data-input-engine-actionbar-control-key],[data-input-engine-actionbar-render-entry-key],[data-creation-params-panel-id]")].map(e => ({control:e.getAttribute("data-input-engine-actionbar-control-key"), render:e.getAttribute("data-input-engine-actionbar-render-entry-key"), panel:e.getAttribute("data-creation-params-panel-id"), text:String(e.innerText||e.textContent||"").replace(/\\s+/g," ").trim()}))
      }))()`, 2), 1200);
      if (message.id === 1) return;
      if (message.id === 2) { console.log(JSON.stringify(message.result?.result?.value || message, null, 2)); socket.close(); }
    });
  });
});

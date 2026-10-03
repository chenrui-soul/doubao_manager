"use strict";
// Isolated UI preview: never contacts the real activation or video services.
const http = require("node:http"), fs = require("node:fs"), path = require("node:path");
let valid = false;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const reply = (code, body) => { res.writeHead(code, {"content-type": "application/json"}); res.end(JSON.stringify(body)); };
  const state = () => ({valid, deviceCode: "DB-" + "A".repeat(64), expiresAt: valid ? "2099-01-01T00:00:00Z" : undefined, message: valid ? "已激活（界面测试）" : "请输入设备密钥激活豆包工具"});
  if (url.pathname === "/preview/status") return reply(200, state());
  if (url.pathname === "/preview/expire") { valid = false; return reply(200, state()); }
  if (url.pathname === "/api/v1/license/activate") {
    let body = ""; req.on("data", b => body += b); req.on("end", () => { valid = JSON.parse(body).secret === "ui-test"; reply(valid ? 200 : 400, {license: state(), error: "测试密钥无效"}); }); return;
  }
  if (url.pathname.startsWith("/api/")) return reply(valid ? 200 : 403, valid ? {accounts: [], jobs: []} : {code: "DOUBAO_LICENSE_REQUIRED", error: "请激活授权"});
  const files = {"/": "index.html", "/styles.css": "styles.css", "/renderer.js": "renderer.js", "/license-ui.js": "license-ui.js"};
  if (!files[url.pathname]) return reply(404, {});
  let text = fs.readFileSync(path.join(__dirname, "../desktop", files[url.pathname]), "utf8");
  if (url.pathname === "/") text = text.replace('<script src="./renderer.js">', `<script>window.doubaoDesktop={licenseStatus:()=>fetch('/preview/status').then(r=>r.json()),showLicense:async()=>{},openData:async()=>{},browserAction:async()=>{}};</script><button style="position:fixed;right:5px;top:5px;z-index:100" onclick="fetch('/preview/expire')">测试：授权失效</button><script src="./renderer.js">`);
  text = text.replaceAll("http://127.0.0.1:8787", "http://127.0.0.1:" + server.address().port);
  res.writeHead(200, {"content-type": url.pathname.endsWith(".js") ? "application/javascript" : url.pathname.endsWith(".css") ? "text/css" : "text/html; charset=utf-8"}); res.end(text);
});
server.listen(0, "127.0.0.1", () => console.log(`Preview only: http://127.0.0.1:${server.address().port}`));

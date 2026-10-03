"use strict";
const http = require("node:http");
const net = require("node:net");

// Bind only the explicitly configured interface; localhost remains available
// for the desktop UI and MCP. No listener is added by default.
function attachLanListener(primary, address) {
  if (!address) return null;
  if (!net.isIPv4(address) || address === "0.0.0.0" || address.startsWith("127.")) throw new Error("LAN 地址必须是本机网卡的具体 IPv4 地址");
  const lan = http.createServer((req, res) => primary.emit("request", req, res));
  lan.on("error", error => console.error(`LAN listener ${address}: ${error.message}`));
  primary.once("listening", () => {
    lan.listen(primary.address().port, address, () => console.log(`局域网接口：http://${address}:${lan.address().port}`));
  });
  primary.once("close", () => { lan.closeAllConnections(); lan.close(); });
  return lan;
}
module.exports = {attachLanListener};

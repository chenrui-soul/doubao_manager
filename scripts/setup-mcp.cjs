"use strict";
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const serverPath = path.join(projectRoot, "src", "mcp-server.cjs").replaceAll("\\", "/");
const launcherPath = path.join(projectRoot, "scripts", "mcp-launcher.cmd");
const electronPath = process.env.DOUBAO_ELECTRON_EXE || "D:\\04 AI项目合集\\03 灵帧AI桌面客户端源码-V0.12.2\\lingzhen_ai_desktop_v1\\node_modules\\electron\\dist\\electron.exe";
fs.writeFileSync(path.join(projectRoot, "scripts", "mcp-launcher.cmd"), `@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${electronPath}" "%~dp0..\\src\\mcp-server.cjs"\r\n`, "utf8");
const nodeCommand = process.env.DOUBAO_NODE_EXE || "C:\\nvm4w\\nodejs\\node.exe";
const config = {mcpServers: {"doubao-video-manager": {command: nodeCommand, args: [serverPath]}}};
const output = path.join(projectRoot, "mcp-config.json");
fs.writeFileSync(output, JSON.stringify(config, null, 2) + "\n", "utf8");

const claudePath = path.join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json");
let claudeStatus = "未写入 Claude Desktop（目录或配置不存在）";
if (process.env.DOUBAO_INSTALL_CLAUDE === "1" && claudePath) {
  let current = {};
  try { current = JSON.parse(fs.readFileSync(claudePath, "utf8")); } catch {}
  current.mcpServers = {...(current.mcpServers || {}), ...config.mcpServers};
  fs.mkdirSync(path.dirname(claudePath), {recursive: true});
  fs.writeFileSync(claudePath, JSON.stringify(current, null, 2) + "\n", "utf8");
  claudeStatus = `已写入 ${claudePath}`;
}
console.log(`MCP 配置已生成：${output}`);
console.log(claudeStatus);
console.log("重启 MCP 客户端后即可使用 doubao_generate_video。");

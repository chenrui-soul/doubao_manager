"use strict";
const crypto = require("node:crypto");
const path = require("node:path");
const {execFileSync, spawn} = require("node:child_process");
function getDeviceCode() {
  if (process.platform !== "win32") throw new Error("设备授权目前仅支持 Windows");
  const reg = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
  const output = execFileSync(reg, ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"], {encoding: "utf8", windowsHide: true, timeout: 5000});
  const guid = output.match(/MachineGuid\s+REG_SZ\s+([a-f0-9-]+)/i)?.[1];
  if (!guid) throw new Error("无法读取本机设备标识");
  return "DB-" + crypto.createHash("sha256").update("doubao-video-manager:v1:" + guid.toLowerCase()).digest("hex").toUpperCase();
}
// DPAPI binds ciphertext to this Windows user. Secrets travel through stdin,
// never through command arguments or process environment variables.
function protect(value, decrypt = false) {
  if (process.platform !== "win32") return Promise.reject(new Error("授权密钥加密仅支持 Windows"));
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $out=[Security.Cryptography.ProtectedData]::${decrypt ? "Unprotect" : "Protect"}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($out))`;
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {windowsHide: true, stdio: ["pipe", "pipe", "ignore"]});
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("本机密钥加密服务超时")); }, 10000);
    child.stdout.on("data", data => { output += data.toString(); });
    child.on("error", () => { clearTimeout(timer); reject(new Error("无法启动本机密钥加密服务")); });
    child.stdin.on("error", () => {});
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error("无法读取或保存密钥，请在当前 Windows 用户下重新激活"));
      resolve(decrypt ? Buffer.from(output.trim(), "base64").toString("utf8") : output.trim());
    });
    child.stdin.end(decrypt ? value : Buffer.from(value, "utf8").toString("base64"));
  });
}
module.exports = {getDeviceCode, protect};

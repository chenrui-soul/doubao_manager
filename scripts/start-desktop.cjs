"use strict";
const path = require("node:path");
const {spawn} = require("node:child_process");
const electron = process.env.DOUBAO_ELECTRON_EXE || path.resolve("D:/04 AI项目合集/03 灵帧AI桌面客户端源码-V0.12.2/lingzhen_ai_desktop_v1/node_modules/electron/dist/electron.exe");
const child = spawn(electron, [path.resolve(__dirname, "..")], {stdio: "inherit", windowsHide: false});
child.on("error", error => { console.error(`Electron 启动失败: ${error.message}`); process.exitCode = 1; });
child.on("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 0; });

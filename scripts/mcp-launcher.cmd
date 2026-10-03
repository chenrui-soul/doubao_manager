@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"D:\04 AI项目合集\03 灵帧AI桌面客户端源码-V0.12.2\lingzhen_ai_desktop_v1\node_modules\electron\dist\electron.exe" "%~dp0..\src\mcp-server.cjs"

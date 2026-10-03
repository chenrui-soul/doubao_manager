@echo off
setlocal
cd /d "%~dp0"
set "ACCOUNT_ID=%~1"
if "%ACCOUNT_ID%"=="" set /p "ACCOUNT_ID=请输入账号ID（例如 account-001）："
if "%ACCOUNT_ID%"=="" (
  echo 未输入账号ID
  pause
  exit /b 1
)
call npm run login -- "%ACCOUNT_ID%"
pause

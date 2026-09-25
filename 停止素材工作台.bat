@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "PATH=%APPDATA%\npm;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请安装 Node.js 24 或更新版本后重试。
  pause
  exit /b 1
)
node "scripts\stop.mjs"
if errorlevel 1 (
  echo 操作失败，请查看上面的错误信息。
  pause
  exit /b 1
)

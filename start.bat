@echo off
chcp 65001 >nul 2>&1
title WB Monitor 启动器
setlocal EnableExtensions
cd /d "%~dp0"

REM 面包屑日志：证明本 .bat 已执行、用的是哪个 node
set "WB_LOG=%~dp0desktop-launch.log"
echo %DATE% %TIME% [start.bat] START cwd=%CD% > "%WB_LOG%"

REM 显式定位 node.exe（不依赖系统 PATH）
set "WB_NODE="
if exist "C:\Users\DCKJ\AppData\Local\hermes\node\node.exe" set "WB_NODE=C:\Users\DCKJ\AppData\Local\hermes\node\node.exe"
if not defined WB_NODE if exist "C:\Users\DCKJ\.workbuddy\binaries\node\versions\22.22.2\node.exe" set "WB_NODE=C:\Users\DCKJ\.workbuddy\binaries\node\versions\22.22.2\node.exe"
if not defined WB_NODE set "WB_NODE=node"
echo [start.bat] node=%WB_NODE% >> "%WB_LOG%"

echo 正在关闭旧的 WB Monitor 实例（仅本程序进程，不误杀 WorkBuddy 等其它 electron 应用）...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -like '*wb-monitor*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

echo 启动 WB Monitor ...
echo （窗口关闭即退出；如需看日志见 desktop-launch.log / launch.log / boot.log）
"%WB_NODE%" scripts/start-clean.js
set "WB_RC=%ERRORLEVEL%"
echo [start.bat] node exited rc=%WB_RC% >> "%WB_LOG%"

echo.
echo WB Monitor 已退出（exit code=%WB_RC%）。按任意键关闭本窗口...
pause >nul

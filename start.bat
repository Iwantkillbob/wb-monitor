@echo off
chcp 65001 >nul 2>&1
title WB Monitor 启动器
cd /d "%~dp0"

echo 正在关闭旧的 WB Monitor 实例（仅本程序进程，不误杀 WorkBuddy 等其它 electron 应用）...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -like '*wb-monitor*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

echo 启动 WB Monitor ...
echo （窗口关闭即退出；如需看日志见 boot.log / crash.log）
node scripts/start-clean.js

echo.
echo WB Monitor 已退出。按任意键关闭本窗口...
pause >nul

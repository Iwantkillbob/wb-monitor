@echo off
chcp 65001 >nul 2>&1
title WB Monitor 启动器
cd /d "%~dp0"

echo 正在关闭旧的 WB Monitor 实例（如有）...
taskkill /im electron.exe /f >nul 2>&1

echo 启动 WB Monitor ...
echo （窗口关闭即退出；如需看日志见 boot.log / crash.log）
node scripts/start-clean.js

echo.
echo WB Monitor 已退出。按任意键关闭本窗口...
pause >nul

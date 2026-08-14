@echo off
chcp 65001 >nul 2>&1
title WB Monitor - 打包为 EXE
cd /d "%~dp0"

set LOGFILE=%~dp0build-log.txt
echo [%date% %time%] 开始打包 > "%LOGFILE%"
echo ======================================== >> "%LOGFILE%"

echo ========================================
echo   WB Monitor 打包工具 v1.1
echo ========================================
echo.

:: 检查 node/npm
where node >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 Node.js！请先安装 Node.js (https://nodejs.org)
    echo.
    pause
    exit /b 1
)

:: 检查依赖
echo [1/4] 检查依赖...
if not exist "node_modules\electron-builder" (
    echo   electron-builder 未安装，正在安装（约 30s）...
    call npm install --save-dev electron-builder >> "%LOGFILE%" 2>&1
    if errorlevel 1 (
        echo   [失败] npm install 出错，详见 build-log.txt
        echo   常见原因：网络问题 / 镜像源配置错误
        echo.
        pause
        exit /b 1
    )
)

:: 修复 electron-builder 在 Windows 上的 rename EPERM 竞态（幂等，可重复执行）
echo [2/5] 应用 electron-builder 兼容补丁...
call node scripts\patch-electron-builder.js >> "%LOGFILE%" 2>&1

:: 清理旧输出
echo [3/5] 清理旧输出...
if exist "..\wb-monitor-output" (
    rd /s /q "..\wb-monitor-output" 2>nul
)

:: 执行构建
echo [4/5] 打包中（NSIS 安装版 + Portable 便携版）...
echo   此步骤需下载 Electron 运行时，请耐心等待 1-3 分钟...
echo.
call npx electron-builder --win --config.directories.output=../wb-monitor-output >> "%LOGFILE%" 2>&1

if errorlevel 1 (
    echo.
    echo   ==========================================
    echo   [构建失败] 错误日志已保存到 build-log.txt
    echo   最后 15 行错误信息：
    echo   ==========================================
    echo.
    powershell -Command "Get-Content '%LOGFILE%' -Tail 15"
    echo.
    echo   常见原因：
    echo     1. 杀毒软件拦截（暂时关闭后重试）
    echo     2. 网络问题（Electron 下载失败，可重试）
    echo     3. 磁盘空间不足
    echo.
    pause
    exit /b 1
)

:: 显示结果
echo [5/5] 完成！生成文件：
echo.
set FOUND=0
if exist "..\wb-monitor-output" (
    for %%f in ("..\wb-monitor-output\*.exe") do (
        echo   ★ %%~nxf
        echo      ^> %%~dpf
        set FOUND=1
    )
)
if "%FOUND%"=="0" (
    echo   [警告] 未找到 exe 文件，请检查 build-log.txt
    pause
    exit /b 1
)

echo.
echo   ==========================================
echo   使用说明：
echo   - 安装版 .exe：双击安装，自动创建桌面快捷方式
echo   - 便携版 -portable.exe：单文件，拷走即用
echo   ==========================================
echo.
pause

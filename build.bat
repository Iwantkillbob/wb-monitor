@echo off
chcp 65001 >nul 2>&1
title WB Monitor - 打包为 EXE
cd /d "%~dp0"

echo ========================================
echo   WB Monitor 打包工具
echo   正在构建 Windows 安装包 + 便携版...
echo ========================================
echo.

:: 清理旧输出
if exist "..\wb-monitor-output" (
    echo [1/4] 清理旧输出目录...
    rd /s /q "..\wb-monitor-output" 2>nul
)

:: 检查依赖
echo [2/4] 检查依赖...
if not exist "node_modules\electron-builder" (
    echo   安装 electron-builder...
    call npm install --save-dev electron-builder
    if errorlevel 1 (
        echo   ERROR: npm install 失败！请检查网络或切换镜像源。
        pause
        exit /b 1
    )
)

:: 执行构建
echo.
echo [3/4] 开始打包（NSIS 安装版 + Portable 便携版）...
echo   这可能需要几分钟（需要下载 Electron 运行时）...
echo.
call npx electron-builder --win --config.directories.output=../wb-monitor-output

if errorlevel 1 (
    echo.
    echo   ==========================================
    echo   ERROR: 构建失败！请查看上方错误信息。
    echo   常见原因：
    echo     1. dist 目录被占用（关闭资源管理器窗口后重试）
    echo     2. 网络问题（Electron 下载失败）
    echo     3. 杀毒软件干扰（暂时禁用后重试）
    echo   ==========================================
    pause
    exit /b 1
)

:: 显示结果
echo.
echo [4/4] 完成！输出文件：
echo.
if exist "..\wb-monitor-output" (
    for %%f in ("..\wb-monitor-output\*.exe") do echo   ★ %%~nxf
    for %%f in ("..\wb-monitor-output\*.exe") do echo   路径: %%~dpf
) else (
    echo   未找到 exe 文件，请检查 wb-monitor-output 目录
)
echo.
echo ========================================
pause

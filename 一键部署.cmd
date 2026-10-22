@echo off
setlocal
chcp 65001 >nul 2>nul
set "HERE=%~dp0"

echo ==================================================
echo   关键词插件 - 一键部署 (Windows)
echo ==================================================
echo.
echo 插件将被安装到:
echo   %USERPROFILE%\.openclaw\keyword-router
echo.

if not exist "%HERE%install.ps1" (
    echo [错误] 找不到 install.ps1。
    echo        请先把压缩包完整解压，再双击本文件。
    echo.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%install.ps1" %*
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
    echo [完成] 部署结束。
    echo.
    echo 还剩一步: 重启 OpenClaw 网关, 然后到微信里发关键词测试。
    echo 具体命令见 README 的「重启网关」一节。
) else (
    echo [失败] 退出码 %RC%, 请看上面的报错。
)
echo.
pause
exit /b %RC%

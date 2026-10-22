@echo off
setlocal
chcp 65001 >nul 2>nul
set "HERE=%~dp0"

echo ==================================================
echo   keyword-router - one-click deploy (Windows)
echo ==================================================
echo.
echo Plugin will be installed to:
echo   %USERPROFILE%\.openclaw\keyword-router
echo.

if not exist "%HERE%install.ps1" (
    echo [ERROR] install.ps1 not found next to this file.
    echo         Please extract the WHOLE zip first, then double-click this again.
    echo.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%install.ps1" %*
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
    echo [OK] Deploy finished.
    echo.
    echo Remaining step - restart the OpenClaw gateway, then test in WeChat.
    echo Readme section "3. Restart the gateway" for the exact commands.
) else (
    echo [FAILED] exit code %RC%. See the messages above.
)
echo.
pause
exit /b %RC%

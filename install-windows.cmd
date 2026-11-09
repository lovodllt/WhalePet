@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 22.12 or later first: https://nodejs.org/
  pause
  exit /b 1
)
call npm ci
if errorlevel 1 goto failed
call npx --no-install install-electron
if errorlevel 1 goto failed
echo Installation completed.
pause
exit /b 0
:failed
echo Installation failed. Check the output above and try again.
pause
exit /b 1

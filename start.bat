@echo off
title Online Test Platform - server (keep this window open)
cd /d "%~dp0"
echo ================================================================
echo   Starting the Online Test Platform...
echo   Once it says "running", open http://localhost:3000
echo   Keep THIS window open. Close it to stop the server.
echo ================================================================
echo.
where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
) else (
  "%ProgramFiles%\nodejs\node.exe" server.js
)
echo.
echo Server stopped. Press any key to close.
pause >nul

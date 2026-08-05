@echo off
title Online Test Platform - server (keep this window open)
cd /d "%~dp0"
echo ================================================================
echo   Online Test Platform
echo   Building the React frontend, then starting the server...
echo   Once it says "running", open http://localhost:3000
echo   Keep THIS window open. Close it to stop the server.
echo ================================================================
echo.
echo Building frontend...
where npm >nul 2>nul
if %errorlevel%==0 (
  call npm --prefix client run build
) else (
  call "%ProgramFiles%\nodejs\npm.cmd" --prefix client run build
)
echo.
echo Starting server...
where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
) else (
  "%ProgramFiles%\nodejs\node.exe" server.js
)
echo.
echo Server stopped. Press any key to close.
pause >nul

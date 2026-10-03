@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Novel Publisher - Panel

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install it first: https://nodejs.org
  pause
  exit /b 1
)

echo.
echo   Starting the local panel. Your browser should open automatically.
echo   If it does not open, copy the address printed below into your browser.
echo.
echo   KEEP THIS WINDOW OPEN while using the panel.
echo   Close this window to stop the panel.
echo.

node src\ui\server.js

echo.
echo Panel stopped.
pause

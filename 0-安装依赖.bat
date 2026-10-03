@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Novel Publisher - Install Dependencies

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found. Please install it first: https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo [1/2] Installing dependencies, please wait (about 1 minute)...
echo.
call npm install
if errorlevel 1 (
  echo.
  echo [ERROR] npm install failed. Check your network and try again.
  echo.
  pause
  exit /b 1
)

echo.
echo [2/2] Downloading the built-in browser (Chromium, about 150 MB)...
echo       Why: it is the fallback used when Chrome / Edge is not installed.
echo       You can close this window if you don't want to wait now.
echo       The tool still works without it as long as Chrome or Edge exists.
echo.
call npx playwright-core install chromium
if errorlevel 1 (
  echo.
  echo [WARN] Built-in browser download failed. This is NOT fatal.
  echo        Retry later in this folder: npx playwright-core install chromium
  echo.
)

echo.
echo [DONE]
echo   Next: double click "1-FirstLogin".
echo   Tip : double click "8-Precheck" to see which browser will be used.
echo.
pause

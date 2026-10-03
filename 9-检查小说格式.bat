@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Novel Publisher - Check Novel Format

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install it first: https://nodejs.org
  pause
  exit /b 1
)

node src\cli.js lint

echo.
pause

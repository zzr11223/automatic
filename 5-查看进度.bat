@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Novel Publisher - Status

node src\cli.js status

echo.
pause

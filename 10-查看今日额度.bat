@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Novel Publisher - Daily Quota

node src\cli.js daily

echo.
pause

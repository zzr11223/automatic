@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Novel Publisher - Remove Daily Timer

node src\cli.js timer-remove

echo.
pause

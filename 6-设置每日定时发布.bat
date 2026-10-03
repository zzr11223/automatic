@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Novel Publisher - Setup Daily Timer

node src\cli.js timer-set

echo.
pause

@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist logs mkdir logs
node src\cli.js publish --unattended >> "logs\scheduled.log" 2>&1

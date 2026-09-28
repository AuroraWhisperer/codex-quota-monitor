@echo off
setlocal
chcp 65001 >nul
title Codex Quota Monitor
node "%~dp0src\quota-monitor.mjs" --watch %*
set "monitor_exit=%errorlevel%"
if not "%monitor_exit%"=="0" pause
exit /b %monitor_exit%

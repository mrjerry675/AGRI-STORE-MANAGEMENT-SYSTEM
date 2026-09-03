@echo off
title Kisan Depot
cd /d "%~dp0"

rem If the server is already running, just open the browser
netstat -ano | findstr /r ":3000 .*LISTENING" >nul
if %errorlevel%==0 (
    start "" http://localhost:3000
    exit
)

echo Starting Kisan Depot at http://localhost:3000 ...
start "" http://localhost:3000
"C:\Program Files\nodejs\node.exe" server.js
pause

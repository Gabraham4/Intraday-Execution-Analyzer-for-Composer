@echo off
:: Double-click this file to launch the Intraday Execution Analyzer Web GUI

cd /d "%~dp0app"

echo.
echo   Starting Intraday Execution Analyzer GUI...
echo   Opening http://localhost:3000 in your browser...
echo.

start "" http://localhost:3000
node gui-server.js
pause

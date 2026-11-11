@echo off
rem Launches Redline without leaving a console window open.
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing dependencies, one moment...
  call npm install
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."

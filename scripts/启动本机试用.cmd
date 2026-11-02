@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-persistent-work-trial.ps1"
if errorlevel 1 pause

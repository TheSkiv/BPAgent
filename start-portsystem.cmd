@echo off
rem Starts the PortSystem server and starts it again if it stops (ROADMAP A14 / S11).
rem Runs at Windows logon (hidden) from the Startup folder file "PortSystem.cmd"; can also be
rem double-clicked. To stop PortSystem: stop-portsystem.cmd.
rem KIPIS still needs a person: after every start, press Open KIPIS and enter the MFA code.
title PortSystem server
cd /d C:\PortSystem

rem Already running (started by hand, or a second copy of this script)? Then do nothing.
curl -s -m 3 -o nul http://localhost:3001/mail/auto
if not errorlevel 1 (
  echo PortSystem is already running on port 3001.
  timeout /t 5 >nul
  exit /b 0
)

:loop
echo [%date% %time%] starting PortSystem
echo [%date% %time%] starting PortSystem>> server.log
node --use-system-ca src/server.js >> server.log 2>> server.err
echo [%date% %time%] PortSystem stopped (exit code %errorlevel%) - starting again in 10 seconds
echo [%date% %time%] PortSystem stopped (exit code %errorlevel%)>> server.log
timeout /t 10 /nobreak >nul
goto loop

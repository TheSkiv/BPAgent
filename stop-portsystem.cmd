@echo off
rem Stops PortSystem: the restart loop (start-portsystem.cmd) first, then the server itself.
rem Start it again with start-portsystem.cmd, or log off and on.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -match 'start-portsystem' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'src/server.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo PortSystem stopped.
timeout /t 3 >nul

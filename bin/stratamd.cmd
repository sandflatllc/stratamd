@echo off
setlocal DisableDelayedExpansion
set "STRATAMD_CLI_EXECUTABLE=%~f0"
set "ELECTRON_RUN_AS_NODE=1"
if exist "%~dp0StrataMD.exe" (
  set "STRATAMD_APP_EXECUTABLE=%~dp0StrataMD.exe"
  "%~dp0StrataMD.exe" "%~dp0resources\app.asar\out\main\cli.js" %*
) else (
  "%~dp0..\node_modules\electron\dist\electron.exe" "%~dp0..\out\main\cli.js" %*
)
exit /b %errorlevel%

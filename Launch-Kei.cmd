@echo off
setlocal
cd /d "%~dp0"
if not defined KEI_PROFILE_DIR set "KEI_PROFILE_DIR=%LOCALAPPDATA%\KeiDesktop-v1"
if not defined KEI_DATA_DIR set "KEI_DATA_DIR=%KEI_PROFILE_DIR%\kei-host"
if not defined KEI_HOST_ARTIFACT set "KEI_HOST_ARTIFACT=%~dp0dist\kei-host.pyz"
if not defined KEI_HOST_PYTHON set "KEI_HOST_PYTHON=%~dp0.venv\Scripts\python.exe"
if not exist "%KEI_HOST_ARTIFACT%" (
  echo Build dist\kei-host.pyz first. See README.md.
  exit /b 1
)
if not exist "%KEI_HOST_PYTHON%" (
  echo Set up the Python virtual environment per README.md.
  exit /b 1
)
call npm --prefix frontend start
exit /b %ERRORLEVEL%

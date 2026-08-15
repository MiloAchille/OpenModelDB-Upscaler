@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo === OpenModelDB Upscaler build ===
echo Output: named installer + portable EXEs in dist\
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js not found on PATH.
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm not found on PATH.
  exit /b 1
)

if not exist "node_modules\electron-builder\" (
  echo Installing npm dependencies...
  call npm install
  if errorlevel 1 (
    echo ERROR: npm install failed.
    exit /b 1
  )
)

echo Cleaning dist\...
if exist "dist\" rmdir /s /q "dist"

echo Building Windows installer + portable...
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npx electron-builder --win nsis portable --publish never
if errorlevel 1 (
  echo ERROR: build failed.
  exit /b 1
)

echo Cleaning build leftovers...
if exist "dist\win-unpacked\" rmdir /s /q "dist\win-unpacked"
if exist "dist\.icon-ico\" rmdir /s /q "dist\.icon-ico"
del /q "dist\builder-*.yml" 2>nul
del /q "dist\builder-*.yaml" 2>nul
del /q "dist\*.blockmap" 2>nul
del /q "dist\*.7z" 2>nul
del /q "dist\*.zip" 2>nul
del /q "dist\__uninstaller-*.exe" 2>nul

set "FOUND_SETUP="
set "FOUND_PORTABLE="
for %%F in ("dist\*-Setup.exe") do set "FOUND_SETUP=1"
for %%F in ("dist\*-Portable.exe") do set "FOUND_PORTABLE=1"

if not defined FOUND_SETUP (
  echo ERROR: setup installer EXE was not produced.
  exit /b 1
)
if not defined FOUND_PORTABLE (
  echo ERROR: portable EXE was not produced.
  exit /b 1
)

echo.
echo Done. Shipping files only:
dir /b "dist\*.exe"
echo.
echo Folder: "%cd%\dist"
exit /b 0

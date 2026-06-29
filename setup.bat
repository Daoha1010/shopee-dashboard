@echo off
chcp 65001 >nul
echo.
echo === Shopee Dashboard Setup ===
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
  echo [LOI] Chua cai Node.js!
  echo Vao https://nodejs.org, tai ban LTS va cai dat truoc.
  pause
  exit /b 1
)

echo Dang cai dat thu vien...
call npm install

if %errorlevel% neq 0 (
  echo [LOI] npm install that bai.
  pause
  exit /b 1
)

echo.
echo Setup hoan tat! Hay chay start.bat de bat server.
echo.
pause

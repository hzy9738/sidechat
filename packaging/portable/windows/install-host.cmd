@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-host.ps1"
if errorlevel 1 (
  echo.
  echo 安装失败，请保留此窗口并联系安装包提供方。
)
pause


@echo off
chcp 65001 >nul
cd /d "%~dp0"
py -3.12 -m venv .venv
if errorlevel 1 goto failed
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 goto failed
.venv\Scripts\python.exe start.py --check
if errorlevel 1 goto failed
echo 처음 설정을 완료했습니다. start-windows.cmd로 실행하세요.
pause
exit /b 0
:failed
echo 설정하지 못했습니다. Python 3.12, Node.js 22 이상, Chrome 설치 여부를 확인하세요.
pause
exit /b 1

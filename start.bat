@echo off
cd /d "%~dp0"
start "" http://localhost:8743
python -m http.server 8743

@echo off
"%~dp0..\sample\.venv\Scripts\python.exe" -m pytest "%~dp0tests" -q %*

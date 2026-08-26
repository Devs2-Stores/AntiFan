@ECHO off
@SETLOCAL
@SET PATHEXT=%PATHEXT:;.JS;=;%
node "%~dp0\antifan-agent.cjs" %*

' AntiFan - Silent Background iTunes Launcher
' Launches start-itunes-background.ps1 completely invisibly (no cmd window flash)
Set objShell = CreateObject("WScript.Shell")
strScriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
strPs1 = strScriptDir & "\start-itunes-background.ps1"
strCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & strPs1 & """"
objShell.Run strCmd, 0, False

' AntiFan Browser Desktop - Development Background Launcher
' Launches Electron with --allow-eval, coherent with dev.mjs and run-electron.cjs (dev mode).
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "E:\\Work\\apps\\AntiFan"
WshShell.Run """E:\\Work\\apps\\AntiFan\\node_modules\\electron\\dist\\electron.exe"" ""E:\\Work\\apps\\AntiFan"" --allow-eval", 0, False

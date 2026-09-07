Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "E:\\Work\\apps\\AntiFan"
WshShell.Run """E:\\Work\\apps\\AntiFan\\node_modules\\electron\\dist\\electron.exe"" """E:\\Work\\apps\\AntiFan""", 0, False

Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "E:\Work\apps\antifan-browser-desktop"
WshShell.Run """E:\Work\apps\antifan-browser-desktop\node_modules\electron\dist\electron.exe"" ""E:\Work\apps\antifan-browser-desktop"" --production", 0, False

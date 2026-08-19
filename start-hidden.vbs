' Launches start.ps1 with no console window — used by the Startup-folder shortcut.
' Run it directly to start ClaudeDash in the background at any time.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
' 0 = hidden window, False = don't wait for it to exit
shell.Run "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File """ & root & "\start.ps1""", 0, False

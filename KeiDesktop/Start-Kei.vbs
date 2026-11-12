Option Explicit
Dim shell, fileSystem, launcher, command, result
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
launcher = fileSystem.BuildPath(fileSystem.GetParentFolderName(WScript.ScriptFullName), "Start-Kei.ps1")
command = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & launcher & """"
result = shell.Run(command, 0, True)
If result <> 0 Then
    shell.Popup "Kei startup failed. See D:\KeiDesktop\launcher-logs.", 0, "Kei", 16
End If

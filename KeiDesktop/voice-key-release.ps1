param([int]$VirtualKey)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class KeiKeyState { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key); }'
do { Start-Sleep -Milliseconds 40 } while (([KeiKeyState]::GetAsyncKeyState($VirtualKey) -band 0x8000) -ne 0)

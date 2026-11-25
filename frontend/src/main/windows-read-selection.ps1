param([int] $ExcludeProcessId)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KeiSelectionWindow {
    [DllImport("user32")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
}
'@
$foreground = [KeiSelectionWindow]::GetForegroundWindow()
[uint32] $owner = 0
$null = [KeiSelectionWindow]::GetWindowThreadProcessId($foreground, [ref] $owner)
if (!$owner -or $owner -eq $ExcludeProcessId) {
    @{ error = 'selection_external_focus' } | ConvertTo-Json -Compress
    exit
}
$element = [System.Windows.Automation.AutomationElement]::FocusedElement
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$selected = ''
for ($i = 0; $i -lt 10 -and $null -ne $element; $i++) {
    $handle = [IntPtr] $element.Current.NativeWindowHandle
    if ($handle -ne [IntPtr]::Zero -and [KeiSelectionWindow]::GetAncestor($handle, 2) -ne $foreground) { break }
    $pattern = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref] $pattern)) {
        $selected = (($pattern.GetSelection() | Select-Object -First 8 | ForEach-Object { $_.GetText(12000) }) -join "`n").Trim()
        if ($selected) { break }
    }
    $element = $walker.GetParent($element)
}
if ([KeiSelectionWindow]::GetForegroundWindow() -ne $foreground) {
    @{ error = 'selection_external_focus' } | ConvertTo-Json -Compress
    exit
}
@{ text = $selected.Substring(0, [Math]::Min(12000, $selected.Length)) } | ConvertTo-Json -Compress

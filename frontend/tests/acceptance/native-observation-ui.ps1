param(
    [ValidateSet("Window","Shortcut","Choose")][string] $Mode,
    [string] $Title,
    [int] $OwnerPid,
    [ValidateRange(100,110)][int] $ButtonId = 100
)
$ErrorActionPreference = "Stop"
if ($Mode -eq "Window") {
    Add-Type -AssemblyName System.Windows.Forms,System.Drawing
    $window = New-Object System.Windows.Forms.Form
    $window.Text = $Title
    $window.ClientSize = New-Object System.Drawing.Size(480,300)
    $window.BackColor = [System.Drawing.Color]::FromArgb(25,211,95)
    $window.StartPosition = "CenterScreen"
    $window.ShowInTaskbar = $true
    $label = New-Object System.Windows.Forms.Label
    $label.Text = "KEI ISOLATED TEST FRAME"
    $label.ForeColor = [System.Drawing.Color]::Black
    $label.AutoSize = $true
    $label.Location = New-Object System.Drawing.Point(14,14)
    $window.Controls.Add($label)
    $window.Add_Shown({ [Console]::WriteLine("READY") })
    $null = $window.ShowDialog()
    exit
}
if ($Mode -eq "Shortcut") {
    $shell = New-Object -ComObject WScript.Shell
    if (!$shell.AppActivate($OwnerPid)) { throw "Could not activate the test instance" }
    $shell.SendKeys("^%s")
    exit
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class KeiOwnedTestDialog {
    private delegate bool EnumCallback(IntPtr window, IntPtr data);
    [DllImport("user32")] static extern bool EnumWindows(EnumCallback callback, IntPtr data);
    [DllImport("user32")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
    [DllImport("user32", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int length);
    [DllImport("user32")] static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
    // Electron creates Japanese custom button IDs at 100 plus the button's index.
    // Only the native modal of the newly spawned test app may receive this input.
    public static bool Choose(uint pid, string title, int id) {
        bool chosen = false;
        EnumWindows(delegate(IntPtr dialog, IntPtr unused) {
            uint owner;
            GetWindowThreadProcessId(dialog, out owner);
            if (owner != pid || !IsWindowVisible(dialog)) return true;
            var kind = new StringBuilder(64);
            GetClassName(dialog, kind, kind.Capacity);
            if (kind.ToString() != "#32770") return true;
            var text = new StringBuilder(1024);
            GetWindowText(dialog, text, text.Capacity);
            if (text.ToString() != title) return true;
            chosen = PostMessage(dialog, 0x400 + 102, (IntPtr)id, IntPtr.Zero);
            return !chosen;
        }, IntPtr.Zero);
        return chosen;
    }
}
'@
$deadline = [DateTime]::UtcNow.AddSeconds(12)
while ([DateTime]::UtcNow -lt $deadline) {
    if ([KeiOwnedTestDialog]::Choose([uint32]$OwnerPid,$Title,$ButtonId)) {
        [Console]::WriteLine("SELECTED")
        exit
    }
    Start-Sleep -Milliseconds 120
}
throw "Native dialog target was unavailable"

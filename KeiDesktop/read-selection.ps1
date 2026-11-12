$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$element = [System.Windows.Automation.AutomationElement]::FocusedElement
$selected = ''
$source = ''
for ($i = 0; $i -lt 6 -and $null -ne $element; $i++) {
    $pattern = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
        $ranges = $pattern.GetSelection()
        $selected = (($ranges | ForEach-Object { $_.GetText(12000) }) -join "`n").Trim()
        if ($selected) { $source = $element.Current.Name; break }
    }
    $element = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($element)
}
@{ text = $selected.Substring(0, [Math]::Min(12000, $selected.Length)); source = $source } | ConvertTo-Json -Compress

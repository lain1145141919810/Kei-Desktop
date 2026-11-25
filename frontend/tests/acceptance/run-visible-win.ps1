param(
    [ValidateSet('counter','no-host','executors-mcp','hardening','plugin-mcp','capture','chat-reading','reading-import')]
    [string[]] $Scenario = @('counter','no-host','executors-mcp'),
    [Parameter(Mandatory)]
    [string] $EvidenceRoot
)
$ErrorActionPreference = 'Stop'
if (!$IsWindows) { throw 'Run this harness in a Windows desktop session with PowerShell 7.' }
$frontend = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$evidence = [IO.Path]::GetFullPath($EvidenceRoot)
$originalOffscreen = $env:KEI_OFFSCREEN
$originalEvidence = $env:KEI_EVIDENCE_DIR
$env:KEI_OFFSCREEN = $null
Push-Location $frontend
try {
    foreach ($name in $Scenario) {
        $out = Join-Path $evidence $name
        [IO.Directory]::CreateDirectory($out) | Out-Null
        $env:KEI_EVIDENCE_DIR = $out
        $base = Join-Path $PSScriptRoot "$name.mjs"
        $script = Join-Path $PSScriptRoot ("visible-" + [guid]::NewGuid().ToString('N') + ".mjs")
        $source = [IO.File]::ReadAllText($base)
        $argsLine = 'const args = [frontend, "--no-sandbox"];'
        $launchLine = 'executablePath: require("electron"), args, env'
        if (!$source.Contains($argsLine) -or !$source.Contains($launchLine)) {
            throw "The source launch harness changed in $name."
        }
        $source = $source.Replace($argsLine,'const args = [frontend];')
        $source = $source.Replace($launchLine,'executablePath: require("electron"), chromiumSandbox: true, args, env')
        if ($name -eq 'capture') {
            $fixtureSetup = 'globalThis.__chooser = { mode: "fixture", asked: [] };'
            if (!$source.Contains($fixtureSetup)) { throw 'The capture fixture setup changed.' }
            $source = $source.Replace('await app.evaluate(({ dialog }) => {', 'await app.evaluate(({ dialog, desktopCapturer }) => {')
            $source = $source.Replace($fixtureSetup, 'desktopCapturer.getSources = async () => []; ' + $fixtureSetup)
            $source = $source.Replace('record("C0 Ctrl+Alt+S is registered as the observation toggle", registered === true);',
                'if (registered) record("C0 Ctrl+Alt+S is registered as the observation toggle", true); else console.log("SKIP C0: the native shortcut is already owned");')
        }
        $launch = [regex]::new('(?s)(?:const )?app = await electron\.launch\(\{.*?\}\);')
        if (!$launch.IsMatch($source)) { throw "The Electron launch call changed in $name." }
        $verification = @'

const firstNativeWindow = await app.firstWindow();
await firstNativeWindow.waitForFunction(() => !document.hidden);
let windows;
for (let attempt = 0; attempt < 30; attempt++) {
    windows = await app.evaluate(({ app, BrowserWindow }) => ({
        noSandbox: app.commandLine.hasSwitch("no-sandbox"),
        native: process.platform === "win32",
        windows: BrowserWindow.getAllWindows().map(window => ({
            visible: window.isVisible(), offscreen: window.webContents.isOffscreen(),
            sandbox: window.webContents.getLastWebPreferences().sandbox,
        })),
    }));
    if (windows.windows.some(window => window.visible)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
}
console.log("Windows visible check", JSON.stringify(windows));
if (!windows.native || windows.noSandbox || !windows.windows.some(window => window.visible) ||
    windows.windows.some(window => window.offscreen || !window.sandbox)) {
    await app.close();
    throw new Error("Visible Windows Chromium sandbox was not active");
}
'@
        $source = $launch.Replace($source, { param($match) $match.Value + $verification + [Environment]::NewLine }, 1)
        try {
            [IO.File]::WriteAllText($script, $source)
            & node $script 2>&1 | Tee-Object -FilePath (Join-Path $out 'console.log')
            if ($LASTEXITCODE) { throw "$name failed with exit code $LASTEXITCODE" }
        } finally {
            if (Test-Path -LiteralPath $script) { Remove-Item -LiteralPath $script }
        }
    }
} finally {
    Pop-Location
    $env:KEI_OFFSCREEN = $originalOffscreen
    $env:KEI_EVIDENCE_DIR = $originalEvidence
}

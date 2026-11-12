[CmdletBinding()]
param([string]$ElectronDist = "$PSScriptRoot/node_modules/electron/dist", [string]$OutputDirectory = "$PSScriptRoot/dist")
$ErrorActionPreference = 'Stop'
if (!(Test-Path "$ElectronDist/electron.exe")) { throw 'Install Electron with npm ci or specify -ElectronDist.' }
$stage = Join-Path ([IO.Path]::GetTempPath()) ("Kei-build-" + [guid]::NewGuid().ToString('N'))
$bundle = Join-Path $stage 'Kei-Desktop'
$dest = Join-Path $bundle 'resources/app'
New-Item -ItemType Directory $dest -Force | Out-Null
try {
    Copy-Item "$ElectronDist/*" $bundle -Recurse -Force
    Rename-Item "$bundle/electron.exe" 'Kei Desktop.exe'
    Copy-Item "$PSScriptRoot/standalone" $dest -Recurse
    '{"name":"kei-desktop","productName":"Kei Desktop","version":"0.2.0","main":"standalone/main.js"}' | Set-Content "$dest/package.json" -Encoding ascii
    foreach ($name in @('branding/kei-logo.png','character/CH0335_home_Idle_01.webm','lifecycle/startup.mp4','lifecycle/shutdown.mp4')) {
        $target = Join-Path "$dest/assets" $name
        New-Item -ItemType Directory (Split-Path $target) -Force | Out-Null
        Copy-Item "$PSScriptRoot/assets/$name" $target
    }
    Copy-Item "$PSScriptRoot/../THIRD_PARTY_NOTICES.md","$PSScriptRoot/../docs/STANDALONE.zh.md" $bundle
    Copy-Item "$PSScriptRoot/../LICENSE" "$bundle/PROJECT-LICENSE"
    New-Item -ItemType Directory $OutputDirectory -Force | Out-Null
    $zip = Join-Path (Resolve-Path $OutputDirectory) 'Kei-Desktop-Windows-x64.zip'
    & tar.exe -a -cf $zip -C $stage Kei-Desktop
    if ($LASTEXITCODE) {throw 'Archive failed'}
    Write-Output $zip
} finally {
    $resolved = (Resolve-Path $stage).Path
    if ((Split-Path $resolved -Parent) -eq ([IO.Path]::GetTempPath().TrimEnd('\')) -and (Split-Path $resolved -Leaf) -match '^Kei-build-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}

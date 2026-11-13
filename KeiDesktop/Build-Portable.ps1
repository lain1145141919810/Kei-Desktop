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
    foreach($name in @('standalone','renderer','assets','entry.js','main.js','preload.js','companion.js','reading-plans.js','conversation-store.js','attachments.js','read-selection.ps1')){
        Copy-Item "$PSScriptRoot/$name" $dest -Recurse
    }
    foreach($name in @('live2d-official/public','vendor/cubism/Core')){
        $target=Join-Path $dest $name
        New-Item -ItemType Directory (Split-Path $target) -Force | Out-Null
        Copy-Item "$PSScriptRoot/$name" $target -Recurse
    }
    Copy-Item "$PSScriptRoot/vendor/cubism/Framework/LICENSE.md" "$bundle/Cubism-Framework-LICENSE.md"
    '{"name":"kei-desktop","productName":"Kei Desktop","version":"0.3.2","main":"entry.js"}' | Set-Content "$dest/package.json" -Encoding ascii
    Copy-Item "$PSScriptRoot/../THIRD_PARTY_NOTICES.md","$PSScriptRoot/../docs/STANDALONE.ja.md" $bundle
    Copy-Item "$PSScriptRoot/standalone/AI-INSTALL.ja.txt","$PSScriptRoot/standalone/AI-INSTALL.zh.txt","$PSScriptRoot/../docs/STANDALONE.zh.md" $bundle
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


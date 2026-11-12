[CmdletBinding()]
param([switch]$CheckOnly)
$ErrorActionPreference='Stop'
$electron=Join-Path $PSScriptRoot 'node_modules/electron/dist/electron.exe'
if (!(Test-Path -LiteralPath $electron)) {throw 'Run npm ci in KeiDesktop first, or download the portable ZIP from GitHub Releases.'}
if ($CheckOnly) {Write-Host 'Kei Desktop standalone is ready.';return}
$env:KEI_LEGACY_DESKTOP='0'
& $electron $PSScriptRoot
exit $LASTEXITCODE

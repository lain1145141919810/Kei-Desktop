# Stage the public files onto a FRESH Windows machine. Refuse to overwrite a live install.
[CmdletBinding(SupportsShouldProcess)]
param()
$ErrorActionPreference = "Stop"
if (!(Test-Path D:/)) { throw "The installed backend requires a D: drive." }
$pluginRoot="D:/AstrBot-master/AstrBot-master/data/plugins"
$ttsRoot=Join-Path $env:USERPROFILE "GPT-SoVITS"
if (!(Test-Path (Join-Path $ttsRoot 'GPT_SoVITS'))) { throw "Clone GPT-SoVITS first. See README.md." }
$copies=@(
    @{src='KeiDesktop';dst='D:/KeiDesktop'}, @{src='KeiRuntime';dst='D:/KeiRuntime'},
    @{src='AstrBot-plugins/apply_aqua_tts_patch.py';dst='D:/AstrBot-master/apply_aqua_tts_patch.py'}
)
foreach($folder in Get-ChildItem "$PSScriptRoot/AstrBot-plugins" -Directory){$copies+=@{src="AstrBot-plugins/$($folder.Name)";dst="$pluginRoot/$($folder.Name)"}}
foreach($file in Get-ChildItem "$PSScriptRoot/GPT-SoVITS-overlay" -File | Where-Object Name -ne 'LICENSE'){$copies+=@{src="GPT-SoVITS-overlay/$($file.Name)";dst=(Join-Path $ttsRoot $file.Name)}}
foreach($item in $copies){if(Test-Path -LiteralPath $item.dst){throw "Destination already exists: $($item.dst). Review manually."}}
foreach($item in $copies){
 if($PSCmdlet.ShouldProcess($item.dst,'Install project files')){
  New-Item -ItemType Directory -Path (Split-Path $item.dst) -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $item.src) -Destination $item.dst -Recurse
 }
}
foreach($file in @("$ttsRoot/voices.json","$ttsRoot/aqua_astrbot_config.json","D:/KeiDesktop/tts-v3-profile.json","D:/KeiRuntime/voice/references.json")){
 if($PSCmdlet.ShouldProcess($file,'Expand profile path')){
  $txt=[IO.File]::ReadAllText($file).Replace('__USERPROFILE__',$env:USERPROFILE.Replace('\','/'))
  [IO.File]::WriteAllText($file,$txt,(New-Object Text.UTF8Encoding($false)))
 }
}

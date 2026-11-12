param([switch]$CheckOnly, [ValidateSet('v2pro','v3')][string]$TtsBackend = 'v3', [switch]$RestartTts)

$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $root 'launcher-logs'
$tts = (Join-Path $env:USERPROFILE 'GPT-SoVITS')
$astrbot = 'D:\AstrBot-master\AstrBot-master'
$runtime = 'D:\KeiRuntime'
$desktop = 'D:\KeiDesktop'
$live2d = Join-Path $desktop 'live2d-official'
$runId = Get-Date -Format 'yyyyMMdd-HHmmss'
$startupMutex = New-Object System.Threading.Mutex($false, 'Local\KeiDesktopStartup')
$startupLocked = $false

function Assert-File($path) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing file: $path" }
}
function Assert-Directory($path) {
    if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw "Missing directory: $path" }
}
function Test-Http($url) {
    try {
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
        return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
    } catch { return $false }
}
function Test-Port($port) {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $a = $c.BeginConnect('127.0.0.1', $port, $null, $null)
        if (-not $a.AsyncWaitHandle.WaitOne(500)) { return $false }
        $c.EndConnect($a)
        return $true
    } catch { return $false } finally { $c.Close() }
}
function Wait-Http($name, $url, $port, $seconds, $process) {
    $until = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $until) {
        if (Test-Http $url) { Write-Host "[ready] $name"; return }
        if ($process -and $process.HasExited) { throw "$name exited early. Check $logDir" }
        Start-Sleep -Seconds 2
    }
    throw "$name did not become ready on port $port within $seconds seconds. Check $logDir"
}
function Start-Service($name, $file, $arguments, $cwd, $url, $port, $seconds, $environment = @{}) {
    if (Test-Http $url) { Write-Host "[running] $name ($url)"; return }
    if (Test-Port $port) { throw "$name port $port is occupied but $url is not healthy; refusing to start another instance" }
    if ($CheckOnly) { Write-Host "[check] $name can start: $file $arguments"; return }
    $out = Join-Path $logDir "$runId-$name.out.log"
    $err = Join-Path $logDir "$runId-$name.err.log"
    foreach ($key in $environment.Keys) { [Environment]::SetEnvironmentVariable($key, $environment[$key], 'Process') }
    try {
        $p = Start-Process -FilePath $file -ArgumentList $arguments -WorkingDirectory $cwd -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden
    } finally {
        foreach ($key in $environment.Keys) { [Environment]::SetEnvironmentVariable($key, $null, 'Process') }
    }
    Write-Host "[start] $name PID=$($p.Id); logs: $out, $err"
    Wait-Http $name $url $port $seconds $p
}

try {
    try { $startupLocked = $startupMutex.WaitOne(900000) } catch [System.Threading.AbandonedMutexException] { $startupLocked = $true }
    if (-not $startupLocked) { throw 'Another Kei startup did not finish.' }
    if (-not $CheckOnly) {
        Start-Process 'D:\KeiRuntime\.venv\Scripts\python.exe' -ArgumentList (Join-Path $root 'log_retention.py') -WorkingDirectory $root -WindowStyle Hidden
    }
    Assert-Directory $tts; Assert-Directory $astrbot; Assert-Directory $runtime; Assert-Directory $desktop; Assert-Directory $live2d
    $ttsPython = Join-Path $tts '.venv\Scripts\python.exe'
    $runtimePython = Join-Path $runtime '.venv\Scripts\python.exe'
    $vite = Join-Path $live2d 'node_modules\.bin\vite.cmd'
    $electron = Join-Path $desktop 'node_modules\electron\dist\electron.exe'
    $astrbotExe = (Join-Path $env:USERPROFILE '.local/bin/astrbot.exe')
    $astrbotPython = (Join-Path $env:APPDATA 'uv/tools/astrbot/Scripts/python.exe')
    $astrbotPatch = 'D:\AstrBot-master\apply_aqua_tts_patch.py'
    foreach ($path in @($ttsPython, $runtimePython, $vite, $electron, $astrbotExe,
        $astrbotPython, $astrbotPatch, (Join-Path $root 'run_astrbot.py'),
        (Join-Path $runtime 'app.py'), (Join-Path $runtime 'run_runtime.py'), (Join-Path $desktop 'main.js'),
        (Join-Path $tts 'voices.json'))) { Assert-File $path }
    if (-not $CheckOnly) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

    if ($TtsBackend -eq 'v3') {
        $v3Config = Get-Content (Join-Path $tts 'aqua_astrbot_config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        Assert-File $v3Config.gpt_model
        Assert-File $v3Config.sovits_model
    }
    if ($RestartTts -and -not $CheckOnly) {
        Get-CimInstance Win32_Process -Filter "name = 'python.exe'" |
            Where-Object { $_.CommandLine -like '*-m aquatts.server*' -or $_.CommandLine -like '*voice\v2pro_compat_server.py*' } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 2
    }
    if ($TtsBackend -eq 'v2pro') {
        if (Test-Http 'http://127.0.0.1:17880/health') {
            $active = Invoke-RestMethod 'http://127.0.0.1:17880/health'
            if ($active.backend -ne 'v2pro') { throw 'TTS backend differs; use -RestartTts to switch.' }
        }
        Start-Service 'v2pro-tts' $ttsPython '-u D:\KeiRuntime\voice\v2pro_compat_server.py' $runtime 'http://127.0.0.1:17880/health' 17880 600
    } else {
        if (Test-Http 'http://127.0.0.1:17880/health') {
            $active = Invoke-RestMethod 'http://127.0.0.1:17880/health'
            if ($active.backend -eq 'v2pro') { throw 'TTS backend differs; use -RestartTts to switch.' }
        }
        if (-not $CheckOnly) {
            & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tts 'aqua_tts_supervisor.ps1')
            if ($LASTEXITCODE -ne 0) { throw 'Shared Aqua-TTS startup failed.' }
        }
    }
    if (-not $CheckOnly) {
        & $astrbotPython $astrbotPatch
        if ($LASTEXITCODE -ne 0) { throw 'AstrBot compatibility patch failed; review the installed version before starting.' }
    }
    Start-Service 'astrbot' $astrbotPython ('-u "{0}" run' -f (Join-Path $root 'run_astrbot.py')) $astrbot 'http://127.0.0.1:6185/' 6185 180 @{
        KEI_ASTRBOT_LOG_PATH = (Join-Path $logDir "$runId-astrbot-live.log")
    }
    if (-not $env:ASTRBOT_API_KEY) { $env:ASTRBOT_API_KEY = [Environment]::GetEnvironmentVariable('ASTRBOT_API_KEY','User') }
    Start-Service 'runtime' $runtimePython '-u run_runtime.py' $runtime 'http://127.0.0.1:17881/docs' 17881 120 @{
        KEI_LOG_PATH = (Join-Path $logDir "$runId-runtime-live.log")
    }
    Start-Service 'live2d-vite' 'C:\Program Files\nodejs\npm.cmd' 'run start' $live2d 'http://127.0.0.1:5000/' 5000 120

    $existingDesktop = Get-CimInstance Win32_Process -Filter "name = 'electron.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*D:\KeiDesktop*' } | Select-Object -First 1
    if ($existingDesktop) { Write-Host "[running] Electron Desktop PID=$($existingDesktop.ProcessId)" }
    elseif ($CheckOnly) { Write-Host "[check] Electron Desktop can start: $electron ." }
    else {
        $out = Join-Path $logDir "$runId-desktop.out.log"
        $err = Join-Path $logDir "$runId-desktop.err.log"
        $p = Start-Process -FilePath $electron -ArgumentList $desktop -WorkingDirectory $desktop -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
        Start-Sleep -Seconds 3
        if ($p.HasExited) { throw "Electron Desktop exited early. Check $err" }
        Write-Host "[start] Electron Desktop PID=$($p.Id); logs: $out, $err"
    }
    Write-Host '[ok] Kei startup complete.'
    exit 0
} catch {
    Write-Error $_.Exception.Message
    exit 1
} finally {
    if ($startupLocked) { $startupMutex.ReleaseMutex() }
    $startupMutex.Dispose()
}

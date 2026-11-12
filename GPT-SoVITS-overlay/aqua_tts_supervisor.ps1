$ErrorActionPreference = 'Stop'
$repo = (Join-Path $env:USERPROFILE 'GPT-SoVITS')
$python = Join-Path $repo '.venv\Scripts\python.exe'
$logDir = Join-Path $repo 'shared-tts-logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$runId = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$mutex = New-Object System.Threading.Mutex($false, 'Local\KeiSharedAquaStartup')
$locked = $false
try {
    try { $locked = $mutex.WaitOne(660000) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another Aqua-TTS startup did not finish.' }
    Start-Process 'D:\KeiRuntime\.venv\Scripts\python.exe' -ArgumentList 'D:\KeiDesktop\log_retention.py' -WorkingDirectory 'D:\KeiDesktop' -WindowStyle Hidden
    $config = Get-Content (Join-Path $repo 'aqua_astrbot_config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($model in @($config.gpt_model, $config.sovits_model)) {
        if (-not (Test-Path -LiteralPath $model -PathType Leaf)) { throw "Missing model: $model" }
    }
    $env:PYTHONIOENCODING = 'utf-8'
    $env:GPT_SOVITS_HOME = $repo
    $env:AQUA_VOICE_JSON = Join-Path $repo 'voices.json'
    $env:AQUA_WARMUP_VOICE = 'kei'
    $env:ENABLE_CUDA_GRAPH = '1'
    foreach ($port in @(17880, 9880)) {
        $url = "http://127.0.0.1:$port/health"
        $ready = $false
        try { $ready = (Invoke-RestMethod $url -TimeoutSec 2).status -eq 'ok' } catch {}
        if ($ready) { Write-Host "[ready] Aqua-TTS port $port"; continue }
        $socket = New-Object System.Net.Sockets.TcpClient
        try { $socket.Connect('127.0.0.1', $port); $occupied = $true } catch { $occupied = $false } finally { $socket.Dispose() }
        if (-not $occupied) {
            if ($port -eq 17880) {
                $arguments = '-m aquatts.server --host 127.0.0.1 --port 17880 --gpt-model "{0}" --sovits-model "{1}" --cuda-graph-preset lazy --voice-registry "{2}"' -f $config.gpt_model, $config.sovits_model, $env:AQUA_VOICE_JSON
            } else {
                $arguments = '-u aqua_astrbot_server.py --host 127.0.0.1 --port 9880'
            }
            Start-Process $python -ArgumentList $arguments -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir "$runId-$port.out.log") -RedirectStandardError (Join-Path $logDir "$runId-$port.err.log") | Out-Null
        }
        $deadline = (Get-Date).AddSeconds(600)
        while ((Get-Date) -lt $deadline) {
            try { $ready = (Invoke-RestMethod $url -TimeoutSec 2).status -eq 'ok' } catch { $ready = $false }
            if ($ready) { break }
            Start-Sleep -Seconds 2
        }
        if (-not $ready) { throw "Aqua-TTS port $port did not become ready; see $logDir" }
        Write-Host "[ready] Aqua-TTS port $port"
    }
} catch {
    Write-Error $_
    exit 1
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}

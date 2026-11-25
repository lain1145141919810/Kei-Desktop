"""Local Windows SAPI TTS model provider (model-providers-v1)."""
import base64
import os
import subprocess
import tempfile
from pathlib import Path

MAX_BASE64 = 750000
SAFT_16KHZ_16BIT_MONO = 18
SSFM_CREATE_FOR_WRITE = 3

MODEL_LOCALES = {
    "sapi-ja-jp": "ja-JP",
    "sapi-zh-cn": "zh-CN",
    "sapi-en-us": "en-US",
}

LOCALE_LCIDS = {
    "ja": ("411",),
    "ja-jp": ("411",),
    "zh": ("804", "404", "c04"),
    "zh-cn": ("804",),
    "zh-tw": ("404",),
    "en": ("409", "809", "c09", "1009"),
    "en-us": ("409",),
    "en-gb": ("809",),
}

PS_SCRIPT = r"""
param([string]$TextFile, [string]$WavFile, [string]$Locale, [string]$VoiceHint, [int]$Rate, [int]$Volume)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled })
    $chosen = $null
    if ($VoiceHint) {
        $chosen = $voices | Where-Object { $_.VoiceInfo.Name -like "*$VoiceHint*" } | Select-Object -First 1
    }
    if (-not $chosen -and $Locale) {
        $chosen = $voices | Where-Object { $_.VoiceInfo.Culture.Name -ieq $Locale } | Select-Object -First 1
    }
    if (-not $chosen -and $Locale) {
        $lang = ($Locale -split '-')[0]
        $chosen = $voices | Where-Object { $_.VoiceInfo.Culture.TwoLetterISOLanguageName -ieq $lang } | Select-Object -First 1
    }
    if ($chosen) { $synth.SelectVoice($chosen.VoiceInfo.Name) }
    $synth.Rate = $Rate
    $synth.Volume = $Volume
    $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
        16000,
        [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
        [System.Speech.AudioFormat.AudioChannel]::Mono
    )
    $synth.SetOutputToWaveFile($WavFile, $fmt)
    $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
    $synth.Speak($text)
} finally {
    $synth.Dispose()
}
"""


def _target_locale(model, request_input, default_locale):
    if model in MODEL_LOCALES:
        return MODEL_LOCALES[model]
    locale = request_input.get("locale")
    if isinstance(locale, str) and locale.strip():
        return locale.strip()
    return default_locale


def _match_sapi_voice(voice_obj, locale, voice_hint):
    tokens = voice_obj.GetVoices()
    items = [tokens.Item(i) for i in range(tokens.Count)]
    if not items:
        raise RuntimeError("No Windows SAPI TTS voices are installed")
    if voice_hint:
        needle = voice_hint.strip().lower()
        for item in items:
            if needle in item.GetDescription().lower():
                return item
    if locale:
        norm = locale.lower()
        lcids = LOCALE_LCIDS.get(norm) or LOCALE_LCIDS.get(norm.split("-")[0], ())
        for target in lcids:
            for item in items:
                raw_lang = str(item.GetAttribute("Language") or "").lower()
                parts = [part.strip().lstrip("0") for part in raw_lang.split(";")]
                if target in parts:
                    return item
    return items[0]


def _synthesize_com(text, locale, voice_hint, rate, volume, wav_path):
    import pythoncom
    import win32com.client

    pythoncom.CoInitialize()
    try:
        sp_voice = win32com.client.Dispatch("SAPI.SpVoice")
        sp_voice.Voice = _match_sapi_voice(sp_voice, locale, voice_hint)
        sp_voice.Rate = int(rate)
        sp_voice.Volume = int(volume)
        stream = win32com.client.Dispatch("SAPI.SpFileStream")
        fmt = win32com.client.Dispatch("SAPI.SpAudioFormat")
        fmt.Type = SAFT_16KHZ_16BIT_MONO
        stream.Format = fmt
        stream.Open(str(wav_path), SSFM_CREATE_FOR_WRITE, False)
        try:
            sp_voice.AudioOutputStream = stream
            sp_voice.Speak(text)
        finally:
            stream.Close()
    finally:
        pythoncom.CoUninitialize()


def _synthesize_powershell(text, locale, voice_hint, rate, volume, wav_path, work_dir):
    system_root = os.environ.get("SystemRoot") or os.environ.get("WINDIR") or r"C:\Windows"
    powershell = Path(system_root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    if not powershell.is_file():
        raise RuntimeError("Windows PowerShell is unavailable for SAPI fallback")
    script_file = work_dir / "sapi_synth.ps1"
    if not script_file.is_file():
        script_file.write_text(PS_SCRIPT, encoding="utf-8")
    fd, txt_name = tempfile.mkstemp(prefix="kei-tts-", suffix=".txt", dir=work_dir)
    os.close(fd)
    txt_path = Path(txt_name)
    try:
        txt_path.write_text(text, encoding="utf-8")
        proc = subprocess.run(
            [
                str(powershell), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                "-File", str(script_file),
                "-TextFile", str(txt_path),
                "-WavFile", str(wav_path),
                "-Locale", locale or "",
                "-VoiceHint", voice_hint or "",
                "-Rate", str(int(rate)),
                "-Volume", str(int(volume)),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=False,
        )
        if proc.returncode != 0:
            raise RuntimeError("Windows SAPI PowerShell synthesis failed")
    finally:
        txt_path.unlink(missing_ok=True)


def initialize(context):
    cfg = context.config or {}
    default_locale = cfg.get("default_locale", "ja-JP")
    rate = cfg.get("rate", 0)
    volume = cfg.get("volume", 100)
    work_dir = Path(context.data_dir)
    work_dir.mkdir(parents=True, exist_ok=True)

    def synthesize(message):
        if os.name != "nt":
            raise RuntimeError("kei.windows-tts requires Windows SAPI")
        model = message["model"]
        request_input = message["input"]
        text = request_input["text"].strip()
        locale = _target_locale(model, request_input, default_locale)
        voice_hint = request_input.get("voice") or ""

        fd, wav_name = tempfile.mkstemp(prefix="kei-tts-", suffix=".wav", dir=work_dir)
        os.close(fd)
        wav_path = Path(wav_name)
        try:
            try:
                _synthesize_com(text, locale, voice_hint, rate, volume, wav_path)
            except ImportError:
                _synthesize_powershell(text, locale, voice_hint, rate, volume, wav_path, work_dir)
            raw = wav_path.read_bytes()
        finally:
            wav_path.unlink(missing_ok=True)

        if len(raw) < 44 or raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
            raise RuntimeError("Windows SAPI produced an invalid WAV stream")
        encoded = base64.b64encode(raw).decode("ascii")
        if len(encoded) > MAX_BASE64:
            raise ValueError("Synthesized WAV exceeds model-providers-v1 media limit")
        return {"audio": {"mime": "audio/wav", "base64": encoded}}

    context.register("tts.synthesize", synthesize)

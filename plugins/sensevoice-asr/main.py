"""Local CPU SenseVoice int8 ASR model provider via sherpa-onnx (model-providers-v1)."""
import base64
import io
import re
import wave
from pathlib import Path

TARGET_SR = 16000
TAG_PATTERN = re.compile(r"<\|[^|]*\|>")
SUPPORTED_LANGS = {"auto", "ja", "zh", "en", "ko", "yue"}


def _locale_to_language(locale, fallback):
    if isinstance(locale, str) and locale.strip():
        head = locale.strip().lower().replace("_", "-").split("-")[0]
        if head in SUPPORTED_LANGS:
            return head
    return fallback if fallback in SUPPORTED_LANGS else "auto"


def _resample_linear(samples, src_sr, dst_sr, np):
    if src_sr == dst_sr or samples.size == 0:
        return np.ascontiguousarray(samples, dtype=np.float32)
    dst_len = max(1, int(round(samples.size * dst_sr / src_sr)))
    x_old = np.linspace(0.0, 1.0, num=samples.size, endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=dst_len, endpoint=False)
    return np.ascontiguousarray(np.interp(x_new, x_old, samples), dtype=np.float32)


def _decode_wav(raw, np):
    with wave.open(io.BytesIO(raw), "rb") as reader:
        channels = reader.getnchannels()
        width = reader.getsampwidth()
        sample_rate = reader.getframerate()
        frames = reader.readframes(reader.getnframes())
    if sample_rate <= 0 or channels <= 0:
        raise ValueError("Invalid WAV audio parameters")
    if width == 1:
        pcm = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif width == 2:
        pcm = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        pcm = np.frombuffer(frames, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"Unsupported WAV sample width: {width}")
    if channels > 1:
        usable = pcm.size - (pcm.size % channels)
        pcm = pcm[:usable].reshape(-1, channels).mean(axis=1)
    duration_ms = int(round((pcm.size / sample_rate) * 1000))
    return _resample_linear(pcm, sample_rate, TARGET_SR, np), duration_ms


def _decode_compressed(raw, np):
    import av

    chunks = []
    resampler = av.AudioResampler(format="fltp", layout="mono", rate=TARGET_SR)
    with av.open(io.BytesIO(raw)) as container:
        for frame in container.decode(audio=0):
            for resampled in resampler.resample(frame):
                arr = resampled.to_ndarray()
                chunks.append(arr[0] if arr.ndim > 1 else arr)
    if not chunks:
        return np.empty(0, dtype=np.float32), 0
    samples = np.ascontiguousarray(np.concatenate(chunks), dtype=np.float32)
    duration_ms = int(round((samples.size / TARGET_SR) * 1000))
    return samples, duration_ms


def initialize(context):
    cfg = context.config or {}
    model_dir_str = str(cfg.get("model_dir", "") or "").strip()
    default_lang = str(cfg.get("default_language", "auto") or "auto")
    num_threads = int(cfg.get("num_threads", 4))
    use_itn = bool(cfg.get("use_itn", True))
    recognizers = {}

    def get_recognizer(language):
        if language in recognizers:
            return recognizers[language]
        if not model_dir_str:
            raise FileNotFoundError("Configure model_dir with SenseVoice model.int8.onnx and tokens.txt")
        root = Path(model_dir_str)
        model_file = root / "model.int8.onnx"
        tokens_file = root / "tokens.txt"
        if not model_file.is_file() or not tokens_file.is_file():
            raise FileNotFoundError("SenseVoice model.int8.onnx or tokens.txt is missing in model_dir")
        import sherpa_onnx

        rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(model_file),
            tokens=str(tokens_file),
            num_threads=num_threads,
            language=language,
            use_itn=use_itn,
        )
        recognizers[language] = rec
        return rec

    def transcribe(message):
        import numpy as np

        request_input = message["input"]
        audio = request_input["audio"]
        mime = audio["mime"]
        raw = base64.b64decode(audio["base64"], validate=True)
        if mime == "audio/wav":
            samples, duration_ms = _decode_wav(raw, np)
        else:
            samples, duration_ms = _decode_compressed(raw, np)
        if samples.size == 0:
            return {"text": "", "segments": []}
        language = _locale_to_language(request_input.get("locale"), default_lang)
        recognizer = get_recognizer(language)
        stream = recognizer.create_stream()
        stream.accept_waveform(TARGET_SR, samples)
        recognizer.decode_stream(stream)
        text = TAG_PATTERN.sub("", stream.result.text).strip()
        if not text:
            return {"text": "", "segments": []}
        return {
            "text": text,
            "segments": [{"text": text, "startMs": 0, "endMs": max(1, duration_ms)}],
        }

    context.register("asr.transcribe", transcribe)

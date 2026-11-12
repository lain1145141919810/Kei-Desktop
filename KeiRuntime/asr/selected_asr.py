"""Configurable CPU ASR with a visible, sticky Whisper fallback."""
import json
import os
import re
from pathlib import Path

from asr.faster_whisper_asr import FasterWhisperASR


class SelectedASR:
    _pcm_48k_to_16k = staticmethod(FasterWhisperASR._pcm_48k_to_16k)

    def __init__(self, fallback, config='D:/KeiRuntime/data/asr-engine.json'):
        self.fallback = fallback
        try:
            settings = json.loads(Path(config).read_text(encoding='utf-8'))
        except (OSError, ValueError):
            settings = {}
        if not isinstance(settings, dict):
            settings = {}
        self.requested = os.getenv('KEI_ASR_ENGINE', settings.get('engine', 'whisper'))
        if self.requested not in {'whisper', 'sensevoice'}:
            self.requested = 'whisper'
        self.active = self.requested
        self.recognizer = None
        self.error = None

    @property
    def model_size(self):
        return 'sensevoice-int8' if self.active == 'sensevoice' else self.fallback.model_size

    def health(self):
        return {'requested': self.requested, 'active': self.active,
                'model': self.model_size, 'fallback_reason': self.error,
                'hotwords_supported': self.active == 'whisper'}

    def _fallback(self, exc):
        self.error = type(exc).__name__
        self.active = 'whisper'
        self.recognizer = None
        print(f'[Kei ASR] SenseVoice unavailable; using Whisper: {self.error}', flush=True)
        self.fallback.load()

    def load(self):
        if self.active == 'whisper':
            self.fallback.load()
        elif self.recognizer is None:
            try:
                import sherpa_onnx
                root = Path('D:/KeiRuntime/models/sensevoice-int8')
                for name in ('model.int8.onnx', 'tokens.txt'):
                    if not (root/name).is_file():
                        raise FileNotFoundError(name)
                self.recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                    model=str(root/'model.int8.onnx'), tokens=str(root/'tokens.txt'),
                    num_threads=4, language='zh', use_itn=True)
                print('[Kei ASR] SenseVoice int8 CPU ready', flush=True)
            except Exception as exc:
                self._fallback(exc)

    def transcribe(self, pcm, *, sample_rate=48000):
        if sample_rate != 48000 or len(pcm) % 2:
            raise ValueError('Expected mono int16 PCM at 48000 Hz')
        if not pcm:
            return {'text':'', 'language':'zh', 'language_probability':None}
        self.load()
        if self.active == 'sensevoice':
            try:
                audio = FasterWhisperASR._pcm_48k_to_16k(pcm)
                if not audio.size:
                    return {'text':'', 'language':'zh', 'language_probability':None}
                stream = self.recognizer.create_stream()
                stream.accept_waveform(16000, audio)
                self.recognizer.decode_stream(stream)
                text = re.sub(r'<\|[^|]*\|>', '', stream.result.text).strip()
                return {'text':text, 'language':'zh', 'language_probability':None,
                        'segments':1, 'engine':'sensevoice'}
            except Exception as exc:
                self._fallback(exc)
        result = self.fallback.transcribe(pcm, sample_rate=sample_rate)
        return {**result, 'engine':'whisper'}

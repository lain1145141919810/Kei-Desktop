"""Transcribe one browser recording with a local faster-whisper model."""
import json
import sys
from faster_whisper import WhisperModel

model = WhisperModel(sys.argv[1], device="cpu", compute_type="int8")
segments, _ = model.transcribe(sys.argv[2], vad_filter=True)
print(json.dumps({"text": "".join(segment.text for segment in segments).strip()}))


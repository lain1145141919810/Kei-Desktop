"""Official GPT-SoVITS v2ProPlus inference with Kei's existing PCM contract."""
import os
import sys
import json
import io
import wave
import asyncio
import time
import logging
import anyio
from pathlib import Path

ROOT = Path(__file__).resolve().parent / 'gpt_sovits_v2pro' / 'GPT-SoVITS-main'
HOME = (Path.home() / "GPT-SoVITS")
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'GPT_SoVITS'))
import numpy as np
import torch
from scipy.signal import resample_poly
from math import gcd
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse, Response
from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

config = TTS_Config({'custom': {
    'device': 'cuda' if torch.cuda.is_available() else 'cpu',
    'is_half': torch.cuda.is_available(), 'version': 'v2ProPlus',
    't2s_weights_path': str(HOME / 'GPT_weights_v3/KaiYi-e15.ckpt'),
    'vits_weights_path': str(HOME / 'SoVITS_weights_v3/KaiYi_e18_s288.pth'),
    'bert_base_path': str(HOME / 'GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large'),
    'cnhuhbert_base_path': str(HOME / 'GPT_SoVITS/pretrained_models/chinese-hubert-base'),
}})
pipeline = TTS(config)
voices = {v['name']: v for v in json.loads((HOME / 'voices.json').read_text(encoding='utf-8'))}
lock = asyncio.Lock()
log = logging.getLogger('uvicorn.error')
app = FastAPI()

@app.get('/health')
def health():
    return {'status': 'ready', 'model_version': pipeline.configs.version,
            'gpt': config.t2s_weights_path, 'sovits': config.vits_weights_path,
            'sample_rate': 24000, 'dtype': 'float32', 'streaming': True,
            'backend': 'v2pro', 'min_chunk_length': 32, 'overlap_length': 4}

class ContinuousResampler:
    """Retain filter context so transport chunks cannot introduce resampling seams."""
    def __init__(self):
        self.source = np.empty(0, dtype=np.float32)
        self.sent = 0
        self.sr = None

    def push(self, sr, pcm, final=False):
        if self.sr is not None and sr != self.sr:
            raise RuntimeError('Sample rate changed within utterance')
        self.sr = sr
        self.source = np.concatenate((self.source, pcm))
        common = gcd(sr, 24000)
        out = resample_poly(self.source, 24000 // common, sr // common) if sr != 24000 else self.source
        end = len(out) if final else max(0, len(out) - 256)
        result = out[self.sent:end].astype('<f4').tobytes()
        self.sent = end
        return result

def next_chunk(generator):
    return next(generator, None)

@app.post('/tts')
async def synthesize(connection: Request, text: str, voice: str = 'kei', text_language: str = '日文',
               preset: str = 'balanced', chunk_size_seconds: float = 1.5):
    if voice not in voices:
        raise HTTPException(404, 'Unknown voice')
    v = voices[voice]
    languages = {'日文': 'ja', '中文': 'zh', '英文': 'en', 'ja': 'ja', 'zh': 'zh', 'en': 'en'}
    request = dict(text=text, text_lang=languages.get(text_language, 'ja'),
        ref_audio_path=v['ref_audio_path'], prompt_text=v['prompt_text'],
        prompt_lang=languages.get(v['prompt_language'], 'ja'),
        text_split_method='cut0', batch_size=1, top_k=8, top_p=0.87,
        temperature=0.5, speed_factor=1.0, parallel_infer=False,
        streaming_mode=True, return_fragment=False, fragment_interval=0.0,
        min_chunk_length=32, overlap_length=4, fixed_length_chunk=True, split_bucket=False)
    async def stream():
        async with lock:
            generator = pipeline.run(request)
            resampler = ContinuousResampler()
            started = time.perf_counter()
            count = 0
            audible = False
            try:
                while not await connection.is_disconnected():
                    chunk = await anyio.to_thread.run_sync(next_chunk, generator)
                    if chunk is None:
                        break
                    sr, pcm = chunk
                    samples = np.asarray(pcm, dtype=np.float32) / 32768.0
                    if not samples.size:
                        continue  # Official decoder may emit an empty final overlap fragment.
                    if not np.isfinite(samples).all():
                        raise RuntimeError('Invalid synthesis samples')
                    audible |= bool(np.max(np.abs(samples)) > 1e-5)
                    data = resampler.push(sr, samples)
                    count += 1
                    log.info('[Kei v2Pro] chunk=%s elapsed_ms=%s samples=%s', count,
                             round((time.perf_counter()-started)*1000), len(samples))
                    if data:
                        yield data
                else:
                    return
                if not audible:
                    raise RuntimeError('Synthesis produced no usable audio')
                tail = resampler.push(resampler.sr, np.empty(0, dtype=np.float32), final=True)
                if tail:
                    yield tail
                log.info('[Kei v2Pro] completed chunks=%s seconds=%.3f', count, resampler.sent/24000)
            finally:
                # Wait for the current GPU step before closing and releasing the model lock.
                with anyio.CancelScope(shield=True):
                    await anyio.to_thread.run_sync(generator.close)
                log.info('[Kei v2Pro] request released chunks=%s', count)
    return StreamingResponse(stream(), media_type='application/octet-stream')

@app.post('/tts/file')
async def synthesize_file(connection: Request, text: str, voice: str = 'kei',
                          text_language: str = '日文', preset: str = 'balanced'):
    # Use the same serialized decoder and continuous resampling as Runtime PCM.
    response = await synthesize(connection, text, voice, text_language, preset)
    chunks = [chunk async for chunk in response.body_iterator]
    samples = np.frombuffer(b''.join(chunks), dtype='<f4')
    if not samples.size or not np.isfinite(samples).all():
        raise HTTPException(500, 'No usable synthesis audio')
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype('<i2').tobytes()
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(pcm)
    return Response(output.getvalue(), media_type='audio/wav')

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=17880)

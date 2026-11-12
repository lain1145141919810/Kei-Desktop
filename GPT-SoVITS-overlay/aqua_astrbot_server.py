"""Expose Aqua-TTS to AstrBot and provide a local control panel."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel, Field

GPT_SOVITS_HOME = (Path.home() / "GPT-SoVITS")
GPT_WEIGHTS_DIR = GPT_SOVITS_HOME / "GPT_weights_v3"
SOVITS_WEIGHTS_DIR = GPT_SOVITS_HOME / "SoVITS_weights_v3"
CONFIG_PATH = GPT_SOVITS_HOME / "aqua_astrbot_config.json"
DEFAULT_GPT_MODEL = GPT_WEIGHTS_DIR / "key-e15.ckpt"
DEFAULT_SOVITS_MODEL = SOVITS_WEIGHTS_DIR / "key_e1_s353_l32.pth"
REF_AUDIO = GPT_SOVITS_HOME / "GPT_SoVITS" / "ref.wav"
PROMPT_TEXT = "言わなきゃいけないんですよね?......? ブルー アーカイブ"

DEFAULT_SETTINGS = {
    "top_k": 8,
    "top_p": 0.87,
    "temperature": 0.5,
    "speed": 0.95,
    "sample_steps": 16,
    "pause_second": 0.3,
    "cut_method": "按标点符号切",
}


class TuningSettings(BaseModel):
    """Runtime-adjustable synthesis values."""

    top_k: int = Field(8, ge=1, le=100)
    top_p: float = Field(0.87, gt=0, le=1)
    temperature: float = Field(0.5, gt=0, le=2)
    speed: float = Field(0.95, ge=0.5, le=2)
    sample_steps: int = Field(16, ge=4, le=32)
    pause_second: float = Field(0.3, ge=0, le=2)
    cut_method: Literal[
        "不切",
        "凑四句一切",
        "凑50字一切",
        "按中文句号。切",
        "按英文句号.切",
        "按标点符号切",
    ] = "按标点符号切"


class ModelSelection(BaseModel):
    """Paths selected from the local v3 weight folders."""

    gpt_model: str
    sovits_model: str


def load_config() -> dict:
    """Read persistent model and tuning settings, applying safe defaults."""
    config = {
        "gpt_model": str(DEFAULT_GPT_MODEL),
        "sovits_model": str(DEFAULT_SOVITS_MODEL),
        "settings": DEFAULT_SETTINGS.copy(),
    }
    if CONFIG_PATH.is_file():
        saved = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        config["gpt_model"] = saved.get("gpt_model", config["gpt_model"])
        config["sovits_model"] = saved.get("sovits_model", config["sovits_model"])
        config["settings"].update(saved.get("settings", {}))
    config["settings"] = TuningSettings(**config["settings"]).model_dump()
    return config


def save_config(state: dict) -> None:
    """Persist the selected models and tuning settings atomically."""
    payload = {
        "gpt_model": state["gpt_model"],
        "sovits_model": state["sovits_model"],
        "settings": state["settings"],
    }
    temp_path = CONFIG_PATH.with_suffix(".json.tmp")
    temp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temp_path.replace(CONFIG_PATH)


def validate_model_path(value: str, root: Path, suffix: str) -> Path:
    """Allow only an existing weight file inside its expected directory."""
    candidate = Path(value).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise HTTPException(400, f"Weight must be inside {root}") from exc
    if candidate.suffix.lower() != suffix or not candidate.is_file():
        raise HTTPException(400, f"Invalid weight file: {candidate}")
    return candidate


def build_app(inferencer, config: dict) -> FastAPI:
    """Build the AstrBot compatibility API and local control panel."""
    app = FastAPI(title="Aqua-TTS for AstrBot", version="2.0.0")
    inference_lock = asyncio.Lock()
    state = {
        "inferencer": inferencer,
        "gpt_model": config["gpt_model"],
        "sovits_model": config["sovits_model"],
        "settings": config["settings"],
    }

    def normalize_language(value: str | None) -> str:
        normalized = (value or "").strip().lower()
        if normalized in {"ja", "jp", "日文", "日语", "日本語"}:
            return "日文"
        if normalized in {"zh", "cn", "中文", "汉语", "漢語"}:
            return "中文"
        if normalized in {"en", "英文", "英语", "英語"}:
            return "英文"
        return value or "日文"

    @app.get("/", response_class=HTMLResponse)
    async def control_panel() -> str:
        return CONTROL_PANEL_HTML

    @app.get("/health")
    async def health() -> dict:
        try:
            async with httpx.AsyncClient(trust_env=False, timeout=5) as client:
                response = await client.get("http://127.0.0.1:17880/health")
                response.raise_for_status()
            return {**response.json(), "shared_backend": "http://127.0.0.1:17880"}
        except httpx.HTTPError as exc:
            raise HTTPException(503, "Shared Aqua-TTS backend unavailable") from exc

    @app.get("/api/config")
    async def get_config() -> dict:
        return {
            "gpt_model": state["gpt_model"],
            "sovits_model": state["sovits_model"],
            "gpt_models": [str(path) for path in sorted(GPT_WEIGHTS_DIR.glob("*.ckpt"))],
            "sovits_models": [str(path) for path in sorted(SOVITS_WEIGHTS_DIR.glob("*.pth"))],
            "settings": state["settings"],
        }

    @app.post("/api/settings")
    async def update_settings(settings: TuningSettings) -> dict:
        state["settings"] = settings.model_dump()
        save_config(state)
        return {"status": "ok", "settings": state["settings"]}

    @app.post("/api/models/select", status_code=202)
    async def select_models(selection: ModelSelection) -> dict:
        gpt_model = validate_model_path(selection.gpt_model, GPT_WEIGHTS_DIR, ".ckpt")
        sovits_model = validate_model_path(selection.sovits_model, SOVITS_WEIGHTS_DIR, ".pth")
        if str(gpt_model) == state["gpt_model"] and str(sovits_model) == state["sovits_model"]:
            return {"status": "unchanged", "restart": False}
        raise HTTPException(
            409, "Shared backend: change C:/Users/Lain/GPT-SoVITS/aqua_astrbot_config.json and restart Aqua-TTS; both clients use the same models"
        )

    @app.get("/set_gpt_weights")
    async def set_gpt_weights(weights_path: str = Query("")) -> dict:
        if weights_path and Path(weights_path).resolve() != Path(state["gpt_model"]).resolve():
            raise HTTPException(409, "Use the Aqua-TTS control panel to switch models")
        return {"status": "ok", "weights_path": state["gpt_model"]}

    @app.get("/set_sovits_weights")
    async def set_sovits_weights(weights_path: str = Query("")) -> dict:
        if weights_path and Path(weights_path).resolve() != Path(state["sovits_model"]).resolve():
            raise HTTPException(409, "Use the Aqua-TTS control panel to switch models")
        return {"status": "ok", "weights_path": state["sovits_model"]}

    @app.get("/tts")
    async def tts(
        text: str = Query(...),
        text_lang: str = Query("ja"),
        ref_audio_path: str = Query(""),
        prompt_text: str = Query(""),
        prompt_lang: str = Query("ja"),
    ) -> Response:
        """Synthesize one WAV using the query shape expected by AstrBot."""
        if not text.strip():
            raise HTTPException(400, "text must not be empty")
        reference = Path(ref_audio_path) if ref_audio_path else REF_AUDIO
        if not reference.is_file():
            raise HTTPException(400, f"Reference audio does not exist: {reference}")

        settings = state["settings"].copy()
        params = {
            "text": text,
            "ref_audio_path": str(reference),
            "prompt_text": prompt_text or PROMPT_TEXT,
            "text_language": normalize_language(text_lang),
            "prompt_language": normalize_language(prompt_lang),
            **settings,
        }
        try:
            async with inference_lock, httpx.AsyncClient(
                trust_env=False, timeout=httpx.Timeout(180, connect=5)
            ) as client:
                response = await client.post(
                    "http://127.0.0.1:17880/tts/file", params=params
                )
                response.raise_for_status()
        except httpx.TimeoutException as exc:
            raise HTTPException(504, "Shared Aqua-TTS synthesis timed out") from exc
        except httpx.HTTPError as exc:
            raise HTTPException(502, "Shared Aqua-TTS synthesis failed") from exc
        if not response.content.startswith(b"RIFF"):
            raise HTTPException(502, "Shared Aqua-TTS returned invalid WAV")
        return Response(content=response.content, media_type="audio/wav")

    return app


def main() -> None:
    """Run the lightweight compatibility proxy for the shared backend."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9880)
    args = parser.parse_args()
    config = load_config()
    gpt_model = validate_model_path(config["gpt_model"], GPT_WEIGHTS_DIR, ".ckpt")
    sovits_model = validate_model_path(config["sovits_model"], SOVITS_WEIGHTS_DIR, ".pth")
    if not REF_AUDIO.is_file():
        raise FileNotFoundError(REF_AUDIO)

    # This compatibility service never loads a second GPU model.
    import uvicorn

    config["gpt_model"] = str(gpt_model)
    config["sovits_model"] = str(sovits_model)
    uvicorn.run(build_app(None, config), host=args.host, port=args.port, log_level="info")


CONTROL_PANEL_HTML = r"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aqua-TTS 控制台</title>
<style>
:root{color-scheme:dark;--bg:#0c1017;--card:#151b25;--line:#293244;--text:#e9eef8;--muted:#98a5ba;--aqua:#54d6c2}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#172c36 0,transparent 32%),var(--bg);font:15px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:var(--text)}main{width:min(980px,calc(100% - 32px));margin:36px auto 60px}.head{display:flex;align-items:center;justify-content:space-between;margin-bottom:22px}.head h1{margin:0;font-size:28px;letter-spacing:.3px}.status{display:flex;gap:8px;align-items:center;color:var(--muted)}.dot{width:9px;height:9px;border-radius:50%;background:var(--aqua);box-shadow:0 0 15px var(--aqua)}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{background:linear-gradient(145deg,#171e29,#121822);border:1px solid var(--line);border-radius:16px;padding:22px;box-shadow:0 14px 36px #0005}.wide{grid-column:1/-1}h2{font-size:17px;margin:0 0 18px}.field{margin:14px 0}label{display:flex;justify-content:space-between;color:var(--muted);margin-bottom:7px}select,input,textarea,button{font:inherit}select,input[type=number],textarea{width:100%;color:var(--text);background:#0d131c;border:1px solid var(--line);border-radius:9px;padding:10px 12px;outline:none}select:focus,input:focus,textarea:focus{border-color:var(--aqua)}.range-row{display:grid;grid-template-columns:1fr 88px;gap:12px;align-items:center}input[type=range]{accent-color:var(--aqua);width:100%}button{border:0;border-radius:9px;padding:11px 16px;font-weight:700;cursor:pointer;background:var(--aqua);color:#06251f}button.secondary{background:#263248;color:var(--text)}button:disabled{opacity:.45;cursor:wait}.actions{display:flex;gap:10px;margin-top:18px}.note{color:var(--muted);font-size:13px;margin:10px 0 0}.message{min-height:23px;margin-top:12px;color:var(--aqua)}textarea{min-height:86px;resize:vertical}audio{width:100%;margin-top:14px}@media(max-width:720px){.grid{grid-template-columns:1fr}.wide{grid-column:auto}.head{align-items:flex-start;gap:14px;flex-direction:column}}
</style></head><body><main>
<div class="head"><div><h1>Aqua-TTS 控制台</h1><div class="note">GPT-SoVITS v3 · AstrBot 本地语音服务</div></div><div class="status"><span class="dot"></span><span id="status">正在连接</span></div></div>
<div class="grid">
<section class="card wide"><h2>模型组合</h2><div class="grid"><div class="field"><label>GPT 权重</label><select id="gpt"></select></div><div class="field"><label>SoVITS 权重</label><select id="sovits"></select></div></div><div class="actions"><button id="switch">切换模型并重启服务</button></div><p class="note">共享模型模式：请通过 QQ 端的 aqua_astrbot_config.json 切换并重启 Aqua-TTS，两端同时生效。</p><div class="message" id="modelMessage"></div></section>
<section class="card"><h2>采样参数</h2>
<div class="field"><label><span>Top-K</span><span>候选范围</span></label><div class="range-row"><input id="top_k_r" type="range" min="1" max="100" step="1"><input id="top_k" type="number" min="1" max="100"></div></div>
<div class="field"><label><span>Top-P</span><span>累计概率</span></label><div class="range-row"><input id="top_p_r" type="range" min="0.05" max="1" step="0.01"><input id="top_p" type="number" min="0.05" max="1" step="0.01"></div></div>
<div class="field"><label><span>Temperature</span><span>随机程度</span></label><div class="range-row"><input id="temperature_r" type="range" min="0.05" max="2" step="0.05"><input id="temperature" type="number" min="0.05" max="2" step="0.05"></div></div>
</section>
<section class="card"><h2>生成参数</h2>
<div class="field"><label><span>语速</span><span>Speed</span></label><div class="range-row"><input id="speed_r" type="range" min="0.5" max="2" step="0.05"><input id="speed" type="number" min="0.5" max="2" step="0.05"></div></div>
<div class="field"><label><span>采样步数</span><span>质量 / 速度</span></label><div class="range-row"><input id="sample_steps_r" type="range" min="4" max="32" step="1"><input id="sample_steps" type="number" min="4" max="32"></div></div>
<div class="field"><label><span>句间停顿</span><span>秒</span></label><div class="range-row"><input id="pause_second_r" type="range" min="0" max="2" step="0.05"><input id="pause_second" type="number" min="0" max="2" step="0.05"></div></div>
<div class="field"><label><span>长文本切句</span><span>防止吞句</span></label><select id="cut_method"><option>按标点符号切</option><option>凑50字一切</option><option>凑四句一切</option><option>不切</option></select></div>
</section>
<section class="card wide"><div class="actions"><button id="save">保存推理参数</button><button class="secondary" id="defaults">恢复推荐值</button></div><div class="message" id="settingsMessage"></div></section>
<section class="card wide"><h2>即时试听</h2><textarea id="testText">先生、お待たせしました。音声設定のテストです。</textarea><div class="actions"><button id="test">生成试听</button></div><div class="message" id="testMessage"></div><audio id="audio" controls></audio></section>
</div></main>
<script>
const ids=['top_k','top_p','temperature','speed','sample_steps','pause_second'];const recommended={top_k:8,top_p:.87,temperature:.5,speed:.95,sample_steps:16,pause_second:.3,cut_method:'按标点符号切'};
const gptSelect=document.getElementById('gpt'),sovitsSelect=document.getElementById('sovits'),statusText=document.getElementById('status');
const switchButton=document.getElementById('switch'),saveButton=document.getElementById('save'),defaultsButton=document.getElementById('defaults'),testButton=document.getElementById('test');
const modelMessageBox=document.getElementById('modelMessage'),settingsMessageBox=document.getElementById('settingsMessage'),testMessageBox=document.getElementById('testMessage');
const testTextBox=document.getElementById('testText'),audioPlayer=document.getElementById('audio');
function bindPair(id){const a=document.getElementById(id),r=document.getElementById(id+'_r');a.oninput=()=>r.value=a.value;r.oninput=()=>a.value=r.value}ids.forEach(bindPair);
function setValues(v){ids.forEach(id=>{document.getElementById(id).value=v[id];document.getElementById(id+'_r').value=v[id]});document.getElementById('cut_method').value=v.cut_method||'按标点符号切'}
function fillSelect(el,items,current){el.replaceChildren(...items.map(path=>{const o=document.createElement('option');o.value=path;o.textContent=path.split(/[\\/]/).pop();o.selected=path===current;return o}))}
async function load(){try{const r=await fetch('/api/config');if(!r.ok)throw Error(await r.text());const c=await r.json();fillSelect(gptSelect,c.gpt_models,c.gpt_model);fillSelect(sovitsSelect,c.sovits_models,c.sovits_model);setValues(c.settings);statusText.textContent='服务已连接'}catch(e){statusText.textContent='等待服务重启';setTimeout(load,2000)}}
defaultsButton.onclick=()=>setValues(recommended);
saveButton.onclick=async()=>{saveButton.disabled=true;settingsMessageBox.textContent='正在保存…';const body={};ids.forEach(id=>body[id]=Number(document.getElementById(id).value));body.cut_method=document.getElementById('cut_method').value;try{const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error(await r.text());settingsMessageBox.textContent='已保存，新请求立即生效'}catch(e){settingsMessageBox.textContent='保存失败：'+e.message}finally{saveButton.disabled=false}};
switchButton.onclick=async()=>{switchButton.disabled=true;modelMessageBox.textContent='正在保存模型组合…';try{const r=await fetch('/api/models/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gpt_model:gptSelect.value,sovits_model:sovitsSelect.value})});if(!r.ok)throw Error(await r.text());const d=await r.json();if(!d.restart){modelMessageBox.textContent='当前已经是这个组合';switchButton.disabled=false;return}modelMessageBox.textContent='服务正在重启并加载模型，请稍候…';statusText.textContent='正在重启';setTimeout(waitForRestart,2500)}catch(e){modelMessageBox.textContent='切换失败：'+e.message;switchButton.disabled=false}};
async function waitForRestart(){try{const r=await fetch('/health',{cache:'no-store'});if(!r.ok)throw Error();modelMessageBox.textContent='模型切换成功';switchButton.disabled=false;await load()}catch(e){setTimeout(waitForRestart,2000)}}
testButton.onclick=async()=>{testButton.disabled=true;testMessageBox.textContent='正在生成…';try{const q=new URLSearchParams({text:testTextBox.value,text_lang:'ja',prompt_lang:'ja'});const r=await fetch('/tts?'+q);if(!r.ok)throw Error(await r.text());audioPlayer.src=URL.createObjectURL(await r.blob());testMessageBox.textContent='试听已生成'}catch(e){testMessageBox.textContent='生成失败：'+e.message}finally{testButton.disabled=false}};
load();
</script></body></html>"""


if __name__ == "__main__":
    main()

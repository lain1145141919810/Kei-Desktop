const el = id => document.getElementById(id);
// The colour theme is chosen in the main window and shared through localStorage.
const applyTheme = () => { try { document.documentElement.dataset.theme = localStorage.getItem("kei-theme") || "hakuji"; } catch { /* default theme */ } };
applyTheme();
window.addEventListener("storage", applyTheme);
let busy = false;
async function refresh() {
    if (busy) return;
    busy = true;
    try {
        const [runtime, tts, qq] = await window.keiAdmin.health();
        el("runtime").textContent = runtime.ok
            ? `Runtime：オンライン\nDesktop 接続数：${runtime.desktopClients}\nモデル：${runtime.model || "会話の開始待ち"}\n設定元：${runtime.provider || "会話の開始待ち"}`
            : `Runtime：オフライン\n${runtime.error}`;
        el("runtime").className = runtime.ok ? "ok" : "bad";
        const asr = runtime.asr;
        el("asr").textContent = !runtime.ok ? "Runtime がオフラインのため認識できません" : asr
            ? `認識方式：${asr.mode === "streaming" ? "ストリーミング" : `${asr.engine?.active === "sensevoice" ? "SenseVoice int8" : "Whisper"}＋無音時の先行認識${asr.engine?.fallback_reason ? "（フォールバック：" + asr.engine.fallback_reason + "）" : ""}`}\n先行認識：${asr.enabled ? "オン" : "オフ"}\n無音しきい値：${asr.start_silence_ms} ms` : "状態を取得できません";
        const mic = runtime.microphone;
        el("mic").textContent = mic ? `収音：${mic.running && mic.stream_active ? "動作中" : "停止中"}\n受信フレーム：${mic.frames_received}\n最新フレームから：${mic.last_frame_age_ms ?? "—"} ms\n再起動回数：${mic.restart_count}` : "マイクの状態を取得できません";
        el("tts").textContent = `Aqua-TTS：${tts.ok ? "オンライン" : "オフライン"}\nウォームアップ：${tts.preset || "—"}\nQQ 互換 API：${qq.ok ? "オンライン" : "オフライン"}\nDesktop 再生：${runtime.playback ? "有効" : "無効"}`;
        el("tts").className = tts.ok ? "ok" : "bad";
        el("updated").textContent = `${new Date().toLocaleTimeString("ja-JP")} 更新`;
    } catch (error) { el("updated").textContent = `取得に失敗：${error.message}`; }
    finally { busy = false; }
}
const labels = {"user.speech.start":"発話を検出", "user.speech.end":"発話の終了を検出", "user.speech.audio_ready":"音声を送信", "asr.start":"認識開始", "user.transcript":"認識完了", "astrbot.request":"モデルに依頼", "assistant.reply":"返答を受信", "tts.request":"音声合成を依頼", "tts.start":"再生開始", "tts.end":"再生終了", "asr.error":"認識エラー", "tts.error":"音声エラー", "astrbot.error":"モデルエラー", "asr.empty":"文字を認識できず", "interrupt":"再生を中断"};
let stopped = false, socket, reconnect, timer;
function connect() {
    socket = new WebSocket("ws://127.0.0.1:17881/ws?client=kei-admin");
    socket.onopen = () => { el("connection").textContent = "接続済み"; };
    socket.onmessage = event => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === "user.transcript") el("transcript").textContent = data.text || "（空）";
            if (!labels[data.type]) return;
            const line = document.createElement("div");
            line.textContent = `${new Date().toLocaleTimeString("ja-JP")}  ${labels[data.type]}${data.payload?.status ? ` · ${data.payload.status}` : ""}`;
            el("events").append(line);
            while (el("events").childElementCount > 100) el("events").firstChild.remove();
            el("events").scrollTop = el("events").scrollHeight;
        } catch { /* Ignore unrelated malformed events. */ }
    };
    socket.onclose = () => {
        el("connection").textContent = "未接続・再試行中";
        if (!stopped) reconnect = setTimeout(connect, 3000);
    };
    socket.onerror = () => socket.close();
}
el("refresh").onclick = refresh;
el("logs").onclick = async () => { const error = await window.keiAdmin.logs(); if (error) el("updated").textContent = error; };
window.addEventListener("beforeunload", () => { stopped = true; clearTimeout(reconnect); clearInterval(timer); socket?.close(); });
refresh(); timer = setInterval(refresh, 3000); connect();

"use strict";
// Admin: モデル — per-capability provider selection for the Round 11 model registry
// (docs/model-providers.md). Uses only the admin bridge (list / select). Credentials are
// environment-variable names; values never reach this window.

(function () {
    const api = window.kei?.models;
    const $ = id => document.getElementById(id);
    if (!api || !$("models")) return;

    const CAPS = {
        tts: { name: "音声合成", sub: "TTS · ケイの声", icon: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>' },
        asr: { name: "音声認識", sub: "ASR · あなたの声を文字に", icon: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>' },
        vision: { name: "画像理解", sub: "Vision · 画面やファイルを見る", icon: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>' },
        embedding: { name: "埋め込み", sub: "Embedding · 記憶と検索", icon: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="9" cy="18" r="2"/><path d="M8 7l8 1M7.5 8l1.2 8M10.8 17l6-7.5"/>' },
    };
    const STATE = {
        ready: ["準備完了", "on"], unavailable: ["利用不可", "bad"], credential_unavailable: ["認証情報なし", "warn"], none: ["未選択", "off"],
    };
    const ERRORS = {
        model_unavailable: "このプロバイダーは使えません。プラグインを有効にし、権限を許可してください。",
        model_credential_reference_invalid: "認証情報の参照は環境変数名で入力してください（必要なプロバイダーのみ）。",
        model_selection_invalid: "選択内容が正しくありません。",
        model_capability_unknown: "不明な機能です。",
        forbidden: "このウィンドウからは変更できません。",
    };

    function el(tag, props = {}, ...children) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (value === undefined || value === null || value === false) continue;
            if (key === "class") node.className = value;
            else if (key === "text") node.textContent = value;
            else if (key === "dataset") Object.assign(node.dataset, value);
            else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
            else node.setAttribute(key, value === true ? "" : value);
        }
        node.append(...children.filter(c => c !== null && c !== undefined && c !== false));
        return node;
    }
    const icon = path => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true"); s.innerHTML = path; return s; };
    let toastTimer;
    function toast(text) {
        const node = $("toast");
        node.textContent = text;
        node.classList.add("visible");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => node.classList.remove("visible"), 3600);
    }

    let data = null;
    const drafts = {}; // capability -> { key, credentialRef } kept across refreshes while editing

    function card(capability) {
        const meta = CAPS[capability] || { name: capability, sub: "", icon: "" };
        const providers = (data.providers || []).filter(p => p.capability === capability);
        const selection = data.selections?.[capability] || null;
        const [stateText, tone] = STATE[selection?.state || "none"] || STATE.unavailable;
        const current = selection ? providers.find(p => p.pluginId === selection.pluginId) : null;

        const select = el("select", { "aria-label": `${meta.name}のプロバイダー`, dataset: { capability, role: "select" } },
            el("option", { value: "" }, providers.length ? "選んでください" : "対応するプラグインがありません"));
        for (const provider of providers) {
            for (const model of provider.models) {
                select.append(el("option", { value: `${provider.pluginId}\u0000${model}`, disabled: !provider.enabled },
                    `${provider.name} — ${model}${provider.enabled ? "" : "（無効）"}`));
            }
        }
        const draft = drafts[capability];
        select.value = draft?.key ?? (selection ? `${selection.pluginId}\u0000${selection.model}` : "");
        const cred = el("input", { type: "text", maxlength: "128", placeholder: "例：KEI_SPEECH_TOKEN", "aria-label": `${meta.name}の認証情報の参照（環境変数名）`, value: draft?.credentialRef ?? selection?.credentialRef ?? "", dataset: { role: "cred" } });
        const credField = el("label", { class: "field" }, "認証情報の参照（環境変数名）", cred);
        const chosen = () => {
            const [pluginId, model] = select.value.split("\u0000");
            return { provider: providers.find(p => p.pluginId === pluginId), pluginId, model };
        };
        const hint = el("p", { class: "model-hint", role: "status" });
        const save = el("button", { type: "button", class: "small", dataset: { role: "save" } }, "保存");
        const clear = el("button", { type: "button", class: "ghost small", disabled: !selection || saving.has(capability), dataset: { role: "clear" } }, "選択を解除");
        // Save is enabled only for a complete choice that differs from what is stored; the hint
        // says why it is not (nothing chosen, missing credential reference, unchanged).
        const sync = () => {
            const { provider, pluginId, model } = chosen();
            const needsCred = Boolean(provider?.requiresCredential);
            credField.hidden = !needsCred;
            const ref = needsCred ? cred.value.trim() : null;
            const unchanged = selection && selection.pluginId === pluginId && selection.model === model && (selection.credentialRef || null) === (ref || null);
            const why = saving.has(capability) ? "保存しています…"
                : !providers.length ? ""
                : !providers.some(p => p.enabled) ? "対応するプラグインが無効です。プラグインを有効にすると選べます。"
                : !provider ? "プロバイダーとモデルを選ぶと保存できます。"
                : needsCred && !ref ? "このプロバイダーには認証情報の参照（環境変数名）が必要です。"
                : unchanged ? "" : "未保存の変更があります。";
            save.disabled = saving.has(capability) || !provider || (needsCred && !ref) || Boolean(unchanged);
            save.textContent = saving.has(capability) ? "保存中…" : "保存";
            hint.textContent = why;
            hint.dataset.tone = why === "未保存の変更があります。" ? "pending" : "";
        };
        sync();
        const remember = () => { drafts[capability] = { key: select.value, credentialRef: cred.value }; };
        select.addEventListener("change", () => { remember(); sync(); });
        cred.addEventListener("input", () => { remember(); sync(); });
        save.addEventListener("click", async () => {
            const { provider, pluginId, model } = chosen();
            if (!provider) { toast("プロバイダーとモデルを選んでください。"); return; }
            const ref = provider.requiresCredential ? cred.value.trim() : null;
            if (provider.requiresCredential && !ref) { toast("このプロバイダーには認証情報の参照（環境変数名）が必要です。"); return; }
            await apply(capability, { pluginId, model, credentialRef: ref }, `${meta.name}：${provider.name} — ${model} を選びました`);
        });
        clear.addEventListener("click", () => apply(capability, { pluginId: null }, `${meta.name}の選択を解除しました`));

        return el("article", { class: "card model-card", dataset: { capability, state: selection?.state || "none" } },
            el("div", { class: "model-head" },
                el("span", { class: "model-icon" }, icon(meta.icon)),
                el("div", { class: "model-title" }, el("h2", { text: meta.name }), el("small", { text: meta.sub })),
                el("span", { class: `badge ${tone}`, text: stateText })),
            el("p", { class: "model-current" }, selection
                ? `${current?.name || selection.pluginId} — ${selection.model}${selection.credentialRef ? ` · 認証：${selection.credentialRef}` : ""}`
                : "まだ選ばれていません。"),
            el("label", { class: "field" }, "プロバイダーとモデル", select),
            credField,
            el("div", { class: "row" }, save, clear, hint));
    }

    const saving = new Set();
    async function apply(capability, selection, done) {
        if (saving.has(capability)) return; // a double click sends one request
        saving.add(capability);
        render();
        const reply = await api.select(capability, selection).catch(() => null);
        saving.delete(capability);
        if (!reply?.ok) { render(); toast(ERRORS[reply?.error?.code] || `変更できませんでした（${reply?.error?.code || "error"}）`); return; }
        delete drafts[capability];
        data = reply.value;
        render();
        toast(done);
    }

    function render() {
        const list = $("model-list");
        if (!data) return;
        const caps = Array.isArray(data.capabilities) ? data.capabilities : Object.keys(CAPS);
        // Keep keyboard focus on the same control of the same card across re-renders.
        const active = list.contains(document.activeElement) ? document.activeElement : null;
        const focus = active ? [active.closest(".model-card")?.dataset.capability, active.dataset.role] : null;
        list.replaceChildren(...caps.map(card));
        if (focus?.[0]) {
            const cardNode = list.querySelector(`.model-card[data-capability="${CSS.escape(focus[0])}"]`);
            let target = focus[1] ? cardNode?.querySelector(`[data-role="${focus[1]}"]`) : null;
            if (!target || target.disabled || target.closest("[hidden]")) target = cardNode?.querySelector('[data-role="select"]');
            target?.focus({ preventScroll: true });
        }
        const ready = caps.filter(c => data.selections?.[c]?.state === "ready").length;
        $("model-summary").textContent = `${caps.length} 種類 · 準備完了 ${ready} · プロバイダー ${new Set((data.providers || []).map(p => p.pluginId)).size} 件`;
        $("model-error").textContent = data.error ? "保存された選択を読み込めませんでした。もう一度選び直してください。" : "";
    }

    // DEF-01: only the newest request may render, so a failure that was sent before the host
    // came up can never overwrite the reply that arrived after it connected.
    let listSeq = 0;
    async function refresh() {
        const seq = ++listSeq;
        const reply = await api.list().catch(() => null);
        if (seq !== listSeq) return;
        if (!reply?.ok) {
            if (data) {
                // Keep the last known cards (and keyboard focus); say they are waiting.
                $("model-summary").textContent = "接続待ち · 再接続すると自動で更新します";
                return;
            }
            $("model-summary").textContent = "";
            $("model-list").replaceChildren(el("p", { class: "empty", role: "status",
                text: "Kei ホストに接続できないため、モデルを表示できません。接続すると自動で読み込みます。" }));
            return;
        }
        data = reply.value;
        render();
    }

    window.kei.plugins?.onChanged?.(() => refresh());
    $("refresh")?.addEventListener("click", refresh);
    refresh();

    // ---- Round 24: Direct chat service configuration (chat.json) inside モデル ----
    const chatApi = window.kei?.chatConfig;
    const chatCard = $("chat-config-card");
    if (!chatApi || !chatCard) return;

    const { errorText } = window.KeiPluginFrames || { errorText: c => c };
    const CHAT_PRESETS = {
        ollama: { endpoint: "http://127.0.0.1:11434/v1/chat/completions", model: "qwen2.5:7b", credentialRef: "", timeoutSeconds: 30 },
        lmstudio: { endpoint: "http://127.0.0.1:1234/v1/chat/completions", model: "local-model", credentialRef: "", timeoutSeconds: 30 },
        llamacpp: { endpoint: "http://127.0.0.1:8080/v1/chat/completions", model: "local-model", credentialRef: "", timeoutSeconds: 30 },
        https: { endpoint: "https://api.openai.com/v1/chat/completions", model: "", credentialRef: "OPENAI_API_KEY", timeoutSeconds: 30 },
    };
    const CHAT_STATE = {
        ready: ["準備完了", "on"],
        credential_unavailable: ["認証情報なし", "warn"],
        unconfigured: ["未設定", "off"],
    };

    const presetSel = $("chat-config-preset");
    const endpointIn = $("chat-config-endpoint");
    const modelIn = $("chat-config-model");
    const credIn = $("chat-config-cred");
    const timeoutIn = $("chat-config-timeout");
    const optionsIn = $("chat-config-options");
    const testBtn = $("chat-config-test");
    const saveBtn = $("chat-config-save");
    const clearBtn = $("chat-config-clear");
    const hintNode = $("chat-config-hint");
    const probeNode = $("chat-config-probe");
    const errNode = $("chat-config-error");

    let chatData = null;
    let chatDirty = false;
    let chatBusy = false;

    function chatFormPayload() {
        const parsedTimeout = Number.parseInt(timeoutIn.value, 10);
        return {
            endpoint: endpointIn.value.trim(),
            model: modelIn.value.trim(),
            credentialRef: credIn.value.trim() || null,
            timeoutSeconds: Number.isFinite(parsedTimeout) ? parsedTimeout : 30,
            extra_body: JSON.parse(optionsIn.value.trim() || "{}"),
        };
    }

    function renderChatConfig() {
        if (!chatData) return;
        const [label, tone] = CHAT_STATE[chatData.state] || CHAT_STATE.unconfigured;
        chatCard.dataset.state = chatData.state || "unconfigured";
        const badge = $("chat-config-badge");
        badge.textContent = label;
        badge.className = `badge ${tone}`;
        const sub = $("chat-config-sub");
        sub.textContent = `${chatData.configFileName || "chat.json"}${chatData.externalConfig ? "（外部指定）" : "（アクティブプロファイル）"} · 再起動なしで次の応答から反映`;
        const current = $("chat-config-current");
        if (chatData.configured) {
            const authDesc = chatData.credentialRef
                ? `認証参照：${chatData.credentialRef}（${chatData.credentialPresent ? "環境変数あり" : "環境変数未設定"}）`
                : (chatData.isLocalEndpoint ? "ローカル・キー不要" : "認証参照なし");
            current.textContent = `${chatData.model} — ${chatData.endpoint} · ${authDesc} · ${chatData.timeoutSeconds}s`;
        } else {
            current.textContent = "まだ設定されていません。下の欄にエンドポイントとモデルを入力して接続テスト・保存してください。";
        }
        const selectedPreset = presetSel.value;
        for (const option of presetSel.querySelectorAll("[data-imported-profile]")) option.remove();
        (chatData.profiles || []).forEach((profile, index) => {
            presetSel.append(el("option", { value: "imported:" + index, text: profile.model + " · " + new URL(profile.endpoint).hostname,
                dataset: { importedProfile: "true" } }));
        });
        presetSel.value = selectedPreset;
        if (!chatDirty) {
            optionsIn.value = JSON.stringify(chatData.extra_body || {});
            endpointIn.value = chatData.endpoint || "";
            modelIn.value = chatData.model || "";
            credIn.value = chatData.credentialRef || "";
            timeoutIn.value = String(chatData.timeoutSeconds || 30);
        }
        testBtn.disabled = chatBusy;
        saveBtn.disabled = chatBusy;
        clearBtn.disabled = chatBusy || !chatData.configured;
        hintNode.textContent = chatBusy ? "処理中…" : (chatDirty ? "未保存の変更があります。" : "");
        hintNode.dataset.tone = !chatBusy && chatDirty ? "pending" : "";
    }

    function showProbe(res) {
        if (!res) { probeNode.hidden = true; return; }
        probeNode.hidden = false;
        if (res.ok) {
            probeNode.dataset.tone = "ok";
            probeNode.textContent = `接続テスト成功（${res.latencyMs ?? "-"} ms · ${res.model}${res.isLocalEndpoint ? " · ローカル" : ""}）\n※到達確認のみです。実際の複数ターン会話・動作検証とは別です。`;
        } else {
            probeNode.dataset.tone = "bad";
            const msg = errorText(res.code) || res.message || res.code || "接続テストに失敗しました";
            const extra = res.credentialRef && res.credentialPresent === false
                ? `\n未設定の環境変数名：${res.credentialRef}`
                : (res.hint ? `\n確認ポイント：${res.hint}` : "");
            probeNode.textContent = `接続テスト失敗：${msg}（${res.code || "error"}）${extra}`;
        }
    }

    presetSel?.addEventListener("change", () => {
        const selection = presetSel.value;
        const preset = selection.startsWith("imported:")
            ? chatData?.profiles?.[Number(selection.slice(9))] : CHAT_PRESETS[selection];
        if (!preset) return;
        endpointIn.value = preset.endpoint;
        if (preset.model || !modelIn.value.trim()) modelIn.value = preset.model;
        credIn.value = preset.credentialRef || "";
        optionsIn.value = JSON.stringify(preset.extra_body || {});
        timeoutIn.value = String(preset.timeoutSeconds);
        chatDirty = true;
        errNode.textContent = "";
        probeNode.hidden = true;
        renderChatConfig();
    });

    for (const field of [endpointIn, modelIn, credIn, timeoutIn, optionsIn]) {
        field?.addEventListener("input", () => {
            chatDirty = true;
            errNode.textContent = "";
            renderChatConfig();
        });
    }

    testBtn?.addEventListener("click", async () => {
        if (chatBusy) return;
        chatBusy = true;
        errNode.textContent = "";
        probeNode.hidden = true;
        renderChatConfig();
        let payload;
        try {
            payload = chatFormPayload();
        } catch {
            chatBusy = false;
            renderChatConfig();
            errNode.textContent = "思考オプションを有効な JSON で入力してください。";
            return;
        }
        const reply = await chatApi.test(payload).catch(() => null);
        chatBusy = false;
        renderChatConfig();
        if (!reply?.ok) {
            errNode.textContent = errorText(reply?.error?.code) || `接続テストを実行できませんでした（${reply?.error?.code || "error"}）`;
            return;
        }
        showProbe(reply.value);
    });

    $("chat-config-form")?.addEventListener("submit", async event => {
        event.preventDefault();
        if (chatBusy) return;
        chatBusy = true;
        errNode.textContent = "";
        renderChatConfig();
        let payload;
        try {
            payload = chatFormPayload();
        } catch {
            chatBusy = false;
            renderChatConfig();
            errNode.textContent = "思考オプションを有効な JSON で入力してください。";
            return;
        }
        const reply = await chatApi.save(payload).catch(() => null);
        chatBusy = false;
        if (!reply?.ok) {
            renderChatConfig();
            errNode.textContent = errorText(reply?.error?.code) || `保存できませんでした（${reply?.error?.code || "error"}）`;
            return;
        }
        chatData = reply.value;
        chatDirty = false;
        renderChatConfig();
        toast(chatData.configured ? `会話モデルを保存しました（${chatData.model}）` : "会話モデルの設定を解除しました");
    });

    clearBtn?.addEventListener("click", async () => {
        if (chatBusy) return;
        chatBusy = true;
        errNode.textContent = "";
        probeNode.hidden = true;
        renderChatConfig();
        const reply = await chatApi.save({ clear: true }).catch(() => null);
        chatBusy = false;
        if (!reply?.ok) {
            renderChatConfig();
            errNode.textContent = errorText(reply?.error?.code) || "設定を解除できませんでした。";
            return;
        }
        chatData = reply.value;
        chatDirty = false;
        if (presetSel) presetSel.value = "custom";
        renderChatConfig();
        toast("会話モデルの設定を解除しました");
    });

    let chatSeq = 0;
    async function refreshChatConfig() {
        const seq = ++chatSeq;
        const reply = await chatApi.get().catch(() => null);
        if (seq !== chatSeq) return;
        if (!reply?.ok) {
            $("chat-config-current").textContent = "Kei ホストに接続できないため、会話モデル設定を読み込めません。接続すると自動で読み込みます。";
            return;
        }
        chatData = reply.value;
        renderChatConfig();
    }

    chatApi.onChanged?.(() => refreshChatConfig());
    $("refresh")?.addEventListener("click", refreshChatConfig);
    refreshChatConfig();

    // DEF-01: Admin opened before the host bound (KEI_OPEN_ADMIN=1) used to keep the error
    // until 今すぐ更新. Reload both panels whenever the host (re)connects, and mark them as
    // waiting when it drops. Unsaved chat edits survive (renderChatConfig honours chatDirty).
    let hostConnected = null;
    function onHostStatus(status) {
        const connected = Boolean(status?.connected);
        if (connected === hostConnected) return;
        const first = hostConnected === null;
        hostConnected = connected;
        // Any observed "connected" reloads (the broadcast may beat the initial status() reply);
        // the first "disconnected" needs nothing, the startup load above already failed visibly.
        if (connected || !first) {
            void refresh();
            void refreshChatConfig();
        }
    }
    window.kei.onStatus?.(onHostStatus);
    window.kei.status?.().then(reply => { if (reply?.ok) onHostStatus(reply.status); }).catch(() => {});
})();

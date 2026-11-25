"use strict";
// Round 09: Japanese chat (dialogue column, composer and 履歴 sheet from v0.3.2) on the host's
// core conversation API. The active conversation is owned by main; this view follows it and
// ignores any result for another conversation.

(function () {
    const kei = window.kei;
    if (!kei?.chat) return;
    const { errorText } = window.KeiPluginFrames;
    const $ = id => document.getElementById(id);

    let ephemeral = null;      // see window.KeiDialogue below
    let ephemeralTimer = null;
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
    const svg = markup => { const t = document.createElement("template"); t.innerHTML = markup; return t.content.firstChild; };

    // ---------------------------------------------------------------- DOM (v0.3.2 ids and classes)
    const toolbar = $("shell-toolbar");
    const backlogButton = el("button", { id: "backlog-button", class: "shell-button", type: "button", "aria-expanded": "false", "aria-controls": "backlog", title: "会話の履歴" },
        svg('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5h14v10H10l-5 4z"/><path d="M9 9h6M9 12h4"/></svg>'),
        el("span", { text: "履歴" }));
    toolbar.insertBefore(backlogButton, toolbar.firstChild);

    const input = el("textarea", { id: "composer-input", rows: "1", maxlength: "4000", spellcheck: "false", "aria-label": "ケイにメッセージを送る", placeholder: "ケイに話しかける…" });
    const sendButton = el("button", { id: "composer-send", type: "submit", "aria-label": "送信", title: "送信（Enter）" },
        svg('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13M12 6l6 6-6 6"/></svg>'));
    const cancelButton = el("button", { id: "composer-cancel", class: "sheet-tool", type: "button", hidden: true }, "中止");
    const status = el("div", { id: "composer-status", role: "status" });
    const composer = el("form", { id: "composer", class: "ui-panel", autocomplete: "off" }, input, cancelButton, sendButton, status);
    const echo = el("div", { id: "user-echo", class: "ui-panel", "aria-live": "polite" },
        el("span", { id: "user-echo-text" }),
        el("span", { class: "user-echo-wait", "aria-label": "ケイが考えています" }, el("i"), el("i"), el("i")));
    const line = el("div", { id: "subtitle-chinese", lang: "ja" });
    const subtitle = el("div", { id: "subtitle", class: "ui-panel", "aria-live": "polite" },
        el("div", { class: "dialogue-speaker" }, "ケイ ", el("span", { text: "KEI" })), line);
    const column = el("div", { id: "subtitle-container" }, echo, subtitle, composer);

    const backlogTitle = el("div", { id: "backlog-title", text: "今の会話" });
    const backBtn = el("button", { id: "backlog-back", class: "sheet-tool", type: "button", hidden: true }, "‹ 今の会話");
    const allBtn = el("button", { id: "backlog-all", class: "sheet-tool", type: "button" }, "すべての会話");
    const body = el("div", { id: "backlog-body" });
    const newBtn = el("button", { id: "backlog-new", class: "sheet-tool", type: "button" }, "新しい会話");
    const backlog = el("aside", { id: "backlog", "aria-label": "会話の履歴", "aria-hidden": "true" },
        el("header", { class: "backlog-header" }, backBtn,
            el("div", { class: "backlog-heading" }, el("div", { class: "backlog-kicker", text: "履歴" }), backlogTitle),
            allBtn, el("button", { id: "backlog-close", class: "sheet-tool", type: "button", onclick: () => setBacklog(false) }, "閉じる")),
        body,
        el("footer", { class: "backlog-footer" }, el("span", { text: "履歴は Kei ホストのデータフォルダに保存されます" }), newBtn));
    const scrim = el("div", { id: "backlog-scrim", "aria-hidden": "true", onclick: () => setBacklog(false) });
    $("window").append(column, scrim, backlog);

    // ---------------------------------------------------------------- state
    let active = null;
    let conversations = [];
    let view = "current";
    const turns = new Map(); // key: turnId, or requestId for unconfirmed sends
    let retrying = false;     // a composer/backlog retry request is in flight

    const search = el("input", { id: "backlog-search", type: "search", placeholder: "会話のタイトルで探す…", "aria-label": "会話を探す", autocomplete: "off" });
    const searchRow = el("label", { class: "backlog-search" }, search);
    search.addEventListener("input", () => renderBacklog());
    function dayLabel(ms) {
        const d = new Date(ms);
        const start = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        const diff = Math.round((start(new Date()) - start(d)) / 86400000);
        if (diff === 0) return "今日";
        if (diff === 1) return "昨日";
        return `${d.getMonth() + 1}月${d.getDate()}日（${"日月火水木金土"[d.getDay()]}）`;
    }
    const keyOf = t => t.turnId || `pending:${t.requestId}`;
    const ACTIVE = new Set(["queued", "running"]);
    const time = s => (s ? new Date(s * 1000).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "");

    function upsert(turn) {
        if (turn.turnId) turns.delete(`pending:${turn.requestId}`);
        turns.set(keyOf(turn), turn);
    }

    // A failed/cancelled turn that was retried is shown through its retry only.
    function visibleTurns() {
        const list = [...turns.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        const superseded = new Set(list.map(t => t.retryOf).filter(Boolean));
        return list.filter(t => !superseded.has(t.turnId));
    }

    function statusLine(t) {
        if (t.pending) return el("p", { class: "log-status warn" }, "送信を確認できませんでした。 ",
            el("button", { class: "sheet-tool", type: "button", "data-action": "resend", onclick: () => resend(t.requestId) }, "再送"));
        if (ACTIVE.has(t.status)) return el("p", { class: "log-status" }, "考えています…");
        if (t.status === "cancelled" || t.status === "failed") {
            return el("p", { class: "log-status bad" }, t.status === "cancelled" ? "中止しました。 " : `${errorText(t.error?.code)}（${t.error?.code}） `,
                el("button", { class: "sheet-tool", type: "button", "data-action": "retry", onclick: () => retry(t.turnId) }, "再試行"));
        }
        return null;
    }

    function entry(t) {
        const quote = t.selection ? el("p", { class: "log-quote" }, `選択：「${t.selection.text.length > 120 ? t.selection.text.slice(0, 120) + "…" : t.selection.text}」${t.selection.source ? `（${t.selection.source}${t.selection.page ? ` · ${t.selection.page} ページ` : ""}）` : ""}`) : null;
        return el("div", { class: "log-turn", dataset: { turnId: t.turnId || "", requestId: t.requestId, status: t.status } },
            el("div", { class: "log-entry log-user" },
                el("div", { class: "log-meta" }, el("span", { class: "log-name", text: "あなた" }), el("span", { text: time(t.createdAt) })),
                quote, el("p", { class: "log-text", text: t.question })),
            el("div", { class: "log-entry log-kei" },
                el("img", { class: "log-avatar", src: "../../../assets/kei-logo.png", alt: "", draggable: "false" }),
                el("div", { class: "log-body" },
                    el("div", { class: "log-meta" }, el("span", { class: "log-name", text: "ケイ" }), t.retryOf ? el("span", { text: "再試行" }) : null),
                    t.reply ? el("p", { class: "log-text", text: t.reply }) : null, statusLine(t))));
    }

    function renderBacklog() {
        backBtn.hidden = view !== "list";
        allBtn.hidden = view === "list";
        if (view === "list") {
            backlogTitle.textContent = "すべての会話";
            const needle = search.value.trim().toLowerCase();
            const shown = conversations.filter(c => !needle || (c.title || "新しい会話").toLowerCase().includes(needle));
            const groups = [];
            for (const c of shown) {
                const day = dayLabel(new Date(c.updatedAt).getTime());
                if (groups.at(-1)?.day !== day) groups.push({ day, items: [] });
                groups.at(-1).items.push(c);
            }
            body.replaceChildren(searchRow, ...(shown.length ? [] : [el("p", { class: "backlog-empty-sub", text: needle ? "一致する会話はありません。" : "保存された会話はありません。" })]),
                ...groups.flatMap(group => [el("div", { class: "log-day" }, el("span", { text: group.day })), ...group.items.map(c => el("button", {
                class: "backlog-item", type: "button", dataset: { conversationId: c.id }, "aria-current": c.id === active ? "true" : null,
                onclick: () => activate(c.id),
            }, el("div", { class: "backlog-item-head" },
                el("span", { class: "backlog-item-title", text: c.title || "新しい会話" }),
                el("span", { class: "backlog-item-meta", text: new Date(c.updatedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) }),
                c.id === active ? el("span", { class: "backlog-item-badge", text: "表示中" }) : null)))]));
            if (document.activeElement !== search && needle) search.focus();
            return;
        }
        const current = conversations.find(c => c.id === active);
        backlogTitle.textContent = current?.title || "今の会話";
        const list = visibleTurns();
        const rows = [];
        let lastDay = "";
        for (const t of list) {
            const day = dayLabel(t.createdAt ? t.createdAt * 1000 : Date.now());
            if (day !== lastDay) rows.push(el("div", { class: "log-day" }, el("span", { text: day })));
            lastDay = day;
            rows.push(entry(t));
        }
        body.replaceChildren(...(rows.length ? rows : [el("div", { class: "backlog-empty" },
            el("img", { src: "../../../assets/kei-logo.png", alt: "", draggable: "false" }),
            el("p", { text: "この会話はまだありません。" }), el("p", { class: "backlog-empty-sub", text: "下の入力欄からケイに話しかけてください。" }))]));
        body.scrollTop = body.scrollHeight;
    }

    function renderDialogue() {
        const list = visibleTurns();
        const last = list.at(-1);
        const busy = Boolean(last && (ACTIVE.has(last.status)));
        subtitle.dataset.replyStatus = last?.status ?? "";
        echo.classList.toggle("visible", Boolean(last));
        echo.classList.toggle("is-waiting", busy);
        $("user-echo-text").textContent = last ? last.question : "";
        const lastReply = [...list].reverse().find(t => t.reply);
        line.textContent = lastReply && lastReply === last ? lastReply.reply : (busy ? "" : lastReply?.reply || "");
        // A short shell line (greeting, timer) shows over the last reply but never while waiting.
        const aside = ephemeral && !busy ? ephemeral : null;
        if (aside) {
            line.textContent = aside;
            echo.classList.remove("visible");
        }
        subtitle.classList.toggle("is-aside", Boolean(aside));
        subtitle.classList.toggle("visible", Boolean(line.textContent));
        cancelButton.hidden = !busy;
        cancelButton.dataset.turnId = busy ? last.turnId : "";
        sendButton.disabled = busy || !input.value.trim();
        if (last?.pending) setStatus("送信を確認できませんでした。履歴から再送できます。", "error");
        else if (last && (last.status === "failed")) setStatus(`返答できませんでした：${errorText(last.error?.code)}`, "error", last.error?.code, last.turnId);
        else if (status.dataset.tone === "error" && !busy) setStatus("");
    }

    function render() { renderBacklog(); renderDialogue(); }

    // Short lines Kei says on her own (startup greeting, focus timer). Not part of the
    // conversation history and never sent to the model.
    window.KeiDialogue = {
        say(text, ms = 7000) {
            if (typeof text !== "string" || !text.trim()) return;
            ephemeral = text.trim().slice(0, 200);
            clearTimeout(ephemeralTimer);
            ephemeralTimer = setTimeout(() => { ephemeral = null; renderDialogue(); }, ms);
            renderDialogue();
        },
    };

    const SETUP_ERROR_CODES = new Set([
        "chat_provider_unconfigured",
        "chat_credential_unavailable",
        "chat_provider_unauthorized",
        "chat_connection_failed",
    ]);

    // Round 26: a failed turn can be retried from the composer, not only from 履歴. Retry is
    // always an explicit user action (never automatic: a failed turn may already have been
    // billed upstream). The status is rebuilt only when it changes so a focused 再試行 button
    // keeps keyboard focus across re-renders.
    let statusKey = "";
    function setStatus(text, tone, errorCode = null, retryTurnId = null) {
        const key = JSON.stringify([text, tone, errorCode, retryTurnId, retrying]);
        if (key === statusKey) return;
        const hadFocus = status.contains(document.activeElement) ? document.activeElement.dataset.action : null;
        statusKey = key;
        status.replaceChildren();
        if (text) status.append(document.createTextNode(text));
        if (tone === "error" && retryTurnId) {
            status.append(" ", el("button", {
                type: "button",
                class: "composer-status-action",
                dataset: { action: "retry-failed" },
                "aria-label": "失敗した返事をもう一度試す",
                disabled: retrying,
                onclick: () => void retry(retryTurnId, { fromComposer: true }),
            }, retrying ? "再試行中…" : "再試行"));
        }
        if (tone === "error" && errorCode && SETUP_ERROR_CODES.has(errorCode) && kei.openAdmin) {
            status.append(" ", el("button", {
                type: "button",
                class: "composer-status-action",
                dataset: { action: "open-chat-settings" },
                onclick: () => void kei.openAdmin("models"),
            }, "会話モデルを設定…"));
        }
        if (tone) status.dataset.tone = tone; else delete status.dataset.tone;
        if (hadFocus) status.querySelector(`[data-action="${hadFocus}"]:not([disabled])`)?.focus();
    }

    function setBacklog(open) {
        document.body.classList.toggle("backlog-open", open);
        backlog.setAttribute("aria-hidden", String(!open));
        backlogButton.setAttribute("aria-expanded", String(open));
        if (open) { view = "current"; render(); }
    }

    // ---------------------------------------------------------------- actions
    const speakable = new Set();
    const submittedAt = new Map(); // requestId -> performance.now() at submit (latency ledger)
    function noteSubmitted(response, at) {
        const requestId = response?.turn?.requestId ?? response?.requestId;
        if (!requestId) return;
        submittedAt.set(requestId, at);
        if (submittedAt.size > 50) submittedAt.delete(submittedAt.keys().next().value);
    }
    function speakCompleted(turn) {
        if (!turn || ["queued", "running", "unconfirmed"].includes(turn.status) || !speakable.delete(turn.requestId)) return;
        if (turn.status !== "completed" || turn.visualStale) return;
        window.KeiVoice?.readReply(turn.spokenReply, { requestId: turn.requestId, submittedAt: submittedAt.get(turn.requestId) ?? null });
    }

    function accept(response) {
        // Late answers for a conversation that is no longer shown are discarded.
        if (!response || response.conversationId !== active) return false;
        if (response.ok && response.turn?.requestId) {
            speakable.add(response.turn.requestId);
            const newest = turns.get(keyOf(response.turn));
            speakCompleted(newest?.status === "completed" ? newest : response.turn);
        }
        if (response.turn) upsert(response.turn);
        else if (response.pending) upsert({ pending: true, requestId: response.requestId, question: input.dataset.lastQuestion || "", status: "unconfirmed", createdAt: Date.now() / 1000 });
        return true;
    }

    async function send(event) {
        event?.preventDefault();
        const question = input.value;
        if (!question.trim()) return;
        clearTimeout(ephemeralTimer);
        ephemeral = null;
        sendButton.disabled = true;
        input.dataset.lastQuestion = question;
        const at = performance.now();
        const response = await kei.chat.send(question);
        noteSubmitted(response, at);
        if (accept(response) && response.ok) { input.value = ""; setStatus(""); }
        else if (response && !response.ok && !response.pending) setStatus(errorText(response.error?.code), "error", response.error?.code);
        render();
    }

    async function resend(requestId) {
        const response = await kei.chat.resend(requestId);
        accept(response);
        if (!response?.ok && !response?.pending) setStatus(errorText(response?.error?.code), "error");
        render();
    }

    async function retry(turnId, { fromComposer = false } = {}) {
        if (retrying) return; // one click = one new request
        retrying = true;
        window.KeiVoice?.stop();
        renderDialogue();
        const at = performance.now();
        let response = null;
        try {
            response = await kei.chat.retry(turnId).catch(() => null);
        } finally {
            retrying = false;
        }
        noteSubmitted(response, at);
        accept(response);
        if (!response?.ok && !response?.pending) setStatus(errorText(response?.error?.code), "error");
        render();
        if (fromComposer) input.focus();
    }

    async function cancel() {
        const turnId = cancelButton.dataset.turnId;
        if (!turnId) return;
        cancelButton.disabled = true;
        const response = await kei.chat.cancel(turnId);
        cancelButton.disabled = false;
        if (response?.ok && response.turn?.conversationId === active) upsert(response.turn);
        render();
    }

    async function load() {
        const response = await kei.chat.history().catch(() => null);
        if (!response?.ok || response.conversationId !== active) return;
        turns.clear();
        for (const t of response.turns) upsert(t);
        render();
    }

    function adopt(state) {
        if (!state?.ok) return;
        const changed = state.active !== active;
        active = state.active;
        conversations = state.conversations;
        document.body.dataset.conversationId = active;
        if (changed) { turns.clear(); speakable.clear(); setStatus(""); }
        render();
        if (changed) load();
    }

    async function activate(id) {
        adopt(await kei.chat.activate(id));
        view = "current";
        render();
    }

    composer.addEventListener("submit", () => { ephemeral = null; clearTimeout(ephemeralTimer); });
    composer.addEventListener("submit", send);
    input.addEventListener("keydown", event => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            composer.dispatchEvent(new Event("submit", { cancelable: true }));
        }
    });
    input.addEventListener("input", () => { sendButton.disabled = !input.value.trim() || !cancelButton.hidden; });
    cancelButton.addEventListener("click", cancel);
    backlogButton.addEventListener("click", () => setBacklog(!document.body.classList.contains("backlog-open")));
    allBtn.addEventListener("click", () => { view = "list"; renderBacklog(); });
    backBtn.addEventListener("click", () => { view = "current"; renderBacklog(); });
    newBtn.addEventListener("click", async () => { adopt(await kei.chat.newConversation()); view = "current"; render(); input.focus(); });
    document.addEventListener("keydown", event => { if (event.key === "Escape") setBacklog(false); });

    kei.chat.onTurn(({ conversationId, turn }) => {
        if (conversationId !== active) return; // late result for another conversation: discard
        upsert(turn);
        render();
        speakCompleted(turn);
    });
    kei.chat.onSwitched(adopt);
    kei.onStatus(s => { if (s.connected) load(); });
    kei.chat.state().then(adopt);
})();

"use strict";
// 作業 (background task sessions): toolbar chip + panel to start long tasks with an executor,
// watch progress, answer questions and cancel, while main keeps following them in the
// background. Kei announces completions, failures and questions.
(function () {
    const kei = window.kei;
    if (!kei?.sessions || !window.KeiShell) return;
    const $ = id => document.getElementById(id);
    const { errorText } = window.KeiPluginFrames;
    const STATUS = {
        queued: ["待機中", "wait"], running: ["実行中", "run"], waiting_for_input: ["確認待ち", "ask"], cancelling: ["中止要求済み", "wait"],
        succeeded: ["完了", "ok"], failed: ["失敗", "bad"], cancelled: ["中止済み", "off"],
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

    // ---- toolbar chip
    const chip = el("button", { id: "sessions-button", type: "button", class: "shell-button", title: "作業（実行エージェント）", "aria-expanded": "false", "aria-controls": "sessions-panel" });
    chip.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16v12H4z"/><path d="M9 7V5h6v2M4 12h16"/></svg>';
    const chipText = el("span", { text: "作業" });
    const chipBadge = el("span", { class: "count-badge", hidden: true });
    chip.append(chipText, chipBadge);
    ($("focus-button") || $("backlog-button"))?.after(chip);

    // ---- panel
    const executorSelect = el("select", { id: "sessions-executor", "aria-label": "実行エージェント" });
    const taskInput = el("textarea", { id: "sessions-input", rows: "3", maxlength: "8000", placeholder: "例：notes.txt を要約して、要点を 3 つにまとめて", "aria-label": "依頼内容" });
    const submit = el("button", { class: "pill primary", type: "submit" }, "依頼する");
    const formNote = el("div", { class: "popover-note", role: "status" });
    const form = el("form", { id: "sessions-form", autocomplete: "off" },
        el("div", { class: "sessions-form-row" }, executorSelect, submit), taskInput, formNote);
    const newBlock = el("details", { class: "sessions-new" }, el("summary", { text: "新しい作業を頼む" }), form);
    const list = el("div", { id: "sessions-list" });
    const summary = el("span", { id: "sessions-summary", class: "popover-note" });
    const clearDone = el("button", { class: "sheet-tool", type: "button", hidden: true }, "終わった作業を片付ける");
    const openAdmin = el("button", { class: "sheet-tool", type: "button" }, "管理ウィンドウで詳しく");
    const panel = el("section", { id: "sessions-panel", class: "popover ui-panel", "aria-label": "作業", hidden: true },
        el("div", { class: "sessions-head" }, el("div", { class: "popover-kicker", text: "作業" }), summary),
        newBlock, list,
        el("div", { class: "sessions-foot" }, clearDone, openAdmin));
    document.body.append(panel);
    window.KeiShell.addPopover(chip, panel);

    let snap = { sessions: [], running: 0, waiting: 0, finished: 0 };
    const confirming = new Set();
    const cancelling = new Set();
    const expanded = new Set();
    const drafts = new Map();

    function since(value) {
        const ms = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
        if (!Number.isFinite(ms)) return "";
        const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
        if (s < 60) return `${s} 秒前`;
        if (s < 3600) return `${Math.floor(s / 60)} 分前`;
        return `${Math.floor(s / 3600)} 時間前`;
    }

    function card(t) {
        const [label, tone] = STATUS[t.status] || [t.status, "off"];
        const active = ["queued", "running", "waiting_for_input", "cancelling"].includes(t.status);
        let progress = null;
        if (active && t.status !== "waiting_for_input") {
            const fill = el("i");
            if (t.percent !== null) fill.style.width = `${t.percent}%`; // CSSOM: allowed under style-src 'self'
            progress = el("div", { class: "sessions-progress", dataset: { indeterminate: String(t.percent === null) } }, fill);
        }
        const detail = t.status === "failed" ? `${errorText(t.error?.code)}（${t.error?.code}）${t.error?.mayHaveSideEffects ? " · 一部の操作が実行済みの可能性があります" : ""}`
            : t.status === "cancelling" ? "中止を要求しました（確認待ち）"
            : t.status === "succeeded" ? (t.result?.text ? t.result.text.split(/\n/)[0] : "完了しました")
            : t.status === "cancelled" ? "実行エージェントの中止を確認しました"
            : t.message || t.stage || (t.status === "queued" ? "開始を待っています" : t.status === "running" ? "作業しています…" : "");
        const actions = el("div", { class: "sessions-actions" });
        if (active && t.status !== "cancelling" && !cancelling.has(t.id)) {
            const confirm = confirming.has(t.id);
            actions.append(el("button", { class: "sheet-tool" + (confirm ? " sheet-danger" : ""), type: "button", dataset: confirm ? { confirm: "", focusKey: "cancel" } : { focusKey: "cancel" },
                onclick: async () => {
                    if (!confirming.has(t.id)) { confirming.add(t.id); render(); setTimeout(() => { confirming.delete(t.id); render(); }, 4000); return; }
                    confirming.delete(t.id);
                    cancelling.add(t.id);
                    render();
                    const reply = await kei.sessions.cancel(t.id).catch(() => null);
                    cancelling.delete(t.id);
                    if (!reply?.ok) window.KeiShell.toast(errorText(reply?.error?.code));
                    else if (!reply.accepted && !reply.confirmed && reply.task?.status !== "cancelling") {
                        window.KeiShell.toast("中止できませんでした。作業の状態を確認してください。");
                    }
                    render();
                } }, confirm ? "本当に中止する" : "中止"));
        }
        if (t.result?.text) {
            actions.append(el("button", { class: "sheet-tool", type: "button", "aria-expanded": String(expanded.has(t.id)), dataset: { focusKey: "result" }, onclick: () => { expanded.has(t.id) ? expanded.delete(t.id) : expanded.add(t.id); render(); } },
                expanded.has(t.id) ? "結果を閉じる" : "結果を見る"));
        }
        if (!active) actions.append(el("button", { class: "sheet-tool", type: "button", dataset: { focusKey: "dismiss" }, onclick: () => kei.sessions.dismiss(t.id) }, "片付ける"));

        let ask = null;
        if (t.status === "waiting_for_input" && t.inputRequest) {
            const input = el("input", { type: "text", maxlength: "4000", placeholder: "ここに答えを入力", "aria-label": "答え", value: drafts.get(t.id) || "" });
            input.addEventListener("input", () => drafts.set(t.id, input.value));
            ask = el("form", { class: "sessions-ask", autocomplete: "off", onsubmit: async event => {
                event.preventDefault();
                if (!input.value.trim()) return;
                const reply = await kei.sessions.answer(t.id, t.inputRequest.id, input.value).catch(() => null);
                if (reply?.ok) drafts.delete(t.id); else window.KeiShell.toast(errorText(reply?.error?.code));
            } }, el("p", { class: "sessions-prompt", text: t.inputRequest.prompt }), el("div", { class: "sessions-form-row" }, input,
                el("button", { class: "pill primary", type: "submit", dataset: { focusKey: "submit-answer" } }, "答える")));
        }
        return el("article", { class: "sessions-card", tabindex: "-1", "aria-label": `${t.title}：${label}`, dataset: { taskId: t.id, status: t.status, tone } },
            el("div", { class: "sessions-card-head" },
                el("span", { class: "sessions-dot" }),
                el("span", { class: "sessions-title", text: t.title, title: t.title }),
                el("span", { class: "sessions-badge", text: label })),
            el("div", { class: "sessions-meta" }, el("span", { text: t.executor }), el("span", { text: since(t.finishedAt || t.createdAt) }),
                t.result?.artifacts ? el("span", { text: `成果物 ${t.result.artifacts} 件` }) : null),
            progress,
            detail ? el("p", { class: "sessions-detail", text: detail }) : null,
            ask,
            expanded.has(t.id) && t.result?.text ? el("pre", { class: "sessions-result", text: t.result.text }) : null,
            actions.childElementCount ? actions : null);
    }

    function render() {
        // Host events re-render the list; keep keyboard focus on the same control of the same
        // task (or on the task card when that control is gone, e.g. after a cancel request).
        const focused = list.contains(document.activeElement) ? document.activeElement : null;
        const focusTask = focused?.closest("[data-task-id]")?.dataset.taskId;
        const focusKey = focused?.matches(".sessions-ask input") ? "answer" : focused?.dataset.focusKey || (focused?.matches(".sessions-card") ? "card" : null);
        const caret = focusKey === "answer" ? focused.selectionStart : null;
        list.replaceChildren(...(snap.sessions.length ? snap.sessions.map(card)
            : [el("p", { class: "sessions-empty", text: "進行中の作業はありません。上の「新しい作業を頼む」から、時間のかかる作業をケイに頼めます。" })]));
        if (focused && !list.contains(document.activeElement)) {
            const cardNode = focusTask ? list.querySelector(`[data-task-id="${CSS.escape(focusTask)}"]`) : null;
            const target = !cardNode ? null
                : focusKey === "answer" ? cardNode.querySelector(".sessions-ask input")
                : focusKey && focusKey !== "card" ? cardNode.querySelector(`[data-focus-key="${focusKey}"]`) : null;
            const next = target || cardNode || newBlock.querySelector("summary");
            next.focus({ preventScroll: true });
            if (target && caret !== null) target.setSelectionRange(caret, caret);
        }
        summary.textContent = [snap.running ? `実行中 ${snap.running}` : null, snap.waiting ? `確認待ち ${snap.waiting}` : null, snap.finished ? `完了 ${snap.finished}` : null].filter(Boolean).join(" · ") || "なし";
        clearDone.hidden = !snap.finished;
        const count = snap.running + snap.waiting;
        chipBadge.hidden = !count;
        chipBadge.textContent = String(count);
        chip.dataset.state = snap.waiting ? "ask" : count ? "run" : "idle";
        chip.title = snap.waiting ? "作業から確認があります" : count ? `作業 ${count} 件 実行中` : "作業（実行エージェント）";
        document.dispatchEvent(new CustomEvent("kei:sessions", { detail: snap }));
    }

    async function loadExecutors() {
        const reply = await kei.executors.list().catch(() => null);
        const executors = reply?.ok ? reply.executors : [];
        const previous = executorSelect.value;
        executorSelect.replaceChildren(...executors.map(e => el("option", { value: e.id, disabled: !e.available }, e.available ? e.name : `${e.name}（${errorText(e.reason) || "利用不可"}）`)));
        const first = executors.find(e => e.available);
        if (!first) executorSelect.prepend(el("option", { value: "", disabled: true }, "使える実行エージェントがありません"));
        executorSelect.value = executors.some(e => e.id === previous && e.available) ? previous : first?.id ?? "";
        submit.disabled = !first;
    }
    newBlock.addEventListener("toggle", () => { if (newBlock.open) { void loadExecutors(); taskInput.focus(); } });
    form.addEventListener("submit", async event => {
        event.preventDefault();
        const text = taskInput.value.trim();
        if (!text || !executorSelect.value) return;
        submit.disabled = true;
        formNote.textContent = "依頼しています…";
        const reply = await kei.sessions.submit(executorSelect.value, text).catch(() => null);
        submit.disabled = false;
        if (!reply?.ok) { formNote.textContent = errorText(reply?.error?.code); return; }
        taskInput.value = "";
        formNote.textContent = "";
        newBlock.open = false;
        window.KeiDialogue?.say("わかりました。終わったら知らせますね。", 5000);
    });
    clearDone.addEventListener("click", () => kei.sessions.dismiss("finished"));
    openAdmin.addEventListener("click", () => { window.KeiShell.closePopovers(); kei.openAdmin(); });

    const LINES = {
        succeeded: t => `作業が終わりました。「${t}」`,
        failed: t => `ごめんなさい、「${t}」はうまくいきませんでした。`,
        cancelled: t => `「${t}」を中止しました。`,
        input: (t, detail) => `確認させてください。${detail || t}`,
    };
    kei.sessions.onNotice(notice => {
        const short = notice.title.length > 24 ? notice.title.slice(0, 23) + "…" : notice.title;
        window.KeiDialogue?.say(LINES[notice.kind]?.(short, notice.detail) || short, notice.kind === "input" ? 12000 : 8000);
        window.KeiReactions?.work(notice.kind);
    });
    kei.sessions.onChanged(next => { if (next) { snap = next; render(); } });
    kei.sessions.list().then(reply => { if (reply?.ok) { snap = reply.value; render(); } }).catch(() => {});
    setInterval(() => { if (!panel.hidden) render(); }, 15000);
    // 小窓: a small pill while work is running or waiting for an answer.
    const mini = el("button", { id: "compact-sessions", type: "button", class: "ui-panel", title: "元の画面で作業を開く" }, el("i"), el("span"));
    mini.addEventListener("click", async () => { await kei.compact?.set(false); if (panel.hidden) chip.click(); });
    document.body.append(mini);
    document.addEventListener("kei:sessions", () => {
        mini.dataset.state = snap.waiting ? "ask" : snap.running ? "run" : "idle";
        mini.lastChild.textContent = snap.waiting ? `確認待ち ${snap.waiting}` : `作業中 ${snap.running}`;
    });
    window.KeiSessions = { snapshot: () => snap };
})();

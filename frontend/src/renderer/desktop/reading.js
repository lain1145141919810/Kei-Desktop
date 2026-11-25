"use strict";
// Round 09: the Japanese 読書 sheet. It hosts the kei.pdf "reading" page (plans, progress,
// notes and selected-text Q&A) and the trusted selection input. A selection reaches the page
// only after main has vetted it for that page and the active conversation.

(function () {
    const kei = window.kei;
    if (!kei?.reading) return;
    const { PluginFrameHost, errorText } = window.KeiPluginFrames;
    const $ = id => document.getElementById(id);

    function el(tag, props = {}, ...children) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (value === undefined || value === null || value === false) continue;
            if (key === "class") node.className = value;
            else if (key === "text") node.textContent = value;
            else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
            else node.setAttribute(key, value === true ? "" : value);
        }
        node.append(...children.filter(c => c !== null && c !== undefined && c !== false));
        return node;
    }
    const svg = markup => { const t = document.createElement("template"); t.innerHTML = markup; return t.content.firstChild; };

    const toolbar = $("shell-toolbar");
    const button = el("button", { id: "reading-button", class: "shell-button", type: "button", "aria-expanded": "false", "aria-controls": "reading", title: "読書：PDF の質問と読書プラン" },
        svg('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 6c-2-1.3-4.5-1.6-7-1v13c2.5-.6 5-.3 7 1 2-1.3 4.5-1.6 7-1V5c-2.5-.6-5-.3-7 1zM12 6v13"/></svg>'),
        el("span", { text: "読書" }));
    toolbar.insertBefore(button, $("extension-button"));

    const passage = el("textarea", { id: "reading-passage", rows: "4", maxlength: "12000", placeholder: "PDF で選択した文章を貼り付け", "aria-label": "質問したい文章" });
    const page = el("input", { id: "reading-page", type: "number", min: "1", max: "20000", placeholder: "ページ（任意）", "aria-label": "ページ（任意）" });
    const forwardBtn = el("button", { id: "reading-forward", class: "pill primary", type: "button" }, "この文章で質問する");
    const externalBtn = el("button", { id: "reading-read-external", class: "pill", type: "button", title: "ほかのアプリで選択中の文章を読み込みます（Ctrl + Alt + Q）" }, "選択中の文章を読み込む");
    const status = el("p", { id: "reading-status", class: "popover-note", role: "status" });
    const frameBox = el("div", { id: "reading-frame" });
    const placeholder = el("p", { id: "reading-unavailable", class: "popover-note", hidden: true }, errorText("reading_unavailable"));
    const sheet = el("aside", { id: "reading", class: "sheet", "aria-label": "読書", "aria-hidden": "true" },
        el("header", { class: "backlog-header" },
            el("div", { class: "backlog-heading" }, el("div", { class: "backlog-kicker", text: "読書" }), el("div", { class: "sheet-title", text: "読書" })),
            el("button", { id: "reading-close", class: "sheet-tool", type: "button", onclick: () => setOpen(false) }, "閉じる")),
        el("div", { class: "sheet-body" },
            el("section", { class: "reading-section" },
                el("h3", { text: "いま読んでいるところ" }),
                el("p", { class: "popover-note", text: "PDF で文章を選択して Ctrl + Alt + Q を押すか、コピーしてここに貼り付けてください。選んだ文章は、いま表示中の会話だけに送られます。" }),
                passage,
                el("div", { class: "reading-row" }, page, forwardBtn, externalBtn),
                status),
            el("section", { class: "reading-section reading-plugin" }, placeholder, frameBox)));
    const scrim = el("div", { id: "reading-scrim", "aria-hidden": "true", onclick: () => setOpen(false) });
    $("window").append(scrim, sheet);

    let mounted = null;
    let pending = null;
    let version = 0;
    const frames = new PluginFrameHost(kei, {
        onClosed: (info, reason, text) => {
            if (mounted?.tag !== info.tag) return;
            mounted = null;
            delete sheet.dataset.frameTag;
            if (reason === "conversation_changed") clearSelection();
            else if (reason !== "user") say(text);
        },
    });

    const isOpen = () => document.body.classList.contains("reading-open");
    const conversation = () => document.body.dataset.conversationId;
    function say(text, tone) { status.textContent = text || ""; if (tone) status.dataset.tone = tone; else delete status.dataset.tone; }

    function clearSelection() {
        passage.value = "";
        page.value = "";
        say("");
    }

    async function openFrame(expectedVersion) {
        const entries = await kei.entries().catch(() => null);
        if (version !== expectedVersion) return null;
        const available = entries?.ok && entries.entries.some(e => e.pluginId === "kei.pdf" && e.id === "reading");
        placeholder.hidden = Boolean(available);
        if (!available) return null;
        try {
            const info = await frames.mount(frameBox, "kei.pdf", "reading");
            if (version !== expectedVersion) {
                await frames.close(info.tag);
                return null;
            }
            mounted = info;
            sheet.dataset.frameTag = info.tag;
            return mounted;
        } catch (error) {
            if (version === expectedVersion) say(error.message, "error");
            return null;
        }
    }

    async function mount() {
        if (mounted) return mounted;
        if (pending?.version === version) return pending.promise;
        const attempt = { version, promise: openFrame(version) };
        pending = attempt;
        try { return await attempt.promise; }
        finally { if (pending === attempt) pending = null; }
    }

    async function setOpen(open) {
        document.body.classList.toggle("reading-open", open);
        sheet.setAttribute("aria-hidden", String(!open));
        button.setAttribute("aria-expanded", String(open));
        if (open) await mount();
    }

    async function forward(selection, note = "") {
        const expectedVersion = version;
        // Blocked here first; main checks again before the page can receive it.
        if (typeof selection?.text !== "string" || !selection.text.trim()) { say(errorText("empty_selection"), "error"); return false; }
        const target = await mount();
        if (version !== expectedVersion) return false;
        if (!target) { say(errorText("reading_unavailable"), "error"); return false; }
        const response = await kei.reading.forward(target.tag, selection);
        if (version !== expectedVersion || mounted !== target) return false;
        if (!response?.ok) { say(errorText(response?.error?.code), "error"); return false; }
        if (!frames.sendSelection(target.tag, response.selection)) return false;
        say(`選択した文章を読書ページに渡しました（${response.selection.text.length} 文字${response.selection.page ? ` · ${response.selection.page} ページ` : ""}）。${note}`);
        return true;
    }

    forwardBtn.addEventListener("click", () => forward({ text: passage.value, source: "貼り付けた文章", page: page.value || null }));
    externalBtn.addEventListener("click", () => kei.reading.readExternal());
    button.addEventListener("click", () => setOpen(!isOpen()));
    document.addEventListener("keydown", event => { if (event.key === "Escape" && isOpen()) setOpen(false); });
    kei.reading.onSelected(async payload => {
        if (payload.conversationId !== conversation()) return;
        const expectedVersion = version;
        await setOpen(true);
        if (version !== expectedVersion || payload.conversationId !== conversation()) return;
        if (payload.error) { say(errorText(payload.error), "error"); return; }
        passage.value = payload.selection.text;
        await forward(payload.selection, payload.synthetic ? "（テスト用の合成選択）" : "");
    });
    kei.chat.onSwitched(() => {
        version++;
        clearSelection();
        if (mounted) void frames.close(mounted.tag);
        if (isOpen()) void mount();
    });
    kei.onEntriesChanged(() => { if (isOpen() && !mounted) mount(); });
})();

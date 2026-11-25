"use strict";
// Desktop window: extension menu (slot "extensions"), plugin page sheet, host status,
// and the placeholder character stage.

(function () {
    const kei = window.kei;
    const $ = id => document.getElementById(id);
    const { PluginFrameHost, errorText } = window.KeiPluginFrames;

    // ---------------------------------------------------------------- toast
    let toastTimer;
    function toast(text) {
        if (!text) return;
        const node = $("shell-toast");
        node.textContent = text;
        node.classList.add("visible");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => node.classList.remove("visible"), 3200);
    }

    // ---------------------------------------------------------------- popovers
    const popovers = [
        [$("extension-button"), $("extension-panel")],
        [$("quick-button"), $("quick-panel")],
    ];
    // Closing a popover that holds the focus hands it back to its toolbar button, so keyboard
    // users are not dropped onto <body>.
    function closePopovers(except) {
        for (const [button, panel] of popovers) {
            if (panel === except || panel.hidden) continue;
            const hadFocus = panel.contains(document.activeElement);
            panel.hidden = true;
            panel.inert = true;
            button.setAttribute("aria-expanded", "false");
            if (hadFocus) button.focus({ preventScroll: true });
        }
    }
    function bindPopover(button, panel) {
        panel.inert = panel.hidden;
        button.addEventListener("click", event => {
            const open = panel.hidden;
            closePopovers(panel);
            panel.hidden = !open;
            panel.inert = !open;
            button.setAttribute("aria-expanded", String(open));
            if (open && panel.id === "extension-panel") {
                // Opened from the keyboard (Enter / Space report detail 0): move into the menu.
                const fromKeyboard = event.detail === 0;
                refreshEntries().then(() => {
                    if (fromKeyboard && !panel.hidden && !$("extension-list").contains(document.activeElement)) focusMenuItem(0);
                });
                if (fromKeyboard) focusMenuItem(0);
            }
        });
    }
    for (const [button, panel] of popovers) bindPopover(button, panel);
    // Small shared surface for the other desktop scripts (focus chip, overview).
    window.KeiShell = {
        toast,
        closePopovers: () => closePopovers(),
        addPopover(button, panel) { popovers.push([button, panel]); bindPopover(button, panel); },
    };
    document.addEventListener("keydown", event => {
        if (event.key === "Escape") closePopovers();
    });

    // Arrow-key navigation inside the extension menu (role="menu").
    function menuItems() { return [...$("extension-list").querySelectorAll(".menu-item")]; }
    function focusMenuItem(index) {
        const items = menuItems();
        if (!items.length) return;
        items[(index + items.length) % items.length].focus();
    }
    $("extension-list").addEventListener("keydown", event => {
        const items = menuItems();
        const at = items.indexOf(document.activeElement);
        const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
        if (move === undefined || !items.length) return;
        event.preventDefault();
        focusMenuItem(at < 0 && event.key === "ArrowUp" ? -1 : move);
    });
    document.addEventListener("pointerdown", event => {
        if (!event.target.closest(".popover, #shell-toolbar")) closePopovers();
    });

    // ---------------------------------------------------------------- theme
    function syncThemeButtons() {
        for (const button of $("quick-themes").querySelectorAll("button")) {
            button.setAttribute("aria-pressed", String(button.dataset.themeId === window.KeiTheme.current()));
        }
    }
    $("quick-themes").addEventListener("click", event => {
        const button = event.target.closest("button[data-theme-id]");
        if (button) window.KeiTheme.set(button.dataset.themeId);
    });
    document.addEventListener("kei:theme", syncThemeButtons);
    syncThemeButtons();

    $("admin-button").addEventListener("click", () => { closePopovers(); kei.openAdmin(); });

    // ---------------------------------------------------------------- Round 08: screen observation
    const STOP_REASON = {
        user: "停止しました", page_closed: "観察ページを閉じたため停止しました", "plugin.disabled": "プラグインが無効になったため停止しました",
        "plugin.reloaded": "プラグインを再読み込みしたため停止しました", "plugin.uninstalled": "プラグインが削除されたため停止しました",
        host_unavailable: "ホストとの接続が切れたため停止しました", source_unavailable: "観察対象が見つからなくなったため停止しました",
        conversation_changed: "会話が切り替わったため停止しました", capture_closed: "観察対象が無効になったため停止しました",
    };
    let lastStopShown = null;
    function renderCapture(status) {
        const on = Boolean(status?.active);
        $("capture-toggle").setAttribute("aria-checked", String(on));
        $("capture-toggle").disabled = Boolean(status?.starting);
        $("capture-dot").hidden = !on;
        $("capture-status").textContent = status?.starting ? "観察対象を選んでいます…"
            : on ? `観察中：${status.source.name}${status.captures ? `（${status.captures} 回）` : ""}` : "停止中";
        const stop = status?.lastStop;
        if (!on && stop && stop.at !== lastStopShown) {
            lastStopShown = stop.at;
            if (stop.reason !== "user") toast(`画面観察：${STOP_REASON[stop.reason] || stop.reason}`);
        }
    }
    $("capture-toggle").addEventListener("click", async () => {
        const response = await kei.captureToggle();
        if (!response?.ok && response?.error?.code !== "user_cancelled") toast(`画面観察：${errorText(response?.error?.code)}`);
        if (response?.status) renderCapture(response.status);
    });
    kei.capture.onStatus(renderCapture);
    kei.capture.status().then(r => r?.ok && renderCapture(r.status));
    $("minimize-button").addEventListener("click", () => kei.window("minimize"));
    $("power-button").addEventListener("click", () => kei.window("close"));

    // ---------------------------------------------------------------- host status
    function renderStatus(status) {
        const node = $("status");
        if (status.connected) {
            node.dataset.state = "online";
            $("connection-text").textContent = "Kei ホスト接続済み";
            $("quick-host-status").textContent = `接続済み · インストール済みプラグイン ${status.installed ?? 0} 件`;
        } else {
            node.dataset.state = status.error ? "offline" : "pending";
            $("connection-text").textContent = status.error ? "Kei ホスト未接続" : "接続中…";
            $("quick-host-status").textContent = status.error ? errorText(status.error) : "確認中…";
        }
    }
    kei.onStatus(renderStatus);
    kei.status().then(response => response?.ok && renderStatus(response.status));

    // ---------------------------------------------------------------- extension entries
    let entries = [];
    let current = null; // { tag, pluginId, entryId }
    let entriesState = "loading"; // loading | ready | offline | error
    let openSeq = 0;
    let pending = null; // { seq, pluginId, entryId } while pages.open is in flight
    let returnFocus = null; // where focus goes back to when the sheet closes
    let hostOnline = null;
    const entryKey = (pluginId, entryId) => `${pluginId}\u0000${entryId}`;
    const EMPTY_NOTE = {
        loading: "拡張機能を確認しています…",
        offline: "Kei ホストに接続していないため、拡張機能を表示できません。接続すると自動で表示されます。",
        error: "拡張機能の一覧を読み込めませんでした。もう一度開くと再試行します。",
        ready: "有効な拡張機能はありません。管理ウィンドウの「プラグイン」でインストールして有効にすると、ここに表示されます。",
    };

    function renderEntries() {
        const list = $("extension-list");
        const focusedKey = list.contains(document.activeElement)
            ? entryKey(document.activeElement.dataset.pluginId, document.activeElement.dataset.entryId) : null;
        list.replaceChildren();
        const visible = entries.filter(entry => entry.slot === "extensions");
        for (const entry of visible) {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "menu-item";
            item.setAttribute("role", "menuitem");
            item.dataset.pluginId = entry.pluginId;
            item.dataset.entryId = entry.id;
            item.title = `${entry.title}（${entry.pluginId}）`;
            const icon = window.KeiEntryIcon
                ? window.KeiEntryIcon.render(entry, "menu-icon")
                : Object.assign(document.createElement("span"), { className: "menu-icon", textContent: entry.icon || entry.title.slice(0, 1) });
            const label = document.createElement("span");
            label.className = "menu-label";
            label.textContent = entry.title;
            const plugin = document.createElement("span");
            plugin.className = "menu-plugin";
            plugin.textContent = entry.pluginId;
            item.append(icon, label, plugin);
            if (current && current.pluginId === entry.pluginId && current.entryId === entry.id) item.setAttribute("aria-current", "true");
            if (pending && pending.pluginId === entry.pluginId && pending.entryId === entry.id) item.setAttribute("aria-busy", "true");
            item.addEventListener("click", () => openEntry(entry));
            list.append(item);
            if (focusedKey === entryKey(entry.pluginId, entry.id)) item.focus({ preventScroll: true });
        }
        const state = visible.length ? "ready" : entriesState;
        $("extension-panel").dataset.state = state;
        $("extension-empty").hidden = visible.length > 0;
        $("extension-empty").textContent = EMPTY_NOTE[state] || EMPTY_NOTE.ready;
        const badge = $("extension-count");
        badge.hidden = visible.length === 0;
        badge.textContent = String(visible.length);
        list.dispatchEvent(new CustomEvent("kei:entries", { bubbles: true, detail: { state, count: visible.length } }));
    }

    let refreshSeq = 0;
    async function refreshEntries() {
        const seq = ++refreshSeq;
        const openAtStart = current?.tag; // only judge pages that existed before this request
        if (!entries.length && entriesState !== "offline") { entriesState = "loading"; renderEntries(); }
        const response = await kei.entries().catch(() => null);
        if (seq !== refreshSeq) return;
        entries = hostOnline !== false && response?.ok ? response.entries : [];
        // Main answers an empty list while the host is down, so the host status decides.
        entriesState = hostOnline === false || response?.error?.code === "host_unavailable" ? "offline"
            : !response?.ok ? "error"
            : hostOnline === null && !entries.length ? "loading" // still connecting
            : "ready";
        // Close a mounted page whose entry is no longer active (defence in depth; main
        // already closes frames on disable / reload / uninstall).
        if (current && current.tag === openAtStart && !entries.some(e => e.pluginId === current.pluginId && e.id === current.entryId)) {
            frames.close(current.tag, "plugin.disabled");
        }
        renderEntries();
    }
    kei.onEntriesChanged(() => refreshEntries());
    function noteHost(status) {
        const online = Boolean(status?.connected);
        const settled = online || Boolean(status?.error); // "connecting" is neither
        if (!settled || online === hostOnline) return;
        hostOnline = online;
        if (!online) {
            refreshSeq++;
            entries = [];
            entriesState = "offline";
            closeSheet();
        } else refreshEntries();
    }
    kei.onStatus(noteHost);
    kei.status().then(response => response?.ok && noteHost(response.status)).catch(() => {});

    // ---------------------------------------------------------------- plugin sheet
    // Only the most recent open request may mount. A page opened by an earlier, superseded
    // click (or one closed while it was still opening) is closed as soon as it arrives, so
    // quick or interrupted clicks never leave a second, unreachable frame in the sheet.
    // Focus that was inside the sheet (including inside the plugin frame, whose removal drops
    // focus to <body>) goes back to where the page was opened from.
    let sheetHasFocus = false;
    $("plugin-sheet").addEventListener("focusin", () => { sheetHasFocus = true; });
    $("plugin-sheet").addEventListener("focusout", event => {
        if (event.relatedTarget && !$("plugin-sheet").contains(event.relatedTarget)) sheetHasFocus = false;
    });
    function hideSheet() {
        const sheet = $("plugin-sheet");
        const hadFocus = sheet.contains(document.activeElement) || (document.activeElement === document.body && sheetHasFocus);
        sheetHasFocus = false;
        sheet.hidden = true;
        sheet.removeAttribute("data-plugin-id");
        sheet.removeAttribute("data-entry-id");
        sheet.removeAttribute("aria-busy");
        if (hadFocus) {
            const target = returnFocus?.isConnected && !returnFocus.closest("[hidden]") ? returnFocus : $("extension-button");
            target.focus({ preventScroll: true });
        }
        returnFocus = null;
    }

    const frames = new PluginFrameHost(kei, {
        onClosed: (info, reason, text) => {
            if (current && current.tag === info.tag) {
                current = null;
                if (!pending) hideSheet();
                renderEntries();
            }
            if (reason === "user") return;
            // A page that polls can see page_closed just before the lifecycle event that caused
            // it. If its plugin has no entries any more, say so rather than "connection lost".
            if (reason === "page_closed") {
                refreshEntries().then(() => {
                    const gone = entriesState === "ready" && !entries.some(e => e.pluginId === info.pluginId);
                    toast(`${info.title}：${gone ? "プラグインが無効になったため閉じました" : text}`);
                });
                return;
            }
            toast(`${info.title}：${text}`);
        },
    });

    async function openEntry(entry) {
        if (current && current.pluginId === entry.pluginId && current.entryId === entry.id && !pending) {
            closePopovers();
            $("plugin-sheet").focus({ preventScroll: true });
            return;
        }
        if (pending && pending.pluginId === entry.pluginId && pending.entryId === entry.id) return; // same page already opening
        const fromMenu = $("extension-panel").contains(document.activeElement);
        closePopovers();
        if (fromMenu || !returnFocus) returnFocus = document.activeElement !== document.body ? document.activeElement : $("extension-button");
        const seq = ++openSeq;
        pending = { seq, pluginId: entry.pluginId, entryId: entry.id };
        if (current) { const tag = current.tag; current = null; await frames.close(tag, "user"); }
        if (seq !== openSeq) return;
        const sheet = $("plugin-sheet");
        $("plugin-sheet-title").textContent = entry.title;
        sheet.dataset.pluginId = entry.pluginId;
        sheet.dataset.entryId = entry.id;
        sheet.setAttribute("aria-busy", "true");
        sheet.hidden = false;
        sheet.focus({ preventScroll: true });
        renderEntries();
        try {
            const info = await frames.mount($("plugin-sheet-body"), entry.pluginId, entry.id, () => seq === openSeq);
            if (!info) return;
            if (seq !== openSeq) { await frames.close(info.tag, "user"); return; }
            current = { tag: info.tag, pluginId: entry.pluginId, entryId: entry.id };
            try { localStorage.setItem("kei-last-extension", entryKey(entry.pluginId, entry.id)); } catch { /* optional */ }
        } catch (error) {
            if (seq !== openSeq) return;
            hideSheet();
            toast(`${entry.title}：${error.message}`);
        } finally {
            if (seq === openSeq) { pending = null; $("plugin-sheet").removeAttribute("aria-busy"); renderEntries(); }
        }
    }

    function closeSheet() {
        if (pending) { openSeq += 1; pending = null; } // a page still opening is closed when it arrives
        if (current) frames.close(current.tag, "user");
        else hideSheet();
        renderEntries();
    }
    $("plugin-sheet-close").addEventListener("click", closeSheet);
    $("plugin-sheet").addEventListener("keydown", event => {
        if (event.key === "Escape") closeSheet();
    });

    // ---------------------------------------------------------------- character stage slot
    // Placeholder side of the stage-slot contract. The real renderer (Codex, Windows)
    // listens for the same DOM events on #character-stage.
    const stage = $("character-stage");
    function stageEvent(type, detail) {
        stage.dispatchEvent(new CustomEvent(type, { detail }));
    }
    new ResizeObserver(([entry]) => {
        stageEvent("kei:stage-resize", { width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) });
    }).observe(stage);
    document.addEventListener("visibilitychange", () => stageEvent("kei:stage-visibility", { visible: !document.hidden }));
    document.addEventListener("kei:theme", event => stageEvent("kei:stage-theme", { theme: event.detail }));

    refreshEntries();
})();

"use strict";
// Admin window: Kei-owned plugin management plus the "admin" plugin slot.

(function () {
    const kei = window.kei;
    const $ = id => document.getElementById(id);
    const { PluginFrameHost, errorText } = window.KeiPluginFrames;

    const SLOT_LABEL = {
        extensions: "デスクトップの拡張メニュー",
        admin: "管理ウィンドウ",
        attachment: "添付",
        selection: "選択テキスト",
        "character-settings": "キャラクター設定",
    };

    let toastTimer;
    function toast(text) {
        if (!text) return;
        const node = $("toast");
        node.textContent = text;
        node.classList.add("visible");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => node.classList.remove("visible"), 3600);
    }

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
        node.append(...children.filter(Boolean));
        return node;
    }

    // ---------------------------------------------------------------- host status
    let lastStatusConnected = false;
    let hostKnown = false;
    function renderStatus(status) {
        const reconnected = status.connected && !lastStatusConnected;
        const disconnected = !status.connected && lastStatusConnected;
        lastStatusConnected = Boolean(status.connected);
        hostKnown = hostKnown || status.connected || Boolean(status.error);
        if (disconnected) {
            entrySeq++;
            closePage();
            $("admin-entries").replaceChildren();
            $("admin-entries-empty").hidden = false;
        }
        if (!$("admin-entries").childElementCount) $("admin-entries-empty").textContent = entriesEmptyText(true);
        if (reconnected) {
            if ($("plugin-empty").dataset.state === "error") refreshPlugins();
            refreshEntries();
        }
        $("host-state").className = "state " + (status.connected ? "ok" : "bad");
        $("host-state").textContent = status.connected
            ? `接続済み（API v1）\nインストール済み：${status.installed ?? 0} 件`
            : `未接続\n${status.error ? errorText(status.error) : "接続中…"}`;
        const features = $("host-features");
        if (features) {
            features.replaceChildren(...(status.connected ? status.pluginFeatures : []).map(name => {
                const chip = document.createElement("span");
                chip.className = "chip on";
                chip.textContent = name;
                return chip;
            }));
            features.hidden = !status.connected || !status.pluginFeatures.length;
        }
        $("install").disabled = !status.connected;
    }
    kei.onStatus(renderStatus);
    kei.status().then(r => r?.ok && renderStatus(r.status));

    // ---------------------------------------------------------------- admin entries (slot "admin")
    // Main answers an empty list while the host is down, so the host status decides the text.
    function entriesEmptyText(ok) {
        if (!hostKnown) return "確認中…";
        return lastStatusConnected && ok ? "なし" : "ホスト未接続";
    }
    let current = null; // { tag, pluginId, entryId, title }

    const frames = new PluginFrameHost(kei, {
        onClosed: (info, reason, text) => {
            if (current && current.tag === info.tag) {
                current = null;
                if (!pending) $("plugin-page").hidden = true;
                $("plugin-page").removeAttribute("data-plugin-id");
                renderPageState();
                markCurrentEntry();
            }
            if (reason !== "user") toast(`${info.title}：${text}`);
        },
    });

    function renderPageState() {
        $("page-state").textContent = current ? `${current.title}（${current.pluginId}）を表示中` : "開いているページはありません";
        document.dispatchEvent(new CustomEvent("kei:admin-page", { detail: { open: Boolean(current || pending) } }));
    }

    function markCurrentEntry(opening = null) {
        const shown = opening || current || pending;
        for (const button of $("admin-entries").querySelectorAll(".side-entry")) {
            const active = shown && button.dataset.pluginId === shown.pluginId && button.dataset.entryId === (shown.entryId ?? shown.id);
            if (active) button.setAttribute("aria-current", "true"); else button.removeAttribute("aria-current");
        }
    }

    let entrySeq = 0;
    async function refreshEntries() {
        const seq = ++entrySeq;
        const openAtStart = current?.tag; // only judge pages that existed before this request
        const response = await kei.entries().catch(() => null);
        if (seq !== entrySeq) return;
        const entries = (response?.ok && !(hostKnown && !lastStatusConnected) ? response.entries : []).filter(e => e.slot === "admin");
        const list = $("admin-entries");
        const focusedKey = list.contains(document.activeElement) ? `${document.activeElement.dataset.pluginId}/${document.activeElement.dataset.entryId}` : null;
        // Same per-plugin icon treatment as the desktop menu (missing glyphs fall back to the title initial).
        const iconFor = entry => window.KeiEntryIcon ? window.KeiEntryIcon.render(entry, "side-entry-icon")
            : el("span", { class: "side-entry-icon", "aria-hidden": "true", text: entry.icon || entry.title.slice(0, 1) });
        list.replaceChildren(...entries.map(entry => el("div", { role: "listitem" }, el("button", {
            type: "button", class: "side-entry", title: `${entry.title}（${entry.pluginId}）`,
            dataset: { pluginId: entry.pluginId, entryId: entry.id },
            onclick: () => openEntry(entry),
        }, iconFor(entry), el("span", { class: "side-entry-label", text: entry.title })))));
        if (focusedKey) list.querySelector(`.side-entry[data-plugin-id="${CSS.escape(focusedKey.split("/")[0])}"][data-entry-id="${CSS.escape(focusedKey.split("/")[1])}"]`)?.focus({ preventScroll: true });
        $("admin-entries-empty").hidden = entries.length > 0;
        $("admin-entries-empty").textContent = entriesEmptyText(response?.ok);
        if (current && current.tag === openAtStart && !entries.some(e => e.pluginId === current.pluginId && e.id === current.entryId)) {
            frames.close(current.tag, "plugin.disabled");
        }
        markCurrentEntry();
    }

    // Only the latest request mounts; a page from a superseded or cancelled click is closed
    // when it arrives (same rule as the desktop sheet), so the page area never holds two frames.
    let openSeq = 0;
    let pending = null;
    async function openEntry(entry) {
        if (current && current.pluginId === entry.pluginId && current.entryId === entry.id && !pending) {
            $("plugin-page").scrollIntoView();
            $("plugin-page").focus({ preventScroll: true });
            return;
        }
        if (pending && pending.pluginId === entry.pluginId && pending.entryId === entry.id) return;
        const seq = ++openSeq;
        pending = { pluginId: entry.pluginId, entryId: entry.id };
        if (current) { const tag = current.tag; current = null; await frames.close(tag, "user"); }
        if (seq !== openSeq) return;
        $("plugin-page-title").textContent = entry.title;
        $("plugin-page-plugin").textContent = entry.pluginId;
        const section = $("plugin-page");
        section.dataset.pluginId = entry.pluginId;
        section.dataset.entryId = entry.id;
        section.setAttribute("aria-busy", "true");
        section.hidden = false;
        markCurrentEntry(entry);
        renderPageState();
        try {
            const info = await frames.mount($("plugin-page-body"), entry.pluginId, entry.id, () => seq === openSeq);
            if (!info) return;
            if (seq !== openSeq) { await frames.close(info.tag, "user"); return; }
            current = { tag: info.tag, pluginId: entry.pluginId, entryId: entry.id, title: entry.title };
            section.scrollIntoView();
            section.focus({ preventScroll: true });
        } catch (error) {
            if (seq !== openSeq) return;
            section.hidden = true;
            toast(`${entry.title}：${error.message}`);
        } finally {
            if (seq === openSeq) { pending = null; section.removeAttribute("aria-busy"); renderPageState(); markCurrentEntry(); }
        }
    }

    function closePage() {
        const returnTo = current || pending;
        if (pending) { openSeq += 1; pending = null; $("plugin-page").removeAttribute("aria-busy"); }
        if (current) frames.close(current.tag, "user");
        else { $("plugin-page").hidden = true; renderPageState(); markCurrentEntry(); }
        // Hand focus back to the side entry that opened the page.
        if (returnTo) $("admin-entries").querySelector(`.side-entry[data-plugin-id="${CSS.escape(returnTo.pluginId)}"][data-entry-id="${CSS.escape(returnTo.entryId)}"]`)?.focus({ preventScroll: true });
    }
    $("plugin-page-close").addEventListener("click", closePage);

    // ---------------------------------------------------------------- plugin management
    const busy = new Set();
    const expandedGrants = new Set();

    async function act(pluginId, label, run) {
        if (busy.has(pluginId)) return;
        busy.add(pluginId);
        renderBusy();
        try {
            const response = await run();
            if (!response?.ok) {
                if (!response?.canceled) toast(`${label}できませんでした：${errorText(response?.error?.code)}`);
                return response;
            }
            return response;
        } finally {
            busy.delete(pluginId);
            await refreshPlugins();
        }
    }

    function renderBusy() {
        for (const card of $("plugin-list").querySelectorAll(".plugin-card")) {
            const isBusy = busy.has(card.dataset.pluginId);
            for (const button of card.querySelectorAll("button")) button.disabled = isBusy;
        }
    }

    function pluginCard(plugin) {
        const declared = plugin.permissions || [];
        const granted = new Set(plugin.enabled ? (plugin.effectiveGrants || plugin.grants) : plugin.grants);
        const P = window.KeiPermissions;
        const icon = name => { const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.innerHTML = P.ICONS[name] || P.ICONS.data; return svg; };
        const infos = declared.map(scope => P.describe(scope));
        const grantInputs = declared.map(scope => el("input", {
            type: "checkbox", class: "grant-switch", value: scope, checked: plugin.enabled ? granted.has(scope) : (granted.size ? granted.has(scope) : false),
            disabled: plugin.enabled, "aria-label": `権限 ${scope} を許可`,
        }));
        const rows = infos.map((info, i) => {
            const [riskText, riskTone] = P.RISK[info.risk] || P.RISK.unknown;
            const on = plugin.enabled && granted.has(info.scope);
            return el("label", { class: "grant-row", dataset: { risk: riskTone, granted: String(plugin.enabled ? on : grantInputs[i].checked) } },
                el("span", { class: "grant-icon" }, icon(info.icon)),
                el("span", { class: "grant-text" },
                    el("span", { class: "grant-label" }, info.label, el("span", { class: "grant-risk", text: riskText })),
                    el("span", { class: "grant-desc", text: info.desc }),
                    el("code", { class: "grant-scope", text: info.scope })),
                plugin.enabled ? el("span", { class: "grant-state", text: on ? "許可済み" : "未許可" }) : grantInputs[i]);
        });
        const grants = el("fieldset", { class: "grants" },
            el("legend", { class: "visually-hidden", text: "許可する権限" }), ...rows);
        if (!declared.length) grants.append(el("span", { class: "note", text: "権限の要求はありません" }));
        // Summary + quick selection (disabled plugins only); keeps row states and the high-risk note in sync.
        const summary = el("span", { class: "grant-summary" });
        const warning = el("p", { class: "grant-warning", hidden: true });
        function syncGrants() {
            const chosen = plugin.enabled ? declared.filter(s => granted.has(s)) : grantInputs.filter(i => i.checked).map(i => i.value);
            summary.textContent = declared.length ? `${declared.length} 件中 ${chosen.length} 件を${plugin.enabled ? "許可済み" : "選択中"}` : "";
            rows.forEach((row, i) => { if (!plugin.enabled) row.dataset.granted = String(grantInputs[i].checked); });
            const risky = infos.filter(info => chosen.includes(info.scope) && (info.risk === "high" || info.risk === "unknown"));
            warning.hidden = plugin.enabled || !risky.length;
            warning.textContent = risky.length ? `注意：${risky.map(r => `「${r.label}」`).join("")}は外部への送信や実行を含むか、内容が不明な権限です。信頼できるプラグインにだけ許可してください。` : "";
        }
        for (const input of grantInputs) input.addEventListener("change", syncGrants);
        const quick = plugin.enabled || declared.length < 2 ? null : el("span", { class: "grant-quick" },
            el("button", { type: "button", class: "ghost small", onclick: () => { grantInputs.forEach(i => { i.checked = true; }); syncGrants(); } }, "すべて選ぶ"),
            el("button", { type: "button", class: "ghost small", title: "読み取りと軽い操作だけを選びます", onclick: () => { grantInputs.forEach((i, k) => { i.checked = infos[k].risk === "low"; }); syncGrants(); } }, "安全なものだけ"),
            el("button", { type: "button", class: "ghost small", onclick: () => { grantInputs.forEach(i => { i.checked = false; }); syncGrants(); } }, "すべて外す"));
        // Enabled plugins: compact chips by default, full rows on request (remembered per plugin).
        let more = null;
        if (plugin.enabled && declared.length) {
            grants.classList.toggle("compact", !expandedGrants.has(plugin.id));
            more = el("button", { type: "button", class: "ghost small grant-more", "aria-expanded": String(expandedGrants.has(plugin.id)),
                onclick: () => {
                    const open = grants.classList.toggle("compact") === false;
                    if (open) expandedGrants.add(plugin.id); else expandedGrants.delete(plugin.id);
                    more.textContent = open ? "閉じる" : "詳しく";
                    more.setAttribute("aria-expanded", String(open));
                } }, expandedGrants.has(plugin.id) ? "閉じる" : "詳しく");
        }
        const grantHead = el("div", { class: "grant-head" }, el("h3", { text: plugin.enabled ? "許可した権限" : "許可する権限" }), summary, quick, more);
        queueMicrotask(syncGrants);

        const entries = plugin.declaredEntries || [];
        const entryList = el("ul", { class: "entry-list" }, ...entries.map(entry => el("li", {},
            el("span", { text: entry.title }),
            el("span", { class: "entry-slot", text: SLOT_LABEL[entry.slot] || entry.slot }))));

        const confirm = el("div", { class: "confirm", hidden: true },
            el("div", { class: "note", text: "アンインストールしますか？開いているページはすぐに閉じます。" }),
            el("label", {}, el("input", { type: "radio", name: `retain-${plugin.id}`, value: "keep", checked: true }), "設定とデータを残す（再インストール時に引き継ぎます）"),
            el("label", {}, el("input", { type: "radio", name: `retain-${plugin.id}`, value: "delete" }), "設定とデータも削除する"),
            el("div", { class: "row" },
                el("button", {
                    type: "button", class: "danger solid", "data-action": "uninstall-confirm",
                    onclick: () => {
                        const retainData = confirm.querySelector("input[value=keep]").checked;
                        act(plugin.id, "アンインストール", () => kei.plugins.uninstall(plugin.id, { retainData })).then(r => {
                            if (r?.ok) toast(`${plugin.name} をアンインストールしました（データを${r.result.retainData ? "保持" : "削除"}${r.result.openPagesClosed ? `・ページ ${r.result.openPagesClosed} 件を閉じました` : ""}）`);
                        });
                    },
                }, "アンインストール"),
                el("button", { type: "button", class: "ghost", onclick: () => { confirm.hidden = true; } }, "キャンセル")));

        const actions = el("div", { class: "row" });
        if (plugin.enabled) {
            if (declared.length) actions.append(el("button", { type: "button", class: "ghost", "data-action": "change-grants", title: "権限は有効な間は変えられません。いったん無効にして選び直します",
                onclick: () => act(plugin.id, "無効に", () => kei.plugins.disable(plugin.id)).then(r => r?.ok && toast(`${plugin.name} を無効にしました。権限を選び直して「有効にする」を押してください`)) }, "権限を変更…"));
            actions.append(
                el("button", { type: "button", class: "ghost", "data-action": "disable",
                    onclick: () => act(plugin.id, "無効に", () => kei.plugins.disable(plugin.id)).then(r => r?.ok && toast(`${plugin.name} を無効にしました`)) }, "無効にする"),
                el("button", { type: "button", class: "ghost", "data-action": "reload",
                    onclick: () => act(plugin.id, "再読み込み", () => kei.plugins.reload(plugin.id)).then(r => r?.ok && toast(`${plugin.name} を再読み込みしました。ページを開き直してください`)) }, "再読み込み"));
        } else {
            actions.append(el("button", { type: "button", "data-action": "enable",
                onclick: () => {
                    const chosen = grantInputs.filter(input => input.checked).map(input => input.value);
                    act(plugin.id, "有効に", () => kei.plugins.enable(plugin.id, chosen)).then(r => r?.ok && toast(`${plugin.name} を有効にしました`));
                } }, "有効にする"));
        }
        actions.append(el("button", { type: "button", class: "danger", "data-action": "uninstall", onclick: () => { confirm.hidden = false; } }, "アンインストール…"));

        const problem = plugin.diagnostic || plugin.lastError;
        return el("article", { class: "card plugin-card", dataset: { pluginId: plugin.id, enabled: String(plugin.enabled) } },
            el("div", { class: "plugin-head" },
                el("span", { class: "plugin-name", text: plugin.name }),
                el("span", { class: "plugin-id", text: plugin.id }),
                el("span", { class: "badge", text: `v${plugin.version}` }),
                el("span", { class: `badge plugin-state ${plugin.enabled ? "on" : "off"}`, text: plugin.enabled ? "有効" : "無効" })),
            el("div", { class: "meta" },
                el("span", { text: `プラグイン API v${plugin.apiVersion}` }),
                plugin.compatibility && el("span", { text: plugin.compatibility.compatible === false ? "互換性なし" : "互換性あり" })),
            problem && el("div", { class: "error", role: "alert", text: typeof problem === "string" ? problem : `${problem.code}：${problem.message}` }),
            grantHead, grants, warning,
            entries.length ? el("h3", { text: "ページ" }) : null, entries.length ? entryList : null,
            actions, confirm);
    }

    let pluginSeq = 0;
    async function refreshPlugins() {
        const seq = ++pluginSeq;
        const response = await kei.plugins.list().catch(() => null);
        if (seq !== pluginSeq) return;
        if (!response?.ok) {
            $("plugin-list").replaceChildren();
            $("plugin-empty").hidden = false;
            $("plugin-empty").dataset.state = "error";
            $("plugin-empty").textContent = `${errorText(response?.error?.code || "host_unavailable")} 接続すると自動で表示します。`;
            $("plugin-summary").textContent = "";
            return;
        }
        const details = await Promise.all(response.plugins.map(p =>
            kei.plugins.detail(p.id).then(d => (d?.ok ? d.plugin : p)).catch(() => p)));
        if (seq !== pluginSeq) return;
        const openConfirms = new Set([...$("plugin-list").querySelectorAll(".plugin-card")]
            .filter(card => !card.querySelector(".confirm").hidden).map(card => card.dataset.pluginId));
        // Round 09: keep the grants the user has ticked on a disabled plugin across re-renders
        // (a lifecycle event can refresh the list between ticking and pressing 有効にする).
        const ticked = new Map([...$("plugin-list").querySelectorAll('.plugin-card[data-enabled="false"]')]
            .map(card => [card.dataset.pluginId, new Set([...card.querySelectorAll(".grants input:checked")].map(i => i.value))]));
        $("plugin-list").replaceChildren(...details.map(pluginCard));
        for (const card of $("plugin-list").querySelectorAll(".plugin-card")) {
            if (openConfirms.has(card.dataset.pluginId)) card.querySelector(".confirm").hidden = false;
            const keep = card.dataset.enabled === "false" ? ticked.get(card.dataset.pluginId) : null;
            if (keep) for (const input of card.querySelectorAll(".grants input")) input.checked = keep.has(input.value);
        }
        renderBusy();
        $("plugin-empty").hidden = details.length > 0;
        $("plugin-empty").dataset.state = "empty";
        $("plugin-empty").textContent = "インストール済みのプラグインはありません。上の「プラグインをインストール…」から ZIP パッケージを選んでください。";
        const enabled = details.filter(p => p.enabled).length;
        $("plugin-summary").textContent = `${details.length} 件 · 有効 ${enabled} 件`;
        $("updated").textContent = `${new Date().toLocaleTimeString("ja-JP")} 更新`;
    }

    $("install").addEventListener("click", async () => {
        $("install-error").textContent = "";
        $("install-status").textContent = "パッケージを選んでください…";
        $("install").disabled = true;
        try {
            const response = await kei.plugins.install();
            if (response?.ok) {
                $("install-status").textContent = `${response.plugin.name}（${response.plugin.id} v${response.plugin.version}）をインストールしました。権限を確認して有効にしてください。`;
            } else {
                $("install-status").textContent = "";
                if (!response?.canceled) $("install-error").textContent = `インストールできませんでした：${errorText(response?.error?.code)}`;
            }
        } finally {
            $("install").disabled = !lastStatusConnected;
            refreshPlugins();
        }
    });

    $("refresh").addEventListener("click", () => { refreshPlugins(); refreshEntries(); });
    kei.plugins.onChanged(() => refreshPlugins());
    kei.onEntriesChanged(() => refreshEntries());

    refreshPlugins();
    refreshEntries();
})();

"use strict";
// Idle overview card (reference/KeiDesktop v0.3.2 #overview). It only summarises what the
// shell already shows (connection, extensions, observation, Kei's last line) and every row
// opens the place it summarises. No new bridge calls.
(function () {
    const $ = id => document.getElementById(id);
    const card = document.createElement("section");
    card.id = "overview";
    card.className = "ui-panel";
    card.setAttribute("aria-label", "概要");
    card.innerHTML = '<div class="overview-head"><span class="popover-kicker">概要</span><span id="overview-date"></span></div>'
        + '<div id="overview-title"></div><div id="overview-rows"></div>';
    $("window").append(card);

    const WEEK = "日月火水木金土";
    function greeting(hour) {
        if (hour < 5) return "夜更かしですね";
        if (hour < 11) return "おはようございます";
        if (hour < 18) return "こんにちは";
        return "こんばんは";
    }
    function openExtension(title) {
        const item = [...document.querySelectorAll("#extension-list .menu-item")].find(node => node.querySelector(".menu-label")?.textContent === title);
        if (item) item.click(); else $("extension-button")?.click();
    }
    const ICONS = {
        host: '<path d="M4 6h16v9H4zM9 19h6M12 15v4"/>',
        ext: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><path d="M16.5 13v7M13 16.5h7"/>',
        focus: '<circle cx="12" cy="13" r="7"/><path d="M12 9v4l2.5 2M9 3h6"/>',
        watch: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
        last: '<path d="M5 5h14v10H10l-5 4z"/>',
        work: '<path d="M4 7h16v12H4z"/><path d="M9 7V5h6v2M4 12h16"/>',
    };
    function rows() {
        const online = $("status")?.dataset.state === "online";
        const titles = [...document.querySelectorAll("#extension-list .menu-label")].map(node => node.textContent);
        const watching = $("capture-toggle")?.getAttribute("aria-checked") === "true";
        const line = $("subtitle-chinese")?.textContent.trim();
        const list = [
            { key: "host", label: "ホスト", value: online ? "接続済み" : $("connection-text")?.textContent || "確認中…", tone: online ? "ok" : "bad", open: () => $("quick-button")?.click() },
            { key: "ext", label: "拡張", value: titles.length ? `${titles.length} 件 · ${titles.join("、")}`
                : ({ loading: "確認中…", offline: "ホスト未接続のため表示できません", error: "一覧を読み込めませんでした" })[$("extension-panel")?.dataset.state] || "有効な拡張はありません",
                open: () => $("extension-button")?.click() },
        ];
        const focus = window.KeiFocusChip?.snapshot();
        if (focus) {
            const minutes = Math.ceil(focus.remaining / 60000);
            const phase = { focus: "集中", break: "休憩", "long-break": "長い休憩" }[focus.phase] || "集中";
            const value = focus.status === "running" ? `${phase} · 残り ${minutes} 分` : focus.status === "paused" ? `${phase} · 一時停止中（残り ${minutes} 分）` : `待機中 · 今日 ${focus.completed} 回`;
            list.push({ key: "focus", label: "集中", value, tone: focus.status === "running" ? "ok" : "", open: () => $("focus-button")?.click() });
        } else if (titles.includes("集中タイマー")) list.push({ key: "focus", label: "集中", value: "タイマーを開く", open: () => openExtension("集中タイマー") });
        const work = window.KeiSessions?.snapshot();
        if (work && (work.running || work.waiting || work.finished)) {
            const value = work.waiting ? `確認待ち ${work.waiting} 件${work.running ? ` · 実行中 ${work.running} 件` : ""}` : work.running ? `実行中 ${work.running} 件` : `完了 ${work.finished} 件`;
            list.push({ key: "work", label: "作業", value, tone: work.waiting ? "bad" : work.running ? "ok" : "", open: () => $("sessions-button")?.click() });
        }
        list.push({ key: "watch", label: "画面観察", value: watching ? "観察中" : "停止中", tone: watching ? "ok" : "", open: () => $("quick-button")?.click() });
        list.push({ key: "last", label: "さっきの話", value: line || "まだ話していません", wide: true, open: () => $("backlog-button")?.click() });
        return list;
    }
    let signature = "";
    function render() {
        const now = new Date();
        $("overview-date").textContent = `${now.getMonth() + 1}月${now.getDate()}日（${WEEK[now.getDay()]}） ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        $("overview-title").textContent = greeting(now.getHours());
        const next = rows();
        const sig = JSON.stringify(next.map(({ open, ...rest }) => rest));
        if (sig === signature) return;
        signature = sig;
        $("overview-rows").replaceChildren(...next.map(row => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "overview-row";
            button.dataset.row = row.key;
            if (row.wide) button.dataset.wide = "true";
            const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            icon.setAttribute("viewBox", "0 0 24 24");
            icon.setAttribute("aria-hidden", "true");
            icon.innerHTML = ICONS[row.key];
            const label = document.createElement("span");
            label.className = "overview-label";
            label.textContent = row.label;
            const value = document.createElement("span");
            value.className = "overview-value";
            if (row.tone) value.dataset.tone = row.tone;
            value.textContent = row.value;
            button.append(icon, label, value);
            button.addEventListener("click", row.open);
            return button;
        }));
    }
    // Step aside while a sheet or plugin page uses the same column.
    function placement() {
        const busy = !$("plugin-sheet")?.hidden || document.body.classList.contains("backlog-open") || document.body.classList.contains("reading-open");
        card.classList.toggle("is-away", busy);
    }
    const observer = new MutationObserver(() => { render(); placement(); });
    for (const id of ["status", "extension-list", "capture-toggle", "subtitle-chinese", "plugin-sheet"]) {
        const node = $(id);
        if (node) observer.observe(node, { attributes: true, childList: true, subtree: true, characterData: true });
    }
    new MutationObserver(placement).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    document.addEventListener("kei:focus", render);
    document.addEventListener("kei:sessions", render);
    document.addEventListener("kei:entries", render);
    render();
    placement();
    setInterval(render, 20000);
})();

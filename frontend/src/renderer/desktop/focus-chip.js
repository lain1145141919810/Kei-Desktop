"use strict";
// Toolbar focus chip + popover (v0.3.2 #pomodoro-button / #pomodoro-panel), driven by the
// trusted focus service in main. Hidden while kei.focus is not enabled.
(function () {
    const kei = window.kei;
    if (!kei?.focus || !window.KeiShell) return;
    const $ = id => document.getElementById(id);
    const PHASE = { focus: "集中", break: "休憩", "long-break": "長い休憩" };
    const PRESETS = { "25": [25, 5, 15], "50": [50, 10, 20], "15": [15, 3, 10] };

    const chip = document.createElement("button");
    chip.id = "focus-button";
    chip.type = "button";
    chip.className = "shell-button";
    chip.title = "集中タイマー";
    chip.hidden = true;
    chip.setAttribute("aria-expanded", "false");
    chip.setAttribute("aria-controls", "focus-panel");
    chip.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="13" r="7"/><path d="M12 9v4l2.5 2M9 3h6"/></svg><span id="focus-chip-time">25:00</span>';
    $("shell-toolbar").prepend(chip);

    const panel = document.createElement("section");
    panel.id = "focus-panel";
    panel.className = "popover ui-panel";
    panel.setAttribute("aria-label", "集中タイマー");
    panel.hidden = true;
    panel.innerHTML = `
        <div class="popover-kicker" id="focus-phase">集中</div>
        <div class="focus-dial"><svg viewBox="0 0 120 120" aria-hidden="true"><circle class="focus-track" cx="60" cy="60" r="52"/><circle class="focus-arc" id="focus-arc" cx="60" cy="60" r="52" pathLength="1000" stroke-dasharray="1000"/></svg>
            <div class="focus-face"><div id="focus-time">25:00</div><div class="popover-note" id="focus-state">待機中</div></div></div>
        <div class="popover-row">
            <button id="focus-toggle" class="pill primary" type="button">開始</button>
            <button class="pill" type="button" data-focus="skip" title="次の区切りへ進む">スキップ</button>
            <button class="pill" type="button" data-focus="cancel">リセット</button>
        </div>
        <div class="segmented" id="focus-presets" role="group" aria-label="時間の設定">
            <button type="button" data-preset="25">25 / 5 分</button>
            <button type="button" data-preset="50">50 / 10 分</button>
            <button type="button" data-preset="15">15 / 3 分</button>
        </div>
        <div class="popover-note" id="focus-count">今日の集中：0 回</div>`;
    document.body.append(panel);
    window.KeiShell.addPopover(chip, panel);

    // 小窓: a small read-only pill so a running timer stays visible next to Kei.
    const mini = document.createElement("button");
    mini.id = "compact-focus";
    mini.type = "button";
    mini.className = "ui-panel";
    mini.title = "元の画面で集中タイマーを開く";
    mini.innerHTML = '<i></i><span id="compact-focus-time"></span>';
    mini.addEventListener("click", async () => { await kei.compact?.set(false); if (panel.hidden) chip.click(); });
    document.body.append(mini);

    let snap = null;
    const remainingNow = () => !snap ? 0 : snap.status === "running" ? Math.max(0, snap.remaining - (Date.now() - snap.at)) : snap.remaining;
    const clock = ms => { const s = Math.ceil(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };

    function paint() {
        if (!snap) return;
        const left = remainingNow();
        const index = { focus: 0, break: 1, "long-break": 2 }[snap.phase] ?? 0;
        const total = (PRESETS[snap.preset] || PRESETS["25"])[index] * 60000;
        $("focus-chip-time").textContent = clock(left);
        $("compact-focus-time").textContent = `${PHASE[snap.phase] || "集中"} ${clock(left)}`;
        $("focus-time").textContent = clock(left);
        $("focus-arc").setAttribute("stroke-dashoffset", String(Math.round(1000 * (1 - left / total))));
    }
    function render(next) {
        snap = next;
        chip.hidden = !snap;
        if (!snap) mini.dataset.status = "off";
        if (!snap) { if (!panel.hidden) window.KeiShell.closePopovers(); return; }
        chip.dataset.status = snap.status;
        mini.dataset.status = snap.status;
        mini.dataset.phase = snap.phase;
        chip.dataset.phase = snap.phase;
        panel.dataset.phase = snap.phase;
        $("focus-phase").textContent = PHASE[snap.phase] || "集中";
        $("focus-state").textContent = { idle: "待機中", running: "進行中", paused: "一時停止中" }[snap.status] || snap.status;
        $("focus-toggle").textContent = snap.status === "running" ? "一時停止" : snap.status === "paused" ? "再開" : "開始";
        $("focus-count").textContent = `今日の集中：${snap.completed} 回`;
        for (const b of panel.querySelectorAll("[data-preset]")) b.setAttribute("aria-pressed", String(b.dataset.preset === snap.preset));
        paint();
        document.dispatchEvent(new CustomEvent("kei:focus", { detail: { ...snap, remaining: remainingNow() } }));
    }
    async function control(action, args) {
        const reply = await kei.focus.control(action, args).catch(() => null);
        if (reply?.ok) render(reply.focus);
        else window.KeiShell.toast(reply?.error?.message || "集中タイマーを操作できませんでした。");
    }
    $("focus-toggle").addEventListener("click", () => control(snap?.status === "running" ? "pause" : snap?.status === "paused" ? "resume" : "start"));
    for (const b of panel.querySelectorAll("[data-focus]")) b.addEventListener("click", () => control(b.dataset.focus));
    for (const b of panel.querySelectorAll("[data-preset]")) b.addEventListener("click", () => control("preset", { preset: b.dataset.preset }));

    kei.focus.onState(render);
    const LINES = {
        focus: ["集中おつかれさま。少し休憩しましょう。", "区切りがつきました。肩の力を抜いてくださいね。", "よくがんばりました。お茶でもどうですか？"],
        break: ["休憩おわりです。次の集中、いきましょう。", "そろそろ再開しましょうか。"],
        "long-break": ["長い休憩おわりです。気持ちを切り替えていきましょう。"],
    };
    kei.focus.onNotice(notice => {
        const pool = LINES[notice.phase] || LINES.focus;
        if (window.KeiDialogue) window.KeiDialogue.say(pool[Math.floor(Math.random() * pool.length)], 9000);
        else window.KeiShell.toast(`${notice.title} — ${notice.body}`);
    });
    kei.focus.status().then(reply => reply?.ok && render(reply.focus)).catch(() => {});
    setInterval(() => { if (snap?.status === "running") { paint(); document.dispatchEvent(new CustomEvent("kei:focus", { detail: { ...snap, remaining: remainingNow() } })); } }, 500);
    window.KeiFocusChip = { snapshot: () => snap && { ...snap, remaining: remainingNow() } };
})();

"use strict";

(() => {
    const bridge = window.kei?.presentation;
    const overlay = document.getElementById("presentation-overlay");
    const mediaArea = document.getElementById("presentation-media");
    const skip = document.getElementById("presentation-skip");
    if (!bridge) {
        document.body.dataset.presentationPhase = "idle";
        overlay.hidden = true;
        return;
    }

    const settings = document.createElement("details");
    settings.id = "presentation-settings";
    settings.className = "quick-block";
    const title = document.createElement("summary");
    title.textContent = "起動・終了";
    settings.append(title);
    const outputs = {};
    const labels = { opening: "起動画面", ending: "終了画面", voice: "起動音声" };
    const report = document.createElement("div");
    report.setAttribute("role", "status");
    function button(label, action) {
        const element = document.createElement("button");
        element.type = "button";
        element.textContent = label;
        element.addEventListener("click", action);
        return element;
    }
    for (const [slot, label] of Object.entries(labels)) {
        const row = document.createElement("section");
        const state = document.createElement("div");
        outputs[slot] = state;
        row.dataset.presentationSlot = slot;
        row.append(state, button("選択", () => update(bridge.choose(slot))),
            button("試す", () => void preview(slot)), button("解除", () => update(bridge.remove(slot))));
        settings.append(row);
    }
    const label = document.createElement("label");
    const mute = document.createElement("input");
    mute.type = "checkbox";
    label.append(mute, " 起動・終了の音を消す");
    settings.append(label, report);
    document.getElementById("quick-panel").append(settings);
    mute.addEventListener("change", () => update(bridge.mute(mute.checked)));

    function populate(value) {
        mute.checked = value.muted;
        for (const [slot, asset] of Object.entries(value.assets)) {
            outputs[slot].textContent = labels[slot] + " · " + (asset.available ? asset.label : "設定なし");
        }
    }
    async function update(result) {
        try {
            const reply = await result;
            if (!reply.ok) throw new Error();
            populate(reply.value);
            report.textContent = "保存しました。";
        } catch {
            report.textContent = "このファイルを設定できません。";
        }
    }

    let run;
    let closing = false;
    let visualRevision = 0;
    let startupShown = false;
    function showStartup() {
        if (startupShown) return;
        startupShown = true;
        void bridge.ready?.();
    }
    function hideOverlay(revision, finish) {
        overlay.classList.add("leaving");
        setTimeout(() => {
            if (revision === visualRevision) {
                overlay.hidden = true;
                overlay.classList.remove("leaving");
            }
            finish();
        }, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 200);
    }
    function play(asset, muted, signal, phase) {
        if (signal.aborted || !asset?.bytes) return Promise.resolve("missing");
        const visual = !asset.type.startsWith("audio/");
        const revision = visual ? ++visualRevision : null;
        if (!visual && muted) return Promise.resolve("muted");
        const image = asset.type.startsWith("image/");
        const element = document.createElement(image ? "img" : visual ? "video" : "audio");
        const url = URL.createObjectURL(new Blob([asset.bytes], { type: asset.type }));
        if (!image) {
            element.muted = muted;
            element.playsInline = true;
        }
        if (visual) {
            overlay.classList.remove("leaving");
            mediaArea.replaceChildren(element);
            overlay.hidden = false;
        }
        return new Promise(resolve => {
            let timer;
            let doneOnce = false;
            function done(status) {
                if (doneOnce) return;
                doneOnce = true;
                clearTimeout(timer);
                signal.removeEventListener("abort", abort);
                element.removeEventListener("ended", ended);
                element.removeEventListener("error", failed);
                element.removeEventListener("load", loaded);
                element.removeEventListener("loadeddata", showStartup);
                if (!image) element.pause();
                const finish = () => {
                    element.removeAttribute("src");
                    element.remove();
                    URL.revokeObjectURL(url);
                    resolve(status);
                };
                if (visual && !(status === "interrupted" && closing)) hideOverlay(revision, finish);
                else finish();
            }
            function abort() { done("interrupted"); }
            function failed() { done("unplayable"); }
            function ended() { done("played"); }
            function loaded() {
                if (phase === "opening") showStartup();
                clearTimeout(timer);
                timer = setTimeout(ended, 1300);
            }
            signal.addEventListener("abort", abort, { once: true });
            element.addEventListener("ended", ended, { once: true });
            element.addEventListener("error", failed, { once: true });
            if (image) element.addEventListener("load", loaded, { once: true });
            else if (visual && phase === "opening") element.addEventListener("loadeddata", showStartup, { once: true });
            timer = setTimeout(() => done("timed_out"), phase === "ending" ? 5500 : 6500);
            element.src = url;
            if (!image) element.play().catch(failed);
        });
    }

    async function present(phase, slots) {
        run?.abort();
        const current = new AbortController();
        run = current;
        document.body.dataset.presentationPhase = phase;
        try {
            const { value } = await bridge.status();
            if (current.signal.aborted || !value) return;
            populate(value);
            let hadVisual = false;
            const outcomes = await Promise.all(slots.map(async slot => {
                const asset = value.assets[slot]?.available ? (await bridge.asset(slot)).value : null;
                if (slot === "opening" && !asset) {
                    overlay.hidden = true;
                    showStartup();
                }
                if (asset?.type && !asset.type.startsWith("audio/")) hadVisual = true;
                return play(asset, value.muted, current.signal, phase);
            }));
            if (run !== current) return;
            if (phase === "opening" && !hadVisual) overlay.hidden = true;
            document.body.dataset.presentationResult = outcomes.join(",");
            if (phase === "preview") report.textContent = outcomes.some(outcome => outcome === "played")
                ? "プレビューを再生しました。" : "プレビューを再生できません。";
        } finally {
            if (run === current) {
                document.body.dataset.presentationPhase = "idle";
                run = null;
                if (phase === "opening") {
                    overlay.hidden = true;
                    showStartup();
                    document.dispatchEvent(new Event("kei:opening-complete"));
                }
            }
        }
    }
    async function preview(slot) {
        if (!closing) await present("preview", [slot]).catch(() => {});
    }
    skip.addEventListener("click", () => run?.abort());
    bridge.onClosing(() => {
        if (closing) return;
        closing = true;
        void present("ending", ["ending"]).finally(() => bridge.complete()).catch(() => {});
    });
    // After the opening (or straight away when there is none) Kei greets once.
    function greet() {
        const hour = new Date().getHours();
        const line = hour < 5 ? "こんな時間まで起きているんですね。無理はしないでください。"
            : hour < 11 ? "おはようございます。今日もよろしくお願いします。"
            : hour < 18 ? "こんにちは。何から始めましょうか。"
            : "こんばんは。今日もおつかれさまです。";
        setTimeout(() => {
            if (!closing && !document.getElementById("user-echo")?.classList.contains("visible")) {
                window.KeiDialogue?.say(line, 6500);
            }
        }, 700);
    }
    void present("opening", ["opening", "voice"]).catch(() => {}).finally(greet);
})();

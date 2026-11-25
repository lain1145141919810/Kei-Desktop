"use strict";

(() => {
    const bridge = window.kei?.compact;
    if (!bridge) return;
    const $ = id => document.getElementById(id);
    const body = document.body;
    const stage = $("character-stage");
    const svg = path => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
    const icons = {
        enter: '<rect x="4" y="5" width="16" height="14" rx="2"/><rect x="12" y="12" width="6" height="5" rx="1" fill="currentColor"/>',
        grip: '<circle cx="9" cy="6" r="1.3" fill="currentColor"/><circle cx="15" cy="6" r="1.3" fill="currentColor"/><circle cx="9" cy="12" r="1.3" fill="currentColor"/><circle cx="15" cy="12" r="1.3" fill="currentColor"/><circle cx="9" cy="18" r="1.3" fill="currentColor"/><circle cx="15" cy="18" r="1.3" fill="currentColor"/>',
        talk: '<path d="M5 5h14v10H10l-5 4z"/>',
        resize: '<path d="M20 8v12H8m8-7-3 3m5-8-9 9"/>',
        back: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/><circle cx="6" cy="7" r=".6" fill="currentColor"/>',
    };

    function button(id, icon, label) {
        const element = document.createElement("button");
        element.id = id;
        element.type = "button";
        element.title = label;
        element.setAttribute("aria-label", label);
        element.innerHTML = svg(icon);
        return element;
    }

    const enter = button("compact-button", icons.enter, "ケイだけにする（小窓 · Ctrl + Alt + K）");
    enter.className = "shell-button icon-only";
    enter.hidden = true;
    $("minimize-button")?.before(enter);

    const controls = document.createElement("nav");
    controls.id = "compact-toolbar";
    controls.className = "ui-panel";
    controls.setAttribute("aria-label", "小窓の操作");
    controls.hidden = true;
    const grip = button("compact-grip", icons.grip, "ドラッグで移動");
    const talk = button("compact-talk", icons.talk, "ケイに話しかける");
    const back = button("compact-return", icons.back, "元の画面に戻る（ダブルクリック · Esc · Ctrl + Alt + K）");
    talk.setAttribute("aria-pressed", "false");
    controls.append(grip, talk, back);
    const corner = button("compact-resize-grip", icons.resize, "右下をドラッグして大きさを調整（矢印キーでも調整可）");
    corner.hidden = true;

    const hint = document.createElement("div");
    hint.id = "compact-hint";
    hint.className = "ui-panel";
    hint.textContent = "ケイをドラッグで移動 · 右下の角をドラッグで拡大・縮小";
    body.append(controls, corner, hint);

    let state = { supported: false, active: false };
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    let modeRequest = 0;
    let requestedMode = null;
    let desktopReveal;
    let lastHit = null;
    let pointer = null;
    let hoverTimer;
    let hintTimer;
    let drag = null;
    let dragged = false;
    let moveFrame = null;
    let latestMove = null;

    let preferredScale = 1;
    let visibleScale = 1;
    let resize = null;
    let resizeFrame = null;
    let wantedScale = 1;

    function stageRect() {
        const { left, top, width, height } = stage.getBoundingClientRect();
        return { x: left, y: top, width, height };
    }

    function layoutStage(scale) {
        const { clientWidth: width, clientHeight: height, offsetLeft: left, offsetTop: top } = stage;
        if (!width || !height) return;
        const maximum = Math.min(3, innerWidth / width, innerHeight / height);
        visibleScale = Math.min(maximum, Math.max(Math.min(0.35, maximum), scale));
        const clampOffset = (offset, length, available) =>
            Math.min(Math.max(0, offset), Math.max(0, available - length * visibleScale)) - offset;
        const x = clampOffset(left, width, innerWidth);
        const y = clampOffset(top, height, innerHeight);
        stage.style.transform = `translate(${x}px, ${y}px) scale(${visibleScale})`;
        const rect = stageRect();
        for (const key of ["x", "y", "width", "height"]) {
            body.style.setProperty("--compact-stage-" + key, `${rect[key]}px`);
        }
    }

    function syncLayout() {
        if (!state.supported) return;
        layoutStage(resize ? wantedScale : preferredScale);
        if (state.active && !resize) bridge.geometry(stageRect());
    }
    new ResizeObserver(syncLayout).observe(stage);
    window.addEventListener("resize", syncLayout);

    function applyResize() {
        if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
        resizeFrame = null;
        layoutStage(wantedScale);
    }

    function rememberSize() {
        preferredScale = visibleScale;
        bridge.geometry(stageRect(), preferredScale);
    }

    function finishResize(event) {
        if (!resize || (event?.pointerId !== undefined && resize.pointer !== event.pointerId)) return;
        resize = null;
        applyResize();
        body.classList.remove("compact-resizing");
        rememberSize();
    }

    corner.addEventListener("pointerdown", event => {
        if (!state.active || resize || drag || event.button !== 0) return;
        event.preventDefault();
        wantedScale = visibleScale;
        resize = { pointer: event.pointerId, x: event.screenX, y: event.screenY,
            scale: visibleScale, width: stage.clientWidth, height: stage.clientHeight };
        corner.setPointerCapture(event.pointerId);
        body.classList.add("compact-resizing");
        hit(true);
    });

    corner.addEventListener("keydown", event => {
        if (!state.active || resize || drag || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        layoutStage(visibleScale + (event.key === "ArrowLeft" || event.key === "ArrowDown" ? -0.02 : 0.02));
        rememberSize();
    });

    async function requestCompact(enabled) {
        const request = ++modeRequest;
        requestedMode = enabled;
        if (!enabled) finishResize();
        const entering = enabled && !state.active && !reducedMotion.matches &&
            body.dataset.presentationPhase === "idle";
        if (entering) window.KeiShell?.closePopovers();
        body.classList.toggle("compact-preparing", entering);
        try {
            if (entering) await new Promise(resolve => setTimeout(resolve, 150));
            if (request !== modeRequest) return;
            await bridge.set(enabled, stageRect());
        } finally {
            if (request === modeRequest) {
                requestedMode = null;
                body.classList.remove("compact-preparing");
            }
        }
    }

    function toggleCompact() {
        void requestCompact(!(requestedMode ?? state.active));
    }

    function flushMove() {
        if (moveFrame !== null) cancelAnimationFrame(moveFrame);
        moveFrame = null;
        if (latestMove && state.active) bridge.move(latestMove.x, latestMove.y);
        latestMove = null;
    }

    function hit(value) {
        if (!state.active || value === lastHit) return;
        lastHit = value;
        bridge.hit(value);
    }

    function setTalking(on) {
        body.classList.toggle("compact-talking", on);
        talk.setAttribute("aria-pressed", String(on));
        if (on) requestAnimationFrame(() => $("composer-input")?.focus());
        else document.activeElement?.blur?.();
    }

    function hover(on) {
        clearTimeout(hoverTimer);
        if (on) body.classList.add("compact-hover");
        else hoverTimer = setTimeout(() => body.classList.remove("compact-hover"), 900);
    }

    function change(next) {
        if (!next?.supported) return;
        if (!state.supported) {
            preferredScale = next.scale;
            layoutStage(preferredScale);
        }
        const was = state.active;
        state = next;
        enter.hidden = false;
        if (was === state.active) return;
        lastHit = null;
        drag = null;
        resize = null;
        if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
        resizeFrame = null;
        pointer = null;
        latestMove = null;
        flushMove();
        dragged = false;
        body.classList.remove("compact-resizing", "compact-dragging");
        body.classList.toggle("native-compact", state.active);
        document.dispatchEvent(new CustomEvent("kei:compact-mode", { detail: state }));
        desktopReveal?.cancel();
        if (!state.active && !reducedMotion.matches) {
            desktopReveal = $("scene-background-layer").animate([{ opacity: 0.35 }, { opacity: 1 }],
                { duration: 180, easing: "ease-out" });
        }
        controls.hidden = !state.active;
        corner.hidden = !state.active;
        setTalking(false);
        hover(state.active);
        window.KeiShell?.closePopovers();
        document.querySelector("[data-character-compact]")?.setAttribute("aria-pressed", String(state.active));
        if (state.active) showHint();
    }

    function showHint() {
        let seen = 0;
        try { seen = Number(localStorage.getItem("kei-compact-resize-hint") || 0); } catch { /* optional */ }
        if (seen >= 3) return;
        try { localStorage.setItem("kei-compact-resize-hint", String(seen + 1)); } catch { /* optional */ }
        clearTimeout(hintTimer);
        hint.classList.add("visible");
        hintTimer = setTimeout(() => hint.classList.remove("visible"), 3600);
    }

    bridge.onChanged(change);
    bridge.onProbe(hitPoint);
    bridge.onToggleRequested(toggleCompact);
    document.addEventListener("kei:compact-toggle", toggleCompact);
    void bridge.status().then(change);
    enter.addEventListener("click", toggleCompact);
    back.addEventListener("click", toggleCompact);
    talk.addEventListener("click", () => setTalking(!body.classList.contains("compact-talking")));

    function onKei(x, y) {
        const renderer = window.KeiCharacterStage?.get(stage);
        if (renderer?.hitPoint) return Boolean(renderer.hitPoint(x, y));
        const box = stage.getBoundingClientRect();
        return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    }

    const interactiveAt = (x, y) => {
        const target = document.elementFromPoint(x, y);
        return Boolean(target?.closest("#compact-toolbar, #compact-resize-grip, #compact-focus, #compact-sessions, #composer, #subtitle.visible, #user-echo.visible")) || onKei(x, y);
    };

    function hitPoint(x, y) {
        if (!state.active || drag || resize) return;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
            pointer = null;
            hit(false);
            hover(false);
            return;
        }
        pointer = { x, y };
        const inside = interactiveAt(x, y);
        hit(inside);
        hover(inside);
    }

    stage.addEventListener("kei:stage-hit-map", () => {
        if (pointer) hitPoint(pointer.x, pointer.y);
    });

    window.addEventListener("pointerdown", event => {
        if (!state.active || drag || resize || event.button !== 0) return;
        const fromGrip = Boolean(event.target.closest?.("#compact-grip"));
        if (!fromGrip && (event.target.closest?.("#compact-toolbar, #compact-resize-grip, #composer, #subtitle, #user-echo") ||
            !onKei(event.clientX, event.clientY))) return;
        dragged = false;
        drag = { pointer: event.pointerId, dx: event.screenX - screenX, dy: event.screenY - screenY,
            startX: event.screenX, startY: event.screenY, moved: fromGrip };
        try { (fromGrip ? grip : event.target).setPointerCapture(event.pointerId); } catch { /* not capturable */ }
    }, true);

    window.addEventListener("pointermove", event => {
        if (resize?.pointer === event.pointerId) {
            const { width, height, x, y, scale } = resize;
            const delta = ((event.screenX - x) * width + (event.screenY - y) * height) /
                (width * width + height * height);
            wantedScale = scale + delta;
            if (resizeFrame === null) resizeFrame = requestAnimationFrame(applyResize);
            return;
        }
        if (drag?.pointer === event.pointerId) {
            if (!drag.moved && Math.hypot(event.screenX - drag.startX, event.screenY - drag.startY) < 5) return;
            if (!drag.moved) body.classList.add("compact-dragging");
            drag.moved = true;
            latestMove = { x: event.screenX - drag.dx, y: event.screenY - drag.dy };
            if (moveFrame === null) moveFrame = requestAnimationFrame(flushMove);
            return;
        }
        hitPoint(event.clientX, event.clientY);
    });

    function endDrag(event) {
        if (!drag || (event?.pointerId !== undefined && drag.pointer !== event.pointerId)) return;
        const moved = drag.moved;
        drag = null;
        flushMove();
        dragged = moved;
        body.classList.remove("compact-dragging");
        if (moved) bridge.settle();
    }

    for (const type of ["pointerup", "pointercancel", "lostpointercapture", "blur"]) {
        window.addEventListener(type, finishResize, true);
        window.addEventListener(type, endDrag, true);
    }
    window.addEventListener("click", event => {
        if (state.active && dragged && event.target.closest?.("#character-stage")) event.stopPropagation();
    }, true);
    window.addEventListener("dblclick", event => {
        if (state.active && !dragged && !event.target.closest?.("#compact-toolbar, #compact-resize-grip, #composer, #subtitle, #user-echo") &&
            onKei(event.clientX, event.clientY)) void requestCompact(false);
    });
    document.addEventListener("pointerleave", () => hitPoint(-1, -1));
    window.addEventListener("keydown", event => {
        if (!state.active || event.key !== "Escape") return;
        if (body.classList.contains("compact-talking")) setTalking(false);
        else void requestCompact(false);
    });
    $("composer-input")?.addEventListener("focus", () => { if (state.active) setTalking(true); });
})();

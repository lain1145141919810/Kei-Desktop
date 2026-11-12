// Compact mode: only Kei stays on screen.
// Nothing is resized. The scene and the panels fade out (CSS on body.compact),
// Kei stays exactly where she is, and the main process lets the mouse through
// the now-empty part of the window. This file tells it when the pointer is on
// Kei, moves the window when she is dragged, and handles the ways back.
(() => {
    const bridge = window.keiDesktop;
    const shell = window.KeiShell;
    const find = id => document.getElementById(id);
    const body = document.body;
    const surface = find('compact-surface');
    const input = find('composer-input');
    const isCompact = () => body.classList.contains('compact');

    let switching = false;
    let inside = false;
    let drag = null;
    let hintTimer = null;

    // ---------------------------------------------------------------
    // Pointer: is it on Kei (or on her controls / the mini composer)?
    // ---------------------------------------------------------------

    function reportHit(next) {
        if (next === inside) return;
        inside = next;
        body.classList.toggle('compact-hover', next);
        bridge?.hitCompact?.(next);
    }
    // While the window ignores the mouse, these moves are forwarded by the OS.
    window.addEventListener('mousemove', event => {
        if (!isCompact() || drag) return;
        const target = document.elementFromPoint(event.clientX, event.clientY);
        reportHit(Boolean(target?.closest('#compact-zone, #composer')));
    });
    document.addEventListener('mouseleave', () => { if (isCompact() && !drag) reportHit(false); });

    // ---------------------------------------------------------------
    // Talking to Kei without leaving compact mode
    // ---------------------------------------------------------------

    function setTyping(on) {
        body.classList.toggle('compact-typing', on);
        find('compact-talk').setAttribute('aria-pressed', String(on));
        if (on) input.focus(); else input.blur();
    }
    find('compact-talk').addEventListener('click', () => setTyping(!body.classList.contains('compact-typing')));

    // ---------------------------------------------------------------
    // Switching
    // ---------------------------------------------------------------

    // mainDone: the main process has already left compact mode (Ctrl + Alt + K).
    async function setCompact(enable, { mainDone = false } = {}) {
        if (switching || enable === isCompact()) return;
        switching = true;
        shell.closeOverlays();
        setTyping(false);
        inside = false;
        body.classList.remove('compact-hover');
        // The whole transition is this one class: everything but Kei cross-fades.
        body.classList.toggle('compact', enable);
        clearTimeout(hintTimer);
        body.classList.toggle('compact-hint', enable);
        // Show the controls for a moment so they can be found, then only on hover.
        if (enable) hintTimer = setTimeout(() => body.classList.remove('compact-hint'), 4000);
        try {
            if (!mainDone && bridge?.setCompact) {
                const state = await bridge.setCompact(enable);
                if (state.compact !== enable) body.classList.toggle('compact', state.compact);
                shell.showObservation(state.observation);
            }
        } catch (error) {
            // Never stay in a layout the main process did not agree to.
            body.classList.remove('compact', 'compact-hint');
            shell.showToast(`表示を切り替えられませんでした：${shell.unwrap(error)}`);
        } finally {
            switching = false;
        }
    }
    const leave = () => setCompact(false);

    find('compact-button').addEventListener('click', () => setCompact(true));
    find('compact-return').addEventListener('click', leave);
    // Ctrl + Alt + K is handled in main.js so it works even if this page is stuck.
    bridge?.onCompactToggle?.(enable => setCompact(enable, { mainDone: !enable }));
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !isCompact()) return;
        // First Esc closes the mini composer, the next one leaves compact mode.
        if (body.classList.contains('compact-typing')) setTyping(false); else leave();
    });

    // ---------------------------------------------------------------
    // Kei as the handle: drag to move, double-click to go back
    // ---------------------------------------------------------------

    surface.addEventListener('pointerdown', event => {
        if (!isCompact() || event.button !== 0) return;
        drag = { x: event.screenX, y: event.screenY, moved: false };
        surface.setPointerCapture?.(event.pointerId);
        bridge?.dragCompact?.('start');
    });
    surface.addEventListener('pointermove', event => {
        if (!drag) return;
        const dx = event.screenX - drag.x, dy = event.screenY - drag.y;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
        drag.moved = true;
        body.classList.add('compact-dragging');
        bridge?.dragCompact?.('move', dx, dy);
    });
    const endDrag = () => {
        if (!drag) return;
        drag = null;
        body.classList.remove('compact-dragging');
        bridge?.dragCompact?.('end');
    };
    surface.addEventListener('pointerup', endDrag);
    surface.addEventListener('pointercancel', endDrag);
    surface.addEventListener('dblclick', () => { if (isCompact()) leave(); });

    window.KeiCompact = { enter: () => setCompact(true), leave, isCompact };
})();

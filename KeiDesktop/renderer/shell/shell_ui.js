// Toolbar popovers, the toast, and quick controls (screen observation,
// proactive speech, executor, theme, admin entry).
// Compact mode lives in compact_ui.js, the focus timer and tasks in focus_ui.js.
(() => {
    const bridge = window.keiDesktop;
    const find = id => document.getElementById(id);
    const unwrap = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

    // ---------------------------------------------------------------
    // Toast
    // ---------------------------------------------------------------

    const toast = find('shell-toast');
    let toastTimer = null;
    function showToast(text, ms = 6000) {
        clearTimeout(toastTimer);
        toast.textContent = text;
        toast.classList.add('visible');
        toastTimer = setTimeout(() => toast.classList.remove('visible'), ms);
    }

    // ---------------------------------------------------------------
    // Popovers: one open at a time, closed by Esc or a click elsewhere
    // ---------------------------------------------------------------

    const popovers = [
        { button: find('pomodoro-button'), panel: find('pomodoro-panel') },
        { button: find('quick-button'), panel: find('quick-panel') },
    ];
    function setPopover(target, open) {
        for (const popover of popovers) {
            const show = popover === target && open;
            popover.panel.hidden = !show;
            popover.button.setAttribute('aria-expanded', String(show));
        }
        if (target === popovers[1] && open) refreshQuick();
    }
    for (const popover of popovers) {
        popover.button.addEventListener('click', () => setPopover(popover, popover.panel.hidden));
    }
    document.addEventListener('pointerdown', event => {
        if (!popovers.some(({ button, panel }) => button.contains(event.target) || panel.contains(event.target))) setPopover(null, false);
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') setPopover(null, false); });

    // ---------------------------------------------------------------
    // Theme (shared with the admin window through localStorage)
    // ---------------------------------------------------------------

    const themeButtons = [...find('quick-themes').querySelectorAll('button')];
    function applyTheme(name, save) {
        const theme = themeButtons.some(button => button.dataset.themeId === name) ? name : 'hakuji';
        document.documentElement.dataset.theme = theme;
        for (const button of themeButtons) button.setAttribute('aria-pressed', String(button.dataset.themeId === theme));
        if (save) { try { localStorage.setItem('kei-theme', theme); } catch { /* storage unavailable */ } }
    }
    let savedTheme = null;
    try { savedTheme = localStorage.getItem('kei-theme'); } catch { /* storage unavailable */ }
    applyTheme(savedTheme, false);
    for (const button of themeButtons) button.addEventListener('click', () => applyTheme(button.dataset.themeId, true));

    // ---------------------------------------------------------------
    // Quick controls
    // ---------------------------------------------------------------

    const observeSwitch = find('quick-observe');
    const observeStatus = find('quick-observe-status');
    const executorButtons = [...find('quick-executors').querySelectorAll('button')];
    const executorStatus = find('quick-executor-status');
    const quick = (action, value) => bridge?.quick
        ? bridge.quick(action, value)
        : Promise.reject(new Error('Kei Desktop のウィンドウ内でのみ利用できます'));

    function showObservation(state) {
        observeSwitch.setAttribute('aria-checked', String(state.enabled));
        find('observe-dot').hidden = !state.enabled;
        document.body.classList.toggle('observing', state.enabled);
        observeStatus.textContent = state.error ? `エラー：${state.error}`
            : !state.enabled ? `停止中${state.shortcut ? '（Ctrl + Alt + S でも切り替え）' : ''}`
            : state.busy ? '観察中 · 画面を認識しています' : '観察中';
    }
    function showExecutors(state) {
        for (const button of executorButtons) {
            button.setAttribute('aria-pressed', String(button.dataset.backend === state.backend));
            if (button.dataset.backend === 'codex') {
                button.disabled = !state.codexAvailable;
                button.title = state.codexAvailable ? '' : '権限の確認に失敗したため利用できません';
            }
        }
        executorStatus.textContent = state.activeTask ? `実行中のタスク：${state.activeTask}` : '待機中';
    }

    async function refreshObservation() {
        try {
            const state = await quick('observation');
            showObservation(state);
            considerSpeaking(state);
        } catch (error) { observeStatus.textContent = unwrap(error); }
    }

    // ---------------------------------------------------------------
    // Proactive speech (experimental)
    // A fresh, changed observation is shown to Kei, who answers with a short
    // remark or with the silence token. Silence is interrupted before it can
    // be spoken and every event of that turn is dropped (intercept below).
    // ---------------------------------------------------------------

    const proactive = new window.KeiProactiveModel.ProactiveModel();
    const proactiveSwitch = find('quick-proactive');
    const proactiveStatus = find('quick-proactive-status');
    const proactiveTurns = new Map();   // turnId -> 'asked' | 'silent'
    let silenceToken = '[[SILENT]]';
    let asking = false;

    function setProactive(enabled, save) {
        proactive.setEnabled(enabled, Date.now());
        proactiveSwitch.setAttribute('aria-checked', String(enabled));
        if (save) { try { localStorage.setItem('kei-proactive', enabled ? '1' : '0'); } catch { /* storage unavailable */ } }
    }
    let proactiveSaved = false;
    try { proactiveSaved = localStorage.getItem('kei-proactive') === '1'; } catch { /* storage unavailable */ }
    setProactive(proactiveSaved, false);
    proactiveSwitch.addEventListener('click', () => {
        const enable = proactiveSwitch.getAttribute('aria-checked') !== 'true';
        setProactive(enable, true);
        proactiveStatus.textContent = enable ? 'オン。画面観察中だけ働きます（最短 10 分おき）' : 'オフ';
    });

    async function considerSpeaking(observation) {
        const busy = asking || document.body.classList.contains('speaking') || Boolean(window.KeiConversation?.isPending());
        if (!proactive.shouldAsk(observation, { now: Date.now(), busy })) return;
        asking = true;
        proactive.asked(observation.description, Date.now());
        try {
            const { turnId, token } = await quick('proactive-ask');
            silenceToken = token || silenceToken;
            proactiveTurns.set(turnId, 'asked');
            while (proactiveTurns.size > 20) proactiveTurns.delete(proactiveTurns.keys().next().value);
            window.KeiConversation?.ignoreUserTurn(turnId);
        } catch (error) { console.warn('[Kei Proactive] not sent:', unwrap(error)); }
        finally { asking = false; }
    }

    window.KeiProactive = {
        // Called by app.js before anything else sees the event. True = drop it.
        intercept(event) {
            if (!event || typeof event !== 'object') return false;
            if (['user.transcript', 'user.message', 'tts.start'].includes(event.type) && event.session_id !== 'desktop-lifecycle') {
                proactive.noteTalk(Date.now());
            }
            const state = proactiveTurns.get(event.turn_id);
            if (!state || event.payload?.synthetic) return false;
            // The desktop's own prompt is never shown as something the user said.
            if (event.type === 'user.message') return true;
            if (state === 'asked' && event.type === 'assistant.reply') {
                const text = String(event.text || event.payload?.tts_text || '');
                if (text.includes(silenceToken) || !text.trim()) {
                    proactiveTurns.set(event.turn_id, 'silent');
                    // Stop the runtime before translation and speech begin.
                    quick('silence', event.turn_id).catch(error => console.warn('[Kei Proactive] silence failed:', unwrap(error)));
                    window.KeiReactions?.play('nothing-to-say');
                    return 'silence';
                }
            }
            return state === 'silent';
        },
        rules: proactive.rules,
    };
    async function refreshQuick() {
        refreshObservation();
        try { showExecutors(await quick('executors')); } catch (error) { executorStatus.textContent = `取得できません：${unwrap(error)}`; }
    }
    observeSwitch.addEventListener('click', async () => {
        try { showObservation(await quick('observe', observeSwitch.getAttribute('aria-checked') !== 'true')); }
        catch (error) { observeStatus.textContent = unwrap(error); }
    });
    for (const button of executorButtons) {
        button.addEventListener('click', async () => {
            executorStatus.textContent = '切り替えています…';
            try { showExecutors(await quick('executor', button.dataset.backend)); }
            catch (error) { executorStatus.textContent = `切り替えられませんでした：${unwrap(error)}`; }
        });
    }
    find('admin-button').addEventListener('click', () => { setPopover(null, false); bridge?.openAdmin(); });
    // Ctrl + Alt + S toggles the observer outside this window; keep the dot honest.
    if (bridge?.quick) { refreshObservation(); setInterval(refreshObservation, 3000); }

    // Shared with compact_ui.js and focus_ui.js.
    window.KeiShell = {
        showToast, showObservation, unwrap,
        // Popovers here; the backlog and reading sheets listen for the event.
        closeOverlays() {
            setPopover(null, false);
            document.dispatchEvent(new CustomEvent('kei:close-overlays'));
        },
    };
})();

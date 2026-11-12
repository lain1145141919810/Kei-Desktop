// Idle overview card. Shown while Kei is not searching or working (the work
// card takes its place when she is); in compact mode it appears beside her on
// hover. Every row opens the place it summarises.
(() => {
    const bridge = window.keiDesktop;
    const find = id => document.getElementById(id);
    const { build, dateLine } = window.KeiOverviewModel;
    const card = find('overview');
    const rowsElement = find('overview-rows');

    let plans = [];
    let stored = null;      // last answer from the saved conversation, until a live one exists
    let signature = '';

    async function refreshPlans() {
        try { plans = await bridge.reading('plans'); } catch { plans = []; }
    }
    async function loadLastAnswer() {
        try {
            const conversation = await bridge.history('current');
            const entry = [...(conversation?.entries || [])].reverse().find(item => item.role === 'kei');
            if (entry) stored = { text: entry.ja || entry.text, steps: entry.steps, interrupted: entry.status === 'interrupted' };
        } catch { /* nothing saved yet */ }
    }

    function readingRow() {
        if (!plans.length) return null;
        let active = null;
        try { active = localStorage.getItem('kei-reading-plan'); } catch { /* storage unavailable */ }
        // The plan used for questions, otherwise the most recently touched unfinished one.
        const plan = plans.find(item => item.id === active) || plans.find(item => !item.schedule.done) || plans[0];
        return { title: plan.title, ...plan.schedule };
    }

    const ACTIONS = {
        focus: () => find('pomodoro-button').click(),
        reading: () => find('reading-button').click(),
        quick: () => find('quick-button').click(),
        backlog: () => find('backlog-button').click(),
    };

    function render() {
        const overview = build({
            focus: window.KeiFocus?.snapshot() || null,
            reading: readingRow(),
            watch: {
                observing: document.body.classList.contains('observing'),
                proactive: find('quick-proactive').getAttribute('aria-checked') === 'true',
            },
            last: window.KeiConversation?.lastAnswer() || stored,
            connected: document.body.dataset.connection !== 'offline',
        });
        find('overview-date').textContent = dateLine(Date.now());
        find('overview-title').textContent = overview.title;
        // Rebuild only when something changed, so focus and hover are not lost every second.
        const next = JSON.stringify(overview.rows);
        if (next === signature) return;
        signature = next;
        rowsElement.replaceChildren(...overview.rows.map(row => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'overview-row';
            button.dataset.row = row.id;
            const label = document.createElement('span');
            label.className = 'overview-label';
            label.textContent = row.label;
            const value = document.createElement('span');
            value.className = 'overview-value';
            value.textContent = row.value;
            button.append(label, value);
            // The toolbar buttons close popovers on an outside press; open after that.
            button.addEventListener('click', () => setTimeout(ACTIONS[row.action], 0));
            return button;
        }));
    }

    if (bridge?.reading) { refreshPlans().then(render); setInterval(refreshPlans, 30000); }
    if (bridge?.history) loadLastAnswer().then(render);
    // Plans change in the reading sheet; pick them up when it closes.
    new MutationObserver(() => {
        if (!document.body.classList.contains('reading-open') && bridge?.reading) refreshPlans().then(render);
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    setInterval(render, 1000);
    render();
    card.hidden = false;
})();

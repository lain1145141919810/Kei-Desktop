// Reading sheet: ask Kei about a passage selected in the PDF reader, and keep
// reading plans (one per document) that can be reopened later.
(() => {
    const bridge = window.keiDesktop;
    const find = id => document.getElementById(id);
    const unwrap = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    const reading = (action, data) => bridge?.reading
        ? bridge.reading(action, data)
        : Promise.reject(new Error('Kei Desktop のウィンドウ内でのみ利用できます'));

    const sheet = find('reading');
    const openButton = find('reading-button');
    const passage = find('reading-passage');
    const source = find('reading-source');
    const question = find('reading-question-input');
    const askStatus = find('reading-ask-status');
    const planList = find('reading-plans');
    const planStatus = find('reading-plan-status');
    const form = find('reading-new');

    let activePlan = null;
    try { activePlan = localStorage.getItem('kei-reading-plan'); } catch { /* storage unavailable */ }
    let lastSource = '';

    function node(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }
    const monthDay = key => { const [, month, day] = key.split('-'); return `${Number(month)}月${Number(day)}日`; };

    // ---------------------------------------------------------------
    // Sheet
    // ---------------------------------------------------------------

    const isOpen = () => document.body.classList.contains('reading-open');
    function setOpen(open) {
        document.body.classList.toggle('reading-open', open);
        sheet.setAttribute('aria-hidden', String(!open));
        sheet.inert = !open;
        openButton.setAttribute('aria-expanded', String(open));
        if (open) { refreshPlans(); if (!passage.value) loadSelection(); }
    }
    openButton.addEventListener('click', () => setOpen(!isOpen()));
    find('reading-close').addEventListener('click', () => setOpen(false));
    find('reading-scrim').addEventListener('click', () => setOpen(false));
    document.addEventListener('kei:close-overlays', () => { if (isOpen()) setOpen(false); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && isOpen()) setOpen(false); });

    // ---------------------------------------------------------------
    // Passage and question
    // ---------------------------------------------------------------

    function showSelection(selection) {
        if (selection.text) passage.value = selection.text;
        lastSource = selection.source || '';
        source.textContent = selection.error || (selection.text
            ? `選択範囲を読み取りました${lastSource ? `：${lastSource}` : ''}。内容を確認してから質問してください。`
            : 'PDF で文章を選択して Ctrl + Alt + Q を押すか、コピーしてここに貼り付けてください。');
        // A new document name is a good default for a new plan.
        if (lastSource && !find('reading-new-title').value) find('reading-new-title').value = lastSource.slice(0, 120);
    }
    async function loadSelection() {
        try { showSelection(await reading('selection')); } catch (error) { source.textContent = unwrap(error); }
    }
    // Ctrl + Alt + Q in the reader: main.js brings this window forward and sends the selection.
    bridge?.onSelection?.(selection => {
        if (document.body.classList.contains('compact')) window.KeiCompact?.leave();
        setOpen(true);
        showSelection(selection);
        question.focus();
    });

    async function ask(text) {
        const asked = (text || question.value).trim();
        if (!passage.value.trim()) { askStatus.textContent = '先に、質問したい文章を入れてください。'; return; }
        if (!asked) { askStatus.textContent = '質問を入力してください。'; return; }
        askStatus.textContent = '送信中…';
        try {
            const { turnId } = await reading('ask', { text: passage.value, question: asked, planId: activePlan || undefined });
            const excerpt = passage.value.replace(/\s+/g, ' ').trim().slice(0, 60);
            window.KeiConversation?.addLocalUser(turnId, `${asked}\n（PDF の抜粋：${excerpt}${passage.value.trim().length > 60 ? '…' : ''}）`);
            question.value = '';
            askStatus.textContent = '';
            // Close so the answer, which appears in the dialogue column, is visible.
            setOpen(false);
        } catch (error) { askStatus.textContent = `送信できませんでした：${unwrap(error)}`; }
    }
    for (const chip of document.querySelectorAll('#reading-quick button')) {
        chip.addEventListener('click', () => ask(chip.dataset.question));
    }
    find('reading-ask').addEventListener('submit', event => { event.preventDefault(); ask(); });

    // ---------------------------------------------------------------
    // Plans
    // ---------------------------------------------------------------

    function setActive(id) {
        activePlan = id;
        try { if (id) localStorage.setItem('kei-reading-plan', id); else localStorage.removeItem('kei-reading-plan'); } catch { /* storage unavailable */ }
    }

    function planCard(plan) {
        const { schedule } = plan;
        const card = node('article', 'plan');
        card.dataset.planId = plan.id;
        const active = plan.id === activePlan;
        if (active) card.classList.add('is-active');

        const head = node('div', 'plan-head');
        head.append(node('div', 'plan-title', plan.title));
        const use = node('button', 'pill plan-use', active ? '質問に使用中' : '質問に使う');
        use.type = 'button';
        use.setAttribute('aria-pressed', String(active));
        use.title = 'オンにすると、質問にこの資料の名前と現在のページを添えます';
        use.addEventListener('click', () => { setActive(active ? null : plan.id); refreshPlans(); });
        head.append(use);
        card.append(head);

        const bar = node('div', 'plan-bar');
        const fill = node('i');
        fill.style.width = `${schedule.percent}%`;
        bar.append(fill);
        card.append(bar);
        card.append(node('div', 'plan-meta', `${plan.currentPage} / ${plan.totalPages} ページ（${schedule.percent}%）`));
        card.append(node('div', 'plan-today', schedule.done ? '読み終わりました。おつかれさまでした。'
            : schedule.todayDone ? `今日の分は達成（${schedule.readToday} ページ）。完了予定：${monthDay(schedule.finishDay)}`
            : `今日の目標：${schedule.todayFrom}〜${schedule.todayTo} ページ　完了予定：${monthDay(schedule.finishDay)}`));

        const row = node('form', 'plan-row');
        const page = node('input');
        page.type = 'number'; page.min = '0'; page.max = String(plan.totalPages); page.value = String(plan.currentPage);
        page.setAttribute('aria-label', 'いま読んだページ');
        const record = node('button', 'pill primary', 'ここまで読んだ');
        record.type = 'submit';
        row.append(node('span', 'plan-row-label', 'いま'), page, node('span', 'plan-row-label', 'ページ'), record);
        row.addEventListener('submit', async event => {
            event.preventDefault();
            try {
                const updated = await reading('progress', { id: plan.id, page: Number(page.value) });
                if (updated.schedule.todayDone && !schedule.todayDone) window.KeiReactions?.play('focus-done');
                planStatus.textContent = '';
                refreshPlans();
            } catch (error) { planStatus.textContent = unwrap(error); }
        });
        card.append(row);

        if (plan.notes.length) {
            const details = node('details', 'plan-notes');
            details.append(node('summary', '', `質問の記録（${plan.notes.length} 件）`));
            for (const note of [...plan.notes].reverse()) {
                const item = node('div', 'plan-note');
                const when = new Date(note.ts);
                item.append(node('div', 'plan-note-meta', `${when.getMonth() + 1}月${when.getDate()}日 · ${note.page} ページあたり`));
                item.append(node('div', 'plan-note-question', note.question));
                if (note.excerpt) item.append(node('div', 'plan-note-excerpt', note.excerpt));
                details.append(item);
            }
            card.append(details);
        }

        const remove = node('button', 'sheet-tool sheet-danger plan-remove', 'このプランを削除');
        remove.type = 'button';
        remove.addEventListener('click', async () => {
            // Deleting cannot be undone, so the button asks once.
            if (!remove.dataset.confirm) {
                remove.dataset.confirm = '1';
                remove.textContent = 'もう一度押すと削除';
                setTimeout(() => { delete remove.dataset.confirm; remove.textContent = 'このプランを削除'; }, 4000);
                return;
            }
            try {
                await reading('remove', plan.id);
                if (activePlan === plan.id) setActive(null);
                refreshPlans();
            } catch (error) { planStatus.textContent = unwrap(error); }
        });
        card.append(remove);
        return card;
    }

    async function refreshPlans() {
        try {
            const plans = await reading('plans');
            if (activePlan && !plans.some(plan => plan.id === activePlan)) setActive(null);
            planList.replaceChildren(...(plans.length ? plans.map(planCard)
                : [node('p', 'backlog-empty', 'まだ読書プランがありません。下のフォームから、読みたい資料ごとに作れます。')]));
        } catch (error) { planStatus.textContent = unwrap(error); }
    }

    form.addEventListener('submit', async event => {
        event.preventDefault();
        try {
            const plan = await reading('create', {
                title: find('reading-new-title').value,
                totalPages: Number(find('reading-new-total').value),
                pagesPerDay: Number(find('reading-new-daily').value),
            });
            form.reset();
            setActive(plan.id);
            planStatus.textContent = '';
            refreshPlans();
        } catch (error) { planStatus.textContent = unwrap(error); }
    });

    sheet.inert = true;
})();

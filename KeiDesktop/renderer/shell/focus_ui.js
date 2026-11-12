// Focus popover: Pomodoro timer and today's work list.
// A finished focus block is credited to the task in focus; a task can be
// handed to Kei, which sends it as an ordinary chat message.
(() => {
    const bridge = window.keiDesktop;
    const shell = window.KeiShell;
    const find = id => document.getElementById(id);
    const load = key => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
    const store = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } };

    const pomodoro = new window.KeiPomodoroModel.PomodoroModel(load('kei-pomodoro'));
    const tasks = new window.KeiTasksModel.TasksModel(load('kei-tasks'));
    const PHASES = { focus: '集中', break: '休憩', 'long-break': '長めの休憩' };

    const button = find('pomodoro-button');
    const chip = find('pomodoro-chip');
    const time = find('pomodoro-time');
    const phase = find('pomodoro-phase');
    const toggle = find('pomodoro-toggle');
    const presetButtons = [...find('pomodoro-presets').querySelectorAll('button')];
    const current = find('focus-current');
    const taskList = find('task-list');
    const taskStatus = find('task-status');

    function node(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }

    // ---------------------------------------------------------------
    // Timer
    // ---------------------------------------------------------------

    function renderTimer() {
        const left = Math.ceil(pomodoro.remainingAt(Date.now()) / 1000);
        const text = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
        chip.textContent = text;
        time.textContent = text;
        phase.textContent = PHASES[pomodoro.phase];
        toggle.textContent = pomodoro.running ? '一時停止' : '開始';
        button.dataset.phase = pomodoro.phase;
        button.dataset.running = String(pomodoro.running);
        for (const preset of presetButtons) preset.setAttribute('aria-pressed', String(preset.dataset.preset === pomodoro.preset));
        find('pomodoro-count').textContent = `今日の集中：${pomodoro.completed} 回`;
    }

    async function announce(finished) {
        const toBreak = finished === 'focus-done';
        let message = '休憩はここまで。集中の時間です。';
        if (toBreak) {
            const worked = tasks.creditBlock();
            if (worked) { store('kei-tasks', tasks); renderTasks(); }
            message = `${worked ? `「${worked.text}」に 1 回分集中しました。` : '集中おつかれさまでした。'}${PHASES[pomodoro.phase]}の時間です。`;
        }
        shell.showToast(message, 9000);
        window.KeiReactions?.play(finished);
        // Kei says it aloud unless she is in the middle of another line.
        if (!bridge?.say || document.body.classList.contains('speaking')) return;
        const key = !toBreak ? 'pomodoro-focus' : pomodoro.phase === 'long-break' ? 'pomodoro-long-break' : 'pomodoro-break';
        try { await bridge.say(key); } catch (error) { console.warn('[Kei Pomodoro] voice unavailable:', shell.unwrap(error)); }
    }

    const saveTimer = () => { store('kei-pomodoro', pomodoro); renderTimer(); };
    toggle.addEventListener('click', () => {
        if (pomodoro.running) pomodoro.pause(Date.now()); else pomodoro.start(Date.now());
        saveTimer();
    });
    find('pomodoro-skip').addEventListener('click', () => { pomodoro.skip(Date.now()); saveTimer(); });
    find('pomodoro-reset').addEventListener('click', () => { pomodoro.reset(); saveTimer(); });
    for (const preset of presetButtons) {
        preset.addEventListener('click', () => { pomodoro.setPreset(preset.dataset.preset); saveTimer(); });
    }
    setInterval(() => {
        const before = pomodoro.phase;
        const finished = pomodoro.tick(Date.now());
        // The phase also changes silently when the computer slept through its end.
        if (finished || pomodoro.phase !== before) store('kei-pomodoro', pomodoro);
        if (finished) announce(finished);
        renderTimer();
    }, 500);
    // A phase that ended while the app was closed is settled before first paint.
    if (pomodoro.tick(Date.now()) === null && !pomodoro.running) store('kei-pomodoro', pomodoro);

    // ---------------------------------------------------------------
    // Tasks
    // ---------------------------------------------------------------

    function changed() { store('kei-tasks', tasks); renderTasks(); }

    async function delegate(task, control) {
        if (!bridge?.sendChat) { taskStatus.textContent = 'Kei Desktop のウィンドウ内でのみ依頼できます'; return; }
        control.disabled = true;
        taskStatus.textContent = `${globalThis.KeiName?.() || 'ケイ'}に依頼しています…`;
        try {
            const text = `次のタスクをお願いします：${task.text}`;
            const { turnId } = await bridge.sendChat(text, []);
            window.KeiConversation?.addLocalUser(turnId, text);
            tasks.markDelegated(task.id);
            taskStatus.textContent = '';
            changed();
            // Close so that Kei's progress and answer are visible.
            shell.closeOverlays();
        } catch (error) {
            control.disabled = false;
            taskStatus.textContent = `依頼できませんでした：${shell.unwrap(error)}`;
        }
    }

    function taskRow(task) {
        const row = node('li', 'task');
        if (task.done) row.classList.add('is-done');
        if (task.id === tasks.focusId) row.classList.add('is-focus');

        const check = node('button', 'task-check', task.done ? '✓' : '');
        check.type = 'button';
        check.setAttribute('role', 'checkbox');
        check.setAttribute('aria-checked', String(task.done));
        check.setAttribute('aria-label', `${task.text} を完了にする`);
        check.addEventListener('click', () => { tasks.toggle(task.id); changed(); });

        const label = node('button', 'task-text', task.text);
        label.type = 'button';
        label.title = task.done ? '' : 'クリックで、いま取り組むタスクにする';
        label.disabled = task.done;
        label.addEventListener('click', () => { tasks.focus(task.id === tasks.focusId ? null : task.id); changed(); });

        row.append(check, label);
        if (task.blocks) row.append(node('span', 'task-blocks', `集中 ${task.blocks} 回`));
        if (!task.done) {
            const hand = node('button', 'task-hand', task.delegated ? '依頼済み' : '任せる');
            hand.type = 'button';
            hand.title = `このタスクを${globalThis.KeiName?.() || 'ケイ'}（実行エージェント）に依頼する`;
            hand.addEventListener('click', () => delegate(task, hand));
            row.append(hand);
        }
        const remove = node('button', 'task-remove', '×');
        remove.type = 'button';
        remove.setAttribute('aria-label', `${task.text} を削除`);
        remove.addEventListener('click', () => { tasks.remove(task.id); changed(); });
        row.append(remove);
        return row;
    }

    function renderTasks() {
        const list = tasks.list();
        taskList.replaceChildren(...list.map(taskRow));
        find('task-clear').hidden = !list.some(task => task.done);
        const focused = tasks.focused;
        current.textContent = focused ? `いま：${focused.text}` : '';
        button.title = focused ? `集中タイマーとタスク（いま：${focused.text}）` : '集中タイマーとタスク';
    }

    find('task-add').addEventListener('submit', event => {
        event.preventDefault();
        const field = find('task-input');
        try {
            if (tasks.add(field.value)) { field.value = ''; taskStatus.textContent = ''; changed(); }
        } catch (error) { taskStatus.textContent = error.message; }
    });
    find('task-clear').addEventListener('click', () => { tasks.clearDone(); changed(); });

    renderTimer();
    renderTasks();

    // For the idle overview.
    window.KeiFocus = {
        snapshot() {
            const open = tasks.tasks.filter(task => !task.done).length;
            return {
                phase: pomodoro.phase, running: pomodoro.running, completed: pomodoro.completed,
                remaining: pomodoro.remainingAt(Date.now()), total: pomodoro.duration(),
                task: tasks.focused?.text || '', openTasks: open,
            };
        },
    };
})();

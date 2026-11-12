// Builds the idle overview: what is going on while Kei is not searching or
// working. Pure: takes plain data, returns rows of text.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.KeiOverviewModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    const PHASES = { focus: '集中', break: '休憩', 'long-break': '長めの休憩' };
    const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
    const clip = (text, max) => {
        const clean = String(text || '').replace(/\s+/g, ' ').trim();
        return clean.length > max ? `${clean.slice(0, max)}…` : clean;
    };
    const clock = ms => {
        const seconds = Math.ceil(Math.max(0, ms) / 1000);
        return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    };

    function dateLine(now) {
        const date = new Date(now);
        return `${date.getMonth() + 1}月${date.getDate()}日（${WEEKDAYS[date.getDay()]}）`;
    }

    // focus: { phase, running, remaining, completed, task, openTasks }
    // reading: { title, done, todayDone, todayFrom, todayTo, readToday } | null
    // watch: { observing, proactive }
    // last: { text, steps: [{label,status,count}], interrupted } | null
    // Each row: { id, label, value, action } — action names the place it opens.
    function build({ focus, reading, watch, last, connected }) {
        const rows = [];
        if (focus) {
            const count = `今日 ${focus.completed} 回`;
            rows.push({
                id: 'timer', label: 'タイマー', action: 'focus',
                value: focus.running ? `${PHASES[focus.phase]}中 · 残り ${clock(focus.remaining)} · ${count}`
                    : focus.remaining < focus.total ? `一時停止中（${PHASES[focus.phase]} · 残り ${clock(focus.remaining)}） · ${count}`
                    : `止まっています · ${count}`,
            });
            rows.push({
                id: 'task', label: 'タスク', action: 'focus',
                value: focus.task ? `いま：${clip(focus.task, 34)}${focus.openTasks > 1 ? `（ほか ${focus.openTasks - 1} 件）` : ''}`
                    : focus.openTasks ? `${focus.openTasks} 件あります。取り組むものを選べます`
                    : 'まだありません',
            });
        }
        if (reading) {
            rows.push({
                id: 'reading', label: '読書', action: 'reading',
                value: `${clip(reading.title, 24)} · ${reading.done ? '読み終わりました'
                    : reading.todayDone ? `今日の分は達成（${reading.readToday} ページ）`
                    : `今日は ${reading.todayFrom}〜${reading.todayTo} ページ`}`,
            });
        }
        if (watch) {
            rows.push({
                id: 'watch', label: '見守り', action: 'quick',
                value: !watch.observing ? '画面観察はオフ'
                    : `画面観察中${watch.proactive ? ' · 気づいたら声をかけます' : ''}`,
            });
        }
        if (last?.text) {
            const steps = (last.steps || []).filter(step => step.status === 'completed');
            const did = steps.length ? `（${steps.slice(0, 2).map(step => step.label + (Number.isInteger(step.count) ? ` ${step.count} 件` : '')).join('・')}${steps.length > 2 ? ' ほか' : ''}）` : '';
            rows.push({
                id: 'last', label: last.interrupted ? 'さっき（中断）' : 'さっき', action: 'backlog',
                value: `${clip(last.text, 46)}${did}`,
            });
        }
        return {
            title: connected === false ? '接続を待っています' : '待機中',
            rows,
        };
    }

    return { build, dateLine, clock };
});

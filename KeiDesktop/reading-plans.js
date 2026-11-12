'use strict';
// Reading plans: one per document, kept in <userData>/reading-plans.json.
// The Edge integration (read-selection.ps1) exposes the selected text and the
// name of the element that holds it, but no page number, so the page a reader
// has reached is something they record themselves.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DAY = 86400000;
const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const dayKey = timestamp => {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

// Derived numbers the UI shows; nothing here is stored.
function schedule(plan, now) {
    const today = dayKey(now);
    const readToday = plan.log.filter(entry => entry.day === today).reduce((sum, entry) => sum + (entry.to - entry.from), 0);
    const remaining = Math.max(0, plan.totalPages - plan.currentPage);
    // Today's goal is fixed by where the day started, so reading ahead completes it.
    const startOfDay = plan.currentPage - readToday;
    const targetTo = Math.min(plan.totalPages, startOfDay + plan.pagesPerDay);
    const todayDone = plan.currentPage >= targetTo;
    // Full days still needed after today, at the planned pace.
    const laterDays = Math.ceil(Math.max(0, plan.totalPages - Math.max(targetTo, plan.currentPage)) / plan.pagesPerDay);
    return {
        remaining, readToday,
        percent: Math.round((plan.currentPage / plan.totalPages) * 100),
        done: remaining === 0,
        todayFrom: Math.min(plan.totalPages, plan.currentPage + 1),
        todayTo: targetTo,
        todayDone,
        finishDay: remaining === 0 ? null : dayKey(now + laterDays * DAY),
    };
}

module.exports = function createReadingPlans({ file, now = Date.now }) {
    let plans = [];
    try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(saved)) plans = saved.filter(plan => plan && typeof plan.id === 'string' && plan.totalPages > 0);
    } catch (error) {
        // A missing file is a first run; a damaged one is kept aside, not overwritten.
        if (error.code !== 'ENOENT') { try { fs.renameSync(file, `${file}.damaged`); } catch { /* keep going */ } }
    }

    function save() {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(plans, null, 1), 'utf8');
        fs.renameSync(`${file}.tmp`, file);
    }
    const view = plan => ({ ...plan, schedule: schedule(plan, now()) });
    const find = id => {
        const plan = plans.find(item => item.id === id);
        if (!plan) throw new Error('この読書プランは見つかりません');
        return plan;
    };
    const pages = (value, label, max) => {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1 || number > max) throw new Error(`${label}は 1〜${max} の整数で入力してください`);
        return number;
    };

    return {
        list: () => [...plans].sort((a, b) => b.updated - a.updated).map(view),
        get: id => view(find(id)),
        create(input = {}) {
            const title = clip(input.title, 120);
            if (!title) throw new Error('本や資料の名前を入力してください');
            const totalPages = pages(input.totalPages, '総ページ数', 20000);
            const pagesPerDay = pages(input.pagesPerDay, '1 日のページ数', totalPages);
            const timestamp = now();
            const plan = { id: randomUUID(), title, totalPages, pagesPerDay, currentPage: 0, created: timestamp, updated: timestamp, log: [], notes: [] };
            plans.push(plan);
            save();
            return view(plan);
        },
        // Record the page reached. Going backwards is allowed (a correction) and is not logged as reading.
        progress(id, page) {
            const plan = find(id);
            const number = Number(page);
            if (!Number.isInteger(number) || number < 0 || number > plan.totalPages) throw new Error(`ページは 0〜${plan.totalPages} で入力してください`);
            if (number > plan.currentPage) plan.log.push({ day: dayKey(now()), from: plan.currentPage, to: number });
            else plan.log = plan.log.filter(entry => entry.from < number).map(entry => ({ ...entry, to: Math.min(entry.to, number) }));
            plan.log = plan.log.slice(-400);
            plan.currentPage = number;
            plan.updated = now();
            save();
            return view(plan);
        },
        // A question asked while reading: what was asked, about which passage, at which page.
        note(id, { question, excerpt }) {
            const plan = find(id);
            plan.notes.push({ ts: now(), page: plan.currentPage, question: clip(question, 300), excerpt: clip(excerpt, 240) });
            plan.notes = plan.notes.slice(-200);
            plan.updated = now();
            save();
            return view(plan);
        },
        remove(id) {
            find(id);
            plans = plans.filter(plan => plan.id !== id);
            save();
            return true;
        },
    };
};
module.exports.schedule = schedule;

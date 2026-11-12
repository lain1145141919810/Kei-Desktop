'use strict';
// Desktop-side conversation log. The installed KeiRuntime exposes no history
// route, so the only record a user can reopen is what this client saw on its
// own socket (or typed itself) while it was running.
//
// Format: <dir>/YYYY-MM.jsonl, one JSON entry per line, append-only.
// A later line with the same conversation + id replaces the earlier one.
const fs = require('fs');
const path = require('path');

const ROLES = new Set(['user', 'kei']);
const SOURCES = new Set(['voice', 'text']);
const STATUSES = new Set(['interrupted']);
const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

module.exports = function createConversationStore({ dir, now = Date.now, gapMs = Infinity }) {
    const conversations = new Map();
    let currentId = null;
    let sequence = 0;

    const fileFor = timestamp => path.join(dir, `${new Date(timestamp).toISOString().slice(0, 7)}.jsonl`);
    const files = () => fs.readdirSync(dir).filter(name => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort();

    function merge(entry) {
        if (!entry || typeof entry.conv !== 'string' || typeof entry.id !== 'string'
            || !ROLES.has(entry.role) || !Number.isFinite(entry.ts)) return null;
        let conversation = conversations.get(entry.conv);
        if (!conversation) {
            conversation = { id: entry.conv, started: entry.ts, updated: entry.ts, entries: new Map() };
            conversations.set(entry.conv, conversation);
        }
        conversation.entries.set(entry.id, entry);
        conversation.started = Math.min(conversation.started, entry.ts);
        conversation.updated = Math.max(conversation.updated, entry.updated || entry.ts);
        return conversation;
    }

    fs.mkdirSync(dir, { recursive: true });
    for (const name of files()) {
        for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
            if (!line.trim()) continue;
            // A torn final line after a crash must not hide the rest of the log.
            try { merge(JSON.parse(line)); } catch { /* skip damaged line */ }
        }
    }
    const latest = [...conversations.values()].sort((a, b) => b.updated - a.updated)[0];
    if (latest && now() - latest.updated <= gapMs) currentId = latest.id;

    const selectionFile = path.join(dir, 'selected.thread');
    if (fs.existsSync(selectionFile)) {
        const saved = fs.readFileSync(selectionFile, 'utf8');
        currentId = conversations.has(saved) || saved.startsWith('auto-') ? saved : null;
    }
    function select(id) {
        if (id && !conversations.has(id)) throw new Error('Unknown conversation');
        fs.writeFileSync(selectionFile + '.tmp', id || '', 'utf8');
        fs.renameSync(selectionFile + '.tmp', selectionFile);
        currentId = id;
    }
    function record(input) {
        if (!input || typeof input.id !== 'string' || !input.id || input.id.length > 200
            || !ROLES.has(input.role)) throw new Error('Invalid conversation entry');
        const text = clip(input.text, 20000);
        const ja = clip(input.ja, 20000);
        if (!text.trim() && !ja.trim()) throw new Error('Empty conversation entry');
        const timestamp = now();
        let conversation = conversations.get(currentId);
        const existing = conversation?.entries.get(input.id);
        if (!existing && (!conversation || timestamp - conversation.updated > gapMs)) {
            if (!currentId?.startsWith("auto-") || conversation) currentId = `c-${timestamp.toString(36)}-${(sequence++).toString(36)}`;
            conversation = null;
        }
        const entry = {
            conv: currentId, id: input.id, role: input.role,
            ts: existing ? existing.ts : timestamp, updated: timestamp, text,
        };
        if (ja) entry.ja = ja;
        if (SOURCES.has(input.source)) entry.source = input.source;
        if (STATUSES.has(input.status)) entry.status = input.status;
        if (typeof input.turn === 'string' && input.turn) entry.turn = input.turn.slice(0, 200);
        if (typeof input.summary === 'string' && input.summary.trim()) entry.summary = input.summary.slice(0, 4000);
        // What Kei did during the turn: [{ label, status, count? }]
        if (Array.isArray(input.steps)) {
            const steps = input.steps.slice(-12)
                .filter(step => step && typeof step.label === 'string' && step.label.trim())
                .map(step => ({
                    label: step.label.slice(0, 40),
                    status: ['running', 'completed', 'failed', 'cancelled'].includes(step.status) ? step.status : 'completed',
                    ...(Number.isInteger(step.count) && step.count >= 0 ? { count: step.count } : {}),
                }));
            if (steps.length) entry.steps = steps;
        }
        if (Array.isArray(input.files)) {
            const names = input.files.filter(name => typeof name === 'string' && name).slice(0, 5).map(name => name.slice(0, 160));
            if (names.length) entry.files = names;
        }
        fs.appendFileSync(fileFor(entry.ts), `${JSON.stringify(entry)}\n`, 'utf8');
        merge(entry);
        if (!existing) select(currentId);
        return entry;
    }

    function describe(conversation, query) {
        const entries = [...conversation.entries.values()].sort((a, b) => a.ts - b.ts);
        const first = entries.find(entry => entry.role === 'user') || entries[0];
        const summary = {
            id: conversation.id, started: conversation.started, updated: conversation.updated,
            count: entries.length, current: conversation.id === currentId,
            title: (first?.text || first?.ja || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        };
        if (!query) return summary;
        const hit = entries.find(entry => `${entry.text}\n${entry.ja || ''}`.toLowerCase().includes(query));
        if (!hit) return null;
        const body = `${hit.text} ${hit.ja || ''}`.replace(/\s+/g, ' ');
        const at = Math.max(0, body.toLowerCase().indexOf(query) - 18);
        summary.snippet = (at > 0 ? '…' : '') + body.slice(at, at + 80);
        return summary;
    }

    function list({ query = '', limit = 200 } = {}) {
        const needle = clip(query, 200).trim().toLowerCase();
        return [...conversations.values()]
            .sort((a, b) => b.updated - a.updated)
            .map(conversation => describe(conversation, needle))
            .filter(Boolean)
            .slice(0, Math.max(1, Math.min(500, Number(limit) || 200)));
    }

    function read(id) {
        const conversation = conversations.get(id);
        if (!conversation) return null;
        return {
            ...describe(conversation, ''),
            entries: [...conversation.entries.values()].sort((a, b) => a.ts - b.ts),
        };
    }

    function current() {
        const conversation = conversations.get(currentId);
        // An idle gap closes the conversation even before the next entry arrives.
        if (!conversation || now() - conversation.updated > gapMs) return null;
        return read(currentId);
    }

    function rewrite(keep) {
        for (const name of files()) {
            const file = path.join(dir, name);
            const kept = fs.readFileSync(file, 'utf8').split('\n').filter(line => {
                if (!line.trim()) return false;
                try { return keep(JSON.parse(line)); } catch { return false; }
            });
            if (!kept.length) { fs.unlinkSync(file); continue; }
            fs.writeFileSync(`${file}.tmp`, `${kept.join('\n')}\n`, 'utf8');
            fs.renameSync(`${file}.tmp`, file);
        }
    }

    function dropTurns(turns, legacy) {
        const ids = new Set(turns);
        const matches = e => ids.has(e.turn) || (legacy && e.conv === legacy);
        rewrite(e => !matches(e));
        for (const [id,conv] of conversations) {
            for (const [key,e] of conv.entries) if (matches(e)) conv.entries.delete(key);
            if (!conv.entries.size) conversations.delete(id);
        }
        if (!conversations.has(currentId)) select(null);
    }
    function rollover(turn, thread) {
        const id = 'auto-' + thread;
        if (currentId === id) return;
        const last = conversations.get(currentId);
        const moved = last ? [...last.entries.values()].filter(e => e.turn === turn) : [];
        for (const entry of moved) {
            const next = {...entry, conv:id};
            fs.appendFileSync(fileFor(entry.ts), JSON.stringify(next)+'\n','utf8');
            merge(next);
        }
        if (moved.length) {
            rewrite(e => !(e.conv === last.id && e.turn === turn));
            for (const e of moved) last.entries.delete(e.id);
        }
        currentId = id;
        fs.writeFileSync(selectionFile,id,'utf8');
    }

    function remove(id) {
        if (!conversations.has(id)) return false;
        rewrite(entry => entry.conv !== id);
        conversations.delete(id);
        if (currentId === id) currentId = null;
        return true;
    }

    function clear() {
        rewrite(() => false);
        conversations.clear();
        fs.rmSync(selectionFile, {force:true});
        currentId = null;
        return true;
    }

    return { rollover, dropTurns, select, record, list, read, current, remove, clear, dir };
};

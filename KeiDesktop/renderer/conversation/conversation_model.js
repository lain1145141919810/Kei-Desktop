// Turns the runtime's event stream into transcript entries.
// Pure logic: no DOM and no IPC, so it runs unchanged under node --test.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.KeiConversationModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    // The login announcement is a recorded lifecycle line, not conversation.
    const IGNORED_SESSIONS = new Set(['desktop-lifecycle']);

    class ConversationModel {
        constructor({ persist = () => {}, onPending = () => {}, describeStep = () => null, now = Date.now } = {}) {
            this.persist = persist;
            // Turns a tool payload into a user-facing label, or null to hide it.
            this.describeStep = describeStep;
            this.steps = new Map();
            this.onPending = onPending;
            this.now = now;
            this.entries = new Map();
            this.translations = new Map();
            this.localTurns = new Set();
            this.spokenTurns = new Set();
            this.pendingTurn = null;
            this.sequence = 0;
        }

        _trim(collection, max) {
            while (collection.size > max) collection.delete(collection.keys().next().value);
        }

        _upsert(id, patch) {
            const entry = { ...(this.entries.get(id) || { id }), ...patch };
            if (!String(entry.text || '').trim() && !String(entry.ja || '').trim()) return null;
            this.entries.delete(id);
            this.entries.set(id, entry);
            this._trim(this.entries, 60);
            this.persist({ ...entry });
            return entry;
        }

        _setPending(turnId) {
            if (this.pendingTurn === turnId) return;
            this.pendingTurn = turnId;
            this.onPending(turnId);
        }

        // A message typed in this window. The runtime may or may not echo it.
        addLocalUser(turnId, text, files = []) {
            this.localTurns.add(turnId);
            this._trim(this.localTurns, 60);
            this._setPending(turnId);
            const patch = { role: 'user', source: 'text', turn: turnId, text };
            if (files.length) patch.files = files;
            return this._upsert(`u:${turnId}`, patch);
        }

        // Task steps are kept per turn and written onto Kei's entry, so the
        // backlog can say what she did even after the work card is gone.
        _step(turnId, payload, status) {
            if (!turnId) return null;
            const name = String(payload.tool_name || '');
            const steps = this.steps.get(turnId) || [];
            if (status === 'running') {
                const label = this.describeStep(payload);
                if (!label) return null;
                steps.push({ label, status, tool: name });
                this.steps.set(turnId, steps.slice(-12));
                this._trim(this.steps, 30);
            } else {
                const open = [...steps].reverse().find(step => step.status === 'running' && step.tool === name);
                if (!open) return null;
                open.status = status;
                if (Number.isInteger(payload.result_count) && payload.result_count >= 0) open.count = payload.result_count;
            }
            return this._writeSteps(turnId);
        }

        _publicSteps(turnId) {
            return (this.steps.get(turnId) || []).map(({ label, status, count }) =>
                (count === undefined ? { label, status } : { label, status, count }));
        }

        _writeSteps(turnId) {
            // Only an entry that already has words can carry steps.
            if (!this.entries.has(`k:${turnId}`)) return null;
            return this._upsert(`k:${turnId}`, { steps: this._publicSteps(turnId) });
        }

        _cancelSteps(turnId) {
            const steps = this.steps.get(turnId) || [];
            let changed = false;
            for (const step of steps) if (step.status === 'running') { step.status = 'cancelled'; changed = true; }
            return changed;
        }

        clearPending() {
            this._setPending(null);
        }

        // The socket dropped: nothing still "running" will report back.
        disconnected() {
            this._setPending(null);
            for (const turnId of this.steps.keys()) {
                if (this._cancelSteps(turnId)) this._writeSteps(turnId);
            }
        }

        handle(event) {
            if (!event || typeof event !== 'object' || IGNORED_SESSIONS.has(event.session_id)) return null;
            const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
            const turnId = typeof event.turn_id === 'string' && event.turn_id ? event.turn_id : null;
            switch (event.type) {
                case 'user.transcript': {
                    const text = String(event.text || payload.text || '').trim();
                    if (!text) return null;
                    const id = turnId ? `u:${turnId}` : `u:voice-${this.now()}-${this.sequence++}`;
                    return this._upsert(id, { role: 'user', source: 'voice', turn: turnId || undefined, text });
                }
                case 'user.message': {
                    const text = String(event.text || '').trim();
                    if (!text || (turnId && this.localTurns.has(turnId))) return null;
                    const id = turnId ? `u:${turnId}` : `u:text-${this.now()}-${this.sequence++}`;
                    return this._upsert(id, { role: 'user', source: 'text', turn: turnId || undefined, text });
                }
                case 'assistant.reply': {
                    this._setPending(null);
                    const text = String(event.text || payload.tts_text || '').trim();
                    if (!turnId || !text) return null;
                    const patch = { role: 'kei', turn: turnId, text };
                    if (typeof payload.result_summary === 'string' && payload.result_summary.trim()) {
                        patch.summary = payload.result_summary.trim();
                    }
                    const ja = this._japanese(turnId);
                    if (ja) patch.ja = ja;
                    if (this.steps.has(turnId)) patch.steps = this._publicSteps(turnId);
                    return this._upsert(`k:${turnId}`, patch);
                }
                case 'assistant.translation': {
                    const japanese = String(event.text || payload.text || '').trim();
                    if (!turnId || !japanese) return null;
                    if (!this.translations.has(turnId)) this.translations.set(turnId, new Map());
                    this.translations.get(turnId).set(Number(payload.segment_index || 1), japanese);
                    this._trim(this.translations, 30);
                    return this._upsert(`k:${turnId}`, { role: 'kei', turn: turnId, ja: this._japanese(turnId) });
                }
                case 'agent.tool.start':
                    return this._step(turnId, payload, 'running');
                case 'agent.tool.end':
                    return this._step(turnId, payload, payload.status === 'failed' ? 'failed' : 'completed');
                case 'tts.start':
                    this._setPending(null);
                    return null;
                case 'tts.end': {
                    if (turnId && (payload.segment_final ?? true) && payload.status === 'completed') {
                        this.spokenTurns.add(turnId);
                        this._trim(this.spokenTurns, 60);
                    }
                    return null;
                }
                case 'agent.done':
                    if (payload.has_reply === false) this._setPending(null);
                    return null;
                case 'interrupt':
                case 'task.cancel': {
                    if (!turnId || turnId === this.pendingTurn) this._setPending(null);
                    // Late interrupts for an answer that finished speaking are stale.
                    if (!turnId || this.spokenTurns.has(turnId)) return null;
                    this._cancelSteps(turnId);
                    if (!this.entries.has(`k:${turnId}`)) return null;
                    return this._upsert(`k:${turnId}`, { status: 'interrupted', steps: this._publicSteps(turnId) });
                }
                default:
                    return null;
            }
        }

        _japanese(turnId) {
            const segments = this.translations.get(turnId);
            if (!segments) return '';
            return [...segments.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join('');
        }
    }

    return { ConversationModel };
});

// Pomodoro timer logic. Pure: time is passed in, nothing is scheduled here.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.KeiPomodoroModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    const MINUTE = 60000;
    // [focus, short break, long break] in minutes; every 4th break is long.
    const PRESETS = { '25': [25, 5, 15], '50': [50, 10, 20], '15': [15, 3, 10] };

    class PomodoroModel {
        constructor(saved) {
            this.preset = '25';
            this.phase = 'focus';
            this.running = false;
            this.endsAt = 0;
            this.remaining = this.duration();
            this.completed = 0;
            this.day = '';
            if (saved && typeof saved === 'object') this._restore(saved);
        }

        duration(phase = this.phase) {
            const [focus, short, long] = PRESETS[this.preset];
            return (phase === 'focus' ? focus : phase === 'long-break' ? long : short) * MINUTE;
        }

        _restore(saved) {
            if (PRESETS[saved.preset]) this.preset = saved.preset;
            if (['focus', 'break', 'long-break'].includes(saved.phase)) this.phase = saved.phase;
            this.completed = Number.isInteger(saved.completed) && saved.completed >= 0 ? saved.completed : 0;
            this.day = typeof saved.day === 'string' ? saved.day : '';
            const remaining = Number(saved.remaining);
            this.remaining = remaining > 0 && remaining <= this.duration() ? remaining : this.duration();
            this.running = saved.running === true && Number.isFinite(saved.endsAt);
            this.endsAt = this.running ? saved.endsAt : 0;
        }

        toJSON() {
            return { preset: this.preset, phase: this.phase, running: this.running, endsAt: this.endsAt,
                remaining: this.remaining, completed: this.completed, day: this.day };
        }

        _today(now) {
            const date = new Date(now);
            const day = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
            if (day !== this.day) { this.day = day; this.completed = 0; }
        }

        remainingAt(now) {
            return this.running ? Math.max(0, this.endsAt - now) : this.remaining;
        }

        start(now) {
            if (this.running) return;
            this._today(now);
            this.running = true;
            this.endsAt = now + this.remaining;
        }

        pause(now) {
            if (!this.running) return;
            this.remaining = this.remainingAt(now) || this.duration();
            this.running = false;
            this.endsAt = 0;
        }

        reset() {
            this.running = false;
            this.endsAt = 0;
            this.phase = 'focus';
            this.remaining = this.duration();
        }

        setPreset(preset) {
            if (!PRESETS[preset] || preset === this.preset) return;
            this.preset = preset;
            this.reset();
        }

        _advance(now, countFocus) {
            if (this.phase === 'focus') {
                if (countFocus) { this._today(now); this.completed += 1; }
                this.phase = countFocus && this.completed % 4 === 0 ? 'long-break' : 'break';
            } else {
                this.phase = 'focus';
            }
            this.remaining = this.duration();
        }

        // Moves to the next phase by hand. A skipped focus block is not counted.
        skip(now) {
            const wasRunning = this.running;
            this.running = false;
            this._advance(now, false);
            if (wasRunning) this.start(now);
        }

        // Call regularly. Returns 'focus-done' or 'break-done' when a phase ends
        // while the app is watching; the next phase then starts by itself.
        // A phase that ended more than a minute ago (the app was closed or the
        // computer slept) advances silently and waits for the user.
        tick(now) {
            if (!this.running || now < this.endsAt) return null;
            const stale = now - this.endsAt > MINUTE;
            const finished = this.phase;
            this.running = false;
            this._advance(now, true);
            if (stale) return null;
            this.start(now);
            return finished === 'focus' ? 'focus-done' : 'break-done';
        }
    }

    return { PomodoroModel, PRESETS };
});

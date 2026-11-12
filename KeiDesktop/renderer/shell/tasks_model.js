// Today's work list, shown with the focus timer. Pure: no DOM, no storage.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.KeiTasksModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    const MAX_TASKS = 50;

    class TasksModel {
        constructor(saved, now = Date.now) {
            this.now = now;
            this.tasks = [];
            this.focusId = null;
            this.sequence = 0;
            if (saved && Array.isArray(saved.tasks)) {
                this.tasks = saved.tasks
                    .filter(task => task && typeof task.id === 'string' && typeof task.text === 'string' && task.text.trim())
                    .slice(0, MAX_TASKS)
                    .map(task => ({
                        id: task.id, text: task.text.slice(0, 200), done: task.done === true,
                        blocks: Number.isInteger(task.blocks) && task.blocks > 0 ? task.blocks : 0,
                        delegated: task.delegated === true, created: Number(task.created) || 0,
                    }));
                if (this.find(saved.focusId) && !this.find(saved.focusId).done) this.focusId = saved.focusId;
            }
        }

        toJSON() { return { tasks: this.tasks, focusId: this.focusId }; }
        find(id) { return this.tasks.find(task => task.id === id) || null; }
        get focused() { return this.find(this.focusId); }

        // Open tasks in the order they were added, finished ones after them.
        list() {
            return [...this.tasks].sort((a, b) => Number(a.done) - Number(b.done) || a.created - b.created);
        }

        add(text) {
            const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
            if (!clean) return null;
            if (this.tasks.filter(task => !task.done).length >= MAX_TASKS) throw new Error(`タスクは ${MAX_TASKS} 件までです`);
            const created = this.now();
            const task = { id: `t${created.toString(36)}${(this.sequence++).toString(36)}`, text: clean, done: false, blocks: 0, delegated: false, created };
            this.tasks.push(task);
            // The first thing written down is what the user is about to work on.
            if (!this.focused) this.focusId = task.id;
            return task;
        }

        toggle(id) {
            const task = this.find(id);
            if (!task) return null;
            task.done = !task.done;
            if (task.done && this.focusId === id) {
                // Move on to the next open task, if there is one.
                this.focusId = this.list().find(other => !other.done)?.id || null;
            }
            return task;
        }

        focus(id) {
            const task = this.find(id);
            this.focusId = task && !task.done ? id : null;
        }

        remove(id) {
            this.tasks = this.tasks.filter(task => task.id !== id);
            if (this.focusId === id) this.focusId = null;
        }

        markDelegated(id) {
            const task = this.find(id);
            if (task) task.delegated = true;
        }

        // A finished focus block counts toward the task being worked on.
        creditBlock() {
            const task = this.focused;
            if (task) task.blocks += 1;
            return task;
        }

        clearDone() {
            this.tasks = this.tasks.filter(task => !task.done);
        }
    }

    return { TasksModel };
});

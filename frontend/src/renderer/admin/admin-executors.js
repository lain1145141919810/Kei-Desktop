"use strict";
// Admin: 実行エージェント — dynamic adapter discovery, task submission, ordered progress,
// input requests, results, and cancellation shown as requested vs confirmed.

(function () {
    const api = window.kei.executors;
    const $ = id => document.getElementById(id);
    const { errorText } = window.KeiPluginFrames;

    const CAPABILITY_LABEL = { progress: "進捗", cancel: "中止", input: "入力", attachments: "添付", artifacts: "成果物", followUp: "続きの依頼" };
    const STATUS = {
        queued: ["待機中", "off"],
        running: ["実行中", "on"],
        waiting_for_input: ["入力待ち", "warn"],
        cancelling: ["中止を要求済み（確認待ち）", "warn"],
        succeeded: ["完了", "on"],
        failed: ["失敗", "bad"],
        cancelled: ["中止を確認しました", "bad"],
    };
    const EVENT = {
        "task.queued": "受付",
        "task.started": "開始",
        "task.progress": "進捗",
        "task.input_requested": "入力を要求",
        "task.input_received": "入力を受信",
        "task.cancel_requested": "中止を要求（未確認）",
        "task.cancelled": "中止を確認",
        "task.succeeded": "完了",
        "task.failed": "失敗",
    };
    const ACTIVE = new Set(["queued", "running", "waiting_for_input"]);

    function el(tag, props = {}, ...children) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (value === undefined || value === null || value === false) continue;
            if (key === "class") node.className = value;
            else if (key === "text") node.textContent = value;
            else if (key === "dataset") Object.assign(node.dataset, value);
            else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
            else node.setAttribute(key, value === true ? "" : value);
        }
        node.append(...children.filter(c => c !== null && c !== undefined && c !== false));
        return node;
    }

    let toastTimer;
    function toast(text) {
        const node = document.getElementById("toast");
        node.textContent = text;
        node.classList.add("visible");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => node.classList.remove("visible"), 3600);
    }

    let executors = [];
    const tasks = new Map(); // id -> { task, events: Map(seq -> event) }

    const executorName = id => executors.find(e => e.id === id)?.name || id;
    const reasonText = reason => (reason ? errorText(reason) : "");

    // ---------------------------------------------------------------- adapters
    function renderExecutors() {
        $("executor-list").replaceChildren(...executors.map(e => el("article", {
            class: "card executor-card", dataset: { executorId: e.id, available: String(e.available) },
        },
        el("div", { class: "plugin-head" },
            el("span", { class: "plugin-name", text: e.name }),
            el("span", { class: "plugin-id", text: e.id }),
            el("span", { class: `badge plugin-state ${e.available ? "on" : "off"}`, text: e.available ? "利用可" : "利用不可" })),
        !e.available && el("div", { class: "reason", text: `${reasonText(e.reason)}（${e.reason}）` }),
        el("div", { class: "chips" }, ...Object.entries(CAPABILITY_LABEL).map(([key, label]) =>
            el("span", { class: `chip ${e.capabilities[key] ? "on" : ""}`, text: label, title: e.capabilities[key] ? "対応" : "非対応" }))),
        e.options?.models?.length ? el("div", { class: "note", text: `モデル：${e.options.models.map(m => m.label).join("、")}` }) : null)));

        const select = $("task-executor");
        const previous = select.value;
        select.replaceChildren(...executors.map(e => el("option", {
            value: e.id, disabled: !e.available, text: e.available ? e.name : `${e.name}（${reasonText(e.reason) || "利用不可"}）`,
        })));
        const firstAvailable = executors.find(e => e.available);
        if (!firstAvailable) select.prepend(el("option", { value: "", disabled: true, text: "使える実行エージェントがありません" }));
        select.value = executors.some(e => e.id === previous && e.available) ? previous : (firstAvailable?.id ?? "");
        $("task-submit").disabled = !firstAvailable;
        const available = executors.filter(e => e.available).length;
        $("executor-summary").textContent = `${executors.length} 件 · 利用可 ${available} 件`;
        renderModelOptions();
    }

    function renderModelOptions() {
        const executor = executors.find(e => e.id === $("task-executor").value);
        const models = executor?.options?.models || [];
        $("task-model-field").hidden = models.length === 0;
        $("task-model").replaceChildren(el("option", { value: "", text: "既定" }), ...models.map(m => el("option", { value: m.id, text: m.label })));
    }
    $("task-executor").addEventListener("change", renderModelOptions);

    async function refreshExecutors() {
        const response = await api.list().catch(() => null);
        if (!response?.ok) {
            $("executor-summary").textContent = errorText(response?.error?.code || "host_unavailable");
            return;
        }
        executors = response.executors;
        renderExecutors();
        renderTasks();
    }

    // ---------------------------------------------------------------- tasks
    function upsertTask(task) {
        const entry = tasks.get(task.id) || { task, events: new Map() };
        // Keep locally known input/cancel details when a later snapshot lacks them.
        entry.task = { ...entry.task, ...task, input: task.input ?? entry.task.input, cancel: task.cancel ?? entry.task.cancel };
        tasks.set(task.id, entry);
        return entry;
    }

    function eventLine(event) {
        const label = EVENT[event.type] || event.type;
        const d = event.data || {};
        let detail = "";
        if (event.type === "task.progress") detail = d.stage ? `：${d.stage}` : (d.message ? `：${d.message}` : "");
        else if (event.type === "task.input_requested") detail = d.prompt ? `：${d.prompt}` : "";
        else if (event.type === "task.failed" || event.type === "task.cancelled") detail = d.code ? `：${errorText(d.code)}` : "";
        const cls = event.type === "task.cancel_requested" ? "cancel-requested"
            : event.type === "task.cancelled" ? "cancel-confirmed"
                : event.type === "task.succeeded" ? "done" : "";
        return el("li", { class: cls, dataset: { type: event.type, sequence: String(event.sequence) } },
            el("span", { class: "seq", text: `#${event.sequence}` }), `${label}${detail}`);
    }

    function taskCard(entry) {
        const t = entry.task;
        const executor = executors.find(e => e.id === t.executorId);
        const [statusLabel, statusClass] = STATUS[t.status] || [t.status, "off"];
        const events = [...entry.events.values()].sort((a, b) => a.sequence - b.sequence);
        const canCancel = ACTIVE.has(t.status) && executor?.capabilities?.cancel !== false;

        const cancelInfo = t.cancel ? el("div", { class: "warning", dataset: { cancelAccepted: String(t.cancel.accepted), cancelConfirmed: String(t.cancel.confirmed) } },
            t.status === "cancelled"
                ? "中止を確認しました。"
                : t.cancel.confirmed ? "中止は確認済みです。"
                    : t.cancel.accepted ? "中止を要求しました。ホストは要求を受け付けました（まだ確認されていません）。" : "中止の要求は受け付けられませんでした。") : null;

        let inputBox = null;
        if (t.status === "waiting_for_input" && t.inputRequest) {
            const field = el("input", { class: "tool-args", type: "text", maxlength: "4000", "aria-label": t.inputRequest.prompt });
            inputBox = el("form", { class: "row task-answer", onsubmit: async event => {
                event.preventDefault();
                field.blur();
                const response = await api.answer(t.id, t.inputRequest.id, field.value);
                if (!response?.ok) toast(errorText(response?.error?.code));
            } },
            el("span", { class: "note", text: `入力を求められています：${t.inputRequest.prompt}` }), field,
            el("button", { type: "submit", class: "small", text: "送信" }));
        }

        const result = t.result ? el("div", { class: "result" },
            el("h3", { text: "結果" }), el("div", { class: "well task-result", text: t.result.text || "（テキストなし）" }),
            t.result.artifacts.length ? el("div", { class: "note", text: `成果物：${t.result.artifacts.join("、")}` }) : null) : null;

        const error = t.error && t.status !== "cancelled" ? el("div", { class: "error", text: `${errorText(t.error.code)}（${t.error.code}）` }) : null;
        const sideEffects = t.error?.mayHaveSideEffects ? el("div", { class: "warning", text: "開始後に停止したため、一部の操作が実行済みの可能性があります。" }) : null;

        return el("article", { class: "card task-card", dataset: { taskId: t.id, status: t.status, executorId: t.executorId } },
            el("div", { class: "task-head" },
                el("span", { class: "plugin-name", text: executorName(t.executorId) }),
                el("span", { class: "plugin-id", text: t.requestId }),
                el("span", { class: `badge task-status ${statusClass}`, text: statusLabel })),
            t.input ? el("div", { class: "task-input", text: t.input }) : null,
            el("ol", { class: "timeline", "aria-label": "進捗" }, ...events.map(eventLine)),
            cancelInfo, inputBox, result, error, sideEffects,
            canCancel ? el("div", { class: "row" }, el("button", {
                type: "button", class: "ghost small", "data-action": "cancel",
                onclick: async event => {
                    event.currentTarget.disabled = true;
                    const response = await api.cancel(t.id);
                    if (!response?.ok) toast(errorText(response?.error?.code));
                },
            }, "中止を要求")) : null);
    }

    function renderTasks() {
        const list = [...tasks.values()].sort((a, b) => (b.task.createdAt || 0) - (a.task.createdAt || 0));
        // Do not wipe an answer the user is typing; anything else re-renders.
        if (document.activeElement?.matches?.(".task-answer input") && document.activeElement.value) return;
        $("task-list").replaceChildren(...list.map(taskCard));
        $("task-empty").hidden = list.length > 0;
    }

    api.onEvent((taskId, event) => {
        const entry = tasks.get(taskId) || upsertTask({ id: taskId, status: "queued", executorId: "", requestId: "" });
        entry.events.set(event.sequence, event);
        renderTasks();
    });
    api.onUpdate(task => { upsertTask(task); renderTasks(); });

    $("task-form").addEventListener("submit", async event => {
        event.preventDefault();
        $("task-form-error").textContent = "";
        $("task-form-status").textContent = "送信しています…";
        $("task-submit").disabled = true;
        try {
            const model = $("task-model").value;
            const response = await api.submit($("task-executor").value, $("task-input").value, model ? { model } : undefined);
            if (response?.ok) {
                upsertTask(response.task);
                $("task-input").value = "";
                $("task-form-status").textContent = `依頼しました（${response.task.requestId}）`;
                renderTasks();
            } else {
                $("task-form-status").textContent = "";
                $("task-form-error").textContent = `依頼できませんでした：${errorText(response?.error?.code)}`;
            }
        } finally {
            $("task-submit").disabled = !executors.some(e => e.available);
        }
    });

    async function loadRecent() {
        const response = await api.recent().catch(() => null);
        if (!response?.ok) return;
        for (const task of response.tasks) {
            const entry = upsertTask(task);
            const events = await api.events(task.id).catch(() => null);
            if (events?.ok) for (const e of events.events) entry.events.set(e.sequence, e);
        }
        renderTasks();
    }

    window.kei.onStatus(status => { if (status.connected) { refreshExecutors(); loadRecent(); } });
    $("refresh").addEventListener("click", refreshExecutors);
    refreshExecutors();
    loadRecent();
})();

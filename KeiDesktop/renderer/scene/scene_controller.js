class SceneController {
    constructor({
        root,
        backgroundLayer,
        background,
        environmentFxLayer,
        characterStage,
        characterFxLayer,
        uiLayer,
    }) {
        this.root = root;
        this.backgroundLayer = backgroundLayer;
        this.background = background;
        this.environmentFxLayer = environmentFxLayer;
        this.characterStage = characterStage;
        this.characterFxLayer = characterFxLayer;
        this.uiLayer = uiLayer;

        this.scenes = window.KEI_SCENES || {};
        this.backgroundRequest = 0;
        this.backgroundTimer = null;
        this.backgroundOverlay = null;
        this.backgroundImages = new Map();
        for (const entry of Object.values(this.scenes)) {
            this._loadBackground(entry.background).catch(() => {});
        }
        this.seatedLayer = null;
        if (this.backgroundLayer && this.scenes.cg2?.seatedImage) {
            this.seatedLayer = document.createElement("img");
            this.seatedLayer.className = "scene-seated-character";
            this.seatedLayer.alt = "";
            this.seatedLayer.src = this.scenes.cg2.seatedImage;
            this.backgroundLayer.appendChild(this.seatedLayer);
            this.monitorLayer = document.createElement("div");
            this.monitorLayer.className = "scene-monitor-fx";
            this.monitorLayer.setAttribute("aria-hidden", "true");
            this.monitorLayer.innerHTML = `
                <div class="scene-monitor-display scene-monitor-left"></div>
                <div class="scene-monitor-display scene-monitor-main">
                    <span class="scene-monitor-search"></span>
                    <span class="scene-monitor-reading"></span>
                    <span class="scene-monitor-control"></span>
                    <span class="scene-monitor-computing"></span>
                </div>
            `;
            this.backgroundLayer.appendChild(this.monitorLayer);
        }
        this.currentScene = "cg1";
        this.activeAgentTurnId = null;
        this.retiredTurnIds = new Set();
        this.activeToolName = "";
        this.completedTools = [];
        this.completedActivities = [];
        this.workSteps = [];
        this.workStepSequence = 0;
        this.searchFindings = [];
        this.hasToolPresentation = false;
        this.activeActivity = "working";
        this.workState = "idle";
        this.workActivity = "idle";
        this.workTicker = null;
        this.generation = 0;
        this.lastSceneRevision = 0;
        this.returnTimer = null;
        this.pendingResult = null;

        this.ui = this._buildWorkUi();
        this._applyScene("cg1");
    }

    _buildWorkUi() {
        if (!this.uiLayer) return null;

        let panel = this.uiLayer.querySelector("#scene-work-card");
        if (!panel) {
            panel = document.createElement("section");
            panel.id = "scene-work-card";
            panel.setAttribute("aria-live", "polite");
            panel.innerHTML = `
                <div class="scene-work-kicker">KEI / ASSIST</div>
                <div class="scene-work-title">待機中</div>
                <div class="scene-work-activity"></div>
                <div class="scene-work-findings"></div>
                <ol class="scene-work-steps"></ol>
                <p class="scene-result-summary"></p>
                <div class="scene-work-sources"></div>
            `;
            this.uiLayer.appendChild(panel);
        }

        return {
            panel,
            kicker: panel.querySelector(".scene-work-kicker"),
            title: panel.querySelector(".scene-work-title"),
            activity: panel.querySelector(".scene-work-activity"),
            steps: panel.querySelector(".scene-work-steps"),
            findings: panel.querySelector(".scene-work-findings"),
            summary: panel.querySelector(".scene-result-summary"),
            sources: panel.querySelector(".scene-work-sources"),
        };
    }

    _cancelReturn() {
        if (this.returnTimer !== null) {
            clearTimeout(this.returnTimer);
            this.returnTimer = null;
        }
    }

    _bumpGeneration() {
        this.generation += 1;
        return this.generation;
    }

    _stopWorkTicker() {
        if (this.workTicker === null) return;
        window.clearInterval(this.workTicker);
        this.workTicker = null;
    }

    _startWorkTicker() {
        if (this.workTicker !== null) return;
        this.workTicker = window.setInterval(() => {
            if (!this.workSteps.some(step => step.status === "running")) {
                this._stopWorkTicker();
                return;
            }
            this._renderWorkProgress();
        }, 1000);
    }

    _acceptTurn(turnId, { allowCreate = false } = {}) {
        if (!turnId || this.retiredTurnIds.has(turnId)) return false;
        if (!this.activeAgentTurnId && allowCreate) {
            this.activeAgentTurnId = turnId;
            return true;
        }
        return this.activeAgentTurnId === turnId;
    }

    isActiveTurn(turnId) {
        return Boolean(turnId && this.activeAgentTurnId === turnId);
    }

    _retireTurn(turnId) {
        if (!turnId) return;
        this.retiredTurnIds.add(turnId);
        while (this.retiredTurnIds.size > 40) {
            this.retiredTurnIds.delete(this.retiredTurnIds.values().next().value);
        }
    }

    _activityLabel(activity) {
        switch (activity) {
            case "searching":
                return "資料を検索しています…";
            case "reading":
                return "資料を読んでいます…";
            case "computing":
                return "計算・分析しています…";
            case "controlling":
                return "パソコンを操作しています…";
            case "result_ready":
                return "結果をまとめました";
            case "thinking":
                return "依頼の内容を確認しています…";
            case "using_tool":
                return "ツールを使っています…";
            case "working":
            default:
                return "処理しています…";
        }
    }

    _setWorkUi({ title, activity, toolName = "" }) {
        if (!this.ui) return;
        this.ui.title.textContent = title || "";

        // Keep concrete tool names in event/debug state, not in the user-facing UI.
        this.ui.activity.textContent = this._activityLabel(activity);
    }

    _presentationActivity(payload = {}) {
        const name = String(payload.tool_name || "").toLowerCase();
        if (payload.activity === "searching" || name === "desktop_web_search") return "searching";
        if (/(computer|desktop|mouse|keyboard|screenshot|click|type_text|open_app|window_control)/.test(name)) {
            return "controlling";
        }
        if (["controlling", "computer_control"].includes(payload.activity)) return "controlling";
        if (payload.activity === "searching" || /(web_search|search_web|browser|fetch_url|open_url|browse|tavily|bing|google)/.test(name)) {
            return "searching";
        }
        if (payload.activity === "reading" || /(read_file|read_document|read_page|extract|retrieve)/.test(name)) {
            return "reading";
        }
        if (payload.activity === "computing" || /(shell|terminal|execute|exec_command|python|run_code)/.test(name)) {
            return "computing";
        }
        return null;
    }

    _stepLabel(step) {
        if (step.label) return step.label;
        const name = String(step.toolName || "").toLowerCase();
        if (step.activity === "controlling") {
            if (/(screenshot|screen_capture|view_screen)/.test(name)) return "画面を確認";
            if (/(click|mouse)/.test(name)) return "マウス操作";
            if (/(keyboard|type_text|write_text)/.test(name)) return "キーボード入力";
            if (/(open_app|launch)/.test(name)) return "アプリを起動";
            return "パソコン操作";
        }
        if (step.activity === "reading") return /(pdf|document|file)/.test(name) ? "文書を読む" : "資料を読む";
        if (step.activity === "computing") return /(shell|terminal|exec)/.test(name) ? "コマンド実行" : "計算・分析";
        return step.activity === "searching" ? "資料検索" : "タスク処理";
    }

    _renderWorkProgress() {
        if (!this.ui) return;
        this.ui.steps.replaceChildren();
        for (const step of this.workSteps.slice(-4)) {
            const item = document.createElement("li");
            item.className = `scene-work-step scene-work-step-${step.status}`;
            const status = step.status === "running" ? "実行中" : step.status === "failed" ? "未完了" : "完了";
            const count = step.activity === "searching" && Number.isInteger(step.resultCount)
                ? ` · ${step.resultCount} 件の出典` : "";
            const duration = step.status !== "running" && Number.isFinite(step.durationMs)
                ? ` · ${(step.durationMs / 1000).toFixed(1)} 秒` : "";
            const elapsed = step.status === "running"
                ? ` · ${Math.floor((Date.now() - step.startedAt) / 1000)} 秒` : duration;
            item.textContent = `${step.index}. ${this._stepLabel(step)} · ${status}${count}${elapsed}`;
            if (step.subject) item.textContent += `\n${step.subject}`;
            this.ui.steps.appendChild(item);
        }
        this.ui.findings.replaceChildren();
        for (const finding of this.searchFindings.slice(-2)) {
            const item = document.createElement("div");
            item.className = "scene-work-finding";
            item.textContent = `手がかり：${finding.title}${finding.source ? ` · ${finding.source}` : ""}${finding.snippet ? `\n${finding.snippet}` : ""}`;
            this.ui.findings.appendChild(item);
        }
    }

    _setResultSummary(text, explicitSummary = "") {
        if (!this.ui) return;
        if (!text && !explicitSummary) { this.ui.summary.textContent = ""; return; }
        if (explicitSummary) {
            this.ui.summary.textContent = String(explicitSummary).trim();
            return;
        }
        // The UI is Japanese-only. A reply written in Chinese is not excerpted;
        // Kei speaks the answer and the card just confirms completion.
        if (!/[\u3040-\u30ff]/.test(String(text || ""))) {
            this.ui.summary.textContent = "完了しました。内容はケイのセリフをご覧ください。";
            return;
        }
        // Extract result facts; conversational lead-ins belong in the dialogue box.
        const parts = String(text || "")
            .replace(/```[\s\S]*?```/g, "")
            .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
            .replace(/https?:\/\/\S+/g, "")
            .split(/\n+|(?<=[。！？])/)
            .map(line => line.replace(/^[\s#>*\-•]+|^\d+[.)、]\s*/g, "").replace(/\*\*/g, "").trim())
            .filter(line => line.length >= 4)
            .filter(line => !/^(你好|好的|好[。！]|老师|先生|我来|我帮|我查|我找|为你|给你|你可以|如果你|希望|还有|需要我|要不要|这句|上次|刚才|想说)/.test(line))
            .filter(line => !/^(はい|了解|承知|わかりました|かしこまりました|お待たせ|調べました|もし|他に|ほかに)/.test(line))
            .filter(line => !/[？?]$/.test(line));
        const facts = parts.map((line, index) => ({ line, index,
            score: (/[:：]|\d|已完成|成功|失败|找到|结果|位于|显示|温度|版本|价格|完了|失敗|見つか|結果|気温|バージョン|価格/.test(line) ? 2 : 0)
                 + (/^(名称|时间|地点|日期|结论|摘要|時間|場所|日付|結論|要約)/.test(line) ? 2 : 0)
        }))
          .sort((a, b) => b.score - a.score || a.index - b.index)
          .slice(0, 3).sort((a, b) => a.index - b.index);
        this.ui.summary.textContent = facts.length
            ? facts.map(({ line }) => `• ${line}`).join("\n")
            : "完了しました。内容はケイのセリフをご覧ください。";
    }

    _setSources() {
        if (!this.ui) return;
        const labels = { searching: "資料検索", reading: "資料閲覧", controlling: "パソコン操作", computing: "計算・分析" };
        this.ui.sources.textContent = this.completedActivities.length
            ? `完了 · ${this.completedActivities.map(activity => labels[activity]).join(" / ")}`
            : "";
    }

    _applyScene(name) {
        this.currentScene = name;
        if (this.root) {
            this.root.dataset.scene = name;
        }
        document.body.dataset.scene = name;
        this._syncWorkState();
        const src = this.scenes[name]?.background;
        if (src) this.setBackground(src);
    }

    _syncWorkState() {
        const visible = this.hasToolPresentation && this.workState !== "idle";
        if (this.root) {
            this.root.dataset.workState = visible ? this.workState : "idle";
            this.root.dataset.workActivity = visible ? this.workActivity : "idle";
        }
    }

    _loadBackground(src) {
        if (!src) return Promise.reject(new Error("Missing scene background"));
        if (this.backgroundImages.has(src)) return this.backgroundImages.get(src);
        const pending = new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`Scene background unavailable: ${src}`));
            img.src = src;
        });
        this.backgroundImages.set(src, pending);
        pending.catch(() => this.backgroundImages.delete(src));
        return pending;
    }

    _syncBackgroundPresentation(src) {
        const entry = this.scenes[this.currentScene];
        document.body.dataset.characterPresentation = entry?.characterPresentation || "live2d";
    }

    setBackground(src, { fade = true } = {}) {
        if (!src || !this.background) return;
        const request = ++this.backgroundRequest;
        if (this.backgroundTimer !== null) clearTimeout(this.backgroundTimer);
        this.backgroundTimer = null;
        this.backgroundOverlay?.remove();
        this.backgroundOverlay = null;
        this.backgroundLayer?.classList.remove("fade-out");
        if (this.background.getAttribute("src") === src) {
            this._syncBackgroundPresentation(src);
            return;
        }
        this._loadBackground(src).then(() => {
            if (request !== this.backgroundRequest) return;
            const previous = this.background.getAttribute("src");
            const previousEntry = Object.values(this.scenes).find(entry => entry.background === previous);
            if (fade && this.backgroundLayer && previous) {
                const overlay = document.createElement("img");
                overlay.className = "scene-background-outgoing";
                overlay.alt = "";
                overlay.src = previous;
                overlay.style.transform = previousEntry?.characterPresentation === "seated-still"
                    ? "scale(1)" : "scale(1)";
                overlay.style.transformOrigin = "42% 60%";
                this.backgroundLayer.appendChild(overlay);
                this.backgroundOverlay = overlay;
            }
            this.background.src = src;
            this._syncBackgroundPresentation(src);
            const overlay = this.backgroundOverlay;
            if (overlay) {
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    if (request !== this.backgroundRequest) return;
                    overlay.classList.add("fade-away");
                    this.backgroundTimer = window.setTimeout(() => {
                        if (request !== this.backgroundRequest) return;
                        overlay.remove();
                        this.backgroundOverlay = null;
                        this.backgroundTimer = null;
                    }, 720);
                }));
            }
        }).catch(error => {
            if (request !== this.backgroundRequest) return;
            console.warn("[Kei Scene] Keeping current background", error);
        });
    }

    beginAgent(turnId, payload = {}) {
        if (!turnId || this.retiredTurnIds.has(turnId)) return false;

        this._cancelReturn();
        this._bumpGeneration();
        if (this.activeAgentTurnId && this.activeAgentTurnId !== turnId) {
            this._retireTurn(this.activeAgentTurnId);
        }
        this.activeAgentTurnId = turnId;
        this.activeToolName = "";
        this.completedTools = [];
        this.completedActivities = [];
        this.workSteps = [];
        this.workStepSequence = 0;
        this._stopWorkTicker();
        this.searchFindings = [];
        this.hasToolPresentation = false;
        this.activeActivity = "working";
        this.workState = "working";
        this.workActivity = "idle";
        this._applyScene("cg1");
        this.pendingResult = null;
        this._setResultSummary("");
        this._setSources();
        this._renderWorkProgress();
        this._setWorkUi({
            title: "ケイが対応しています",
            activity: payload.activity || "thinking",
        });
        return true;
    }

    toolStart(turnId, payload = {}) {
        if (!this._acceptTurn(turnId, { allowCreate: true })) return false;

        this._cancelReturn();
        this._bumpGeneration();
        this.activeToolName = payload.tool_name || "";
        const activity = this._presentationActivity(payload);
        this.activeActivity = activity || "working";
        this.workActivity = activity
            || [...this.workSteps].reverse().find(step => step.status === "running")?.activity
            || (this.hasToolPresentation ? "organizing" : "idle");
        if (activity) this.hasToolPresentation = true;
        if (activity) {
            const subject = activity === "searching" && typeof payload.subject === "string"
                ? payload.subject.replace(/\s+/g, " ").trim().slice(0, 72) : "";
            this.workSteps.push({
                index: ++this.workStepSequence, toolName: this.activeToolName,
                activity, status: "running", subject,
                startedAt: Number.isFinite(payload.started_at_ms)
                    ? Math.min(Date.now(), Math.max(Date.now() - 3600000, payload.started_at_ms))
                    : Date.now(),
                label: typeof payload.step_label === "string" ? payload.step_label.trim().slice(0, 24) : "",
            });
            this.workSteps = this.workSteps.slice(-12);
            this._renderWorkProgress();
            this._startWorkTicker();
        }
        this.workState = "working";
        this._applyScene(this.hasToolPresentation ? "cg2" : "cg1");
        this._setWorkUi({
            title: "ケイが作業しています",
            activity: activity || "working",
            toolName: this.activeToolName,
        });
        return true;
    }

    toolEnd(turnId, payload = {}) {
        if (!this._acceptTurn(turnId)) return false;

        const toolName = String(payload.tool_name || this.activeToolName || "").trim();
        if (toolName && !this.completedTools.includes(toolName)) {
            this.completedTools.push(toolName);
        }
        const activity = this._presentationActivity(payload)
            || (toolName === this.activeToolName ? this.activeActivity : null);
        const failed = payload.status === "failed";
        const pending = [...this.workSteps].reverse().find(step => step.status === "running" && step.toolName === toolName);
        if (pending) {
            pending.status = failed ? "failed" : "completed";
            pending.durationMs = Number.isFinite(payload.duration_ms)
                ? Math.max(0, Math.min(3600000, payload.duration_ms))
                : Math.max(0, Date.now() - pending.startedAt);
            if (Number.isInteger(payload.result_count) && payload.result_count >= 0) {
                pending.resultCount = payload.result_count;
            }
        }
        if (!failed && activity && activity !== "working" && !this.completedActivities.includes(activity)) {
            this.completedActivities.push(activity);
        }
        if (!failed && activity === "searching" && Array.isArray(payload.result_previews)) {
            for (const preview of payload.result_previews.slice(0, 2)) {
                if (!preview || typeof preview.title !== "string") continue;
                const title = preview.title.replace(/\s+/g, " ").trim().slice(0, 90);
                const snippet = typeof preview.snippet === "string"
                    ? preview.snippet.replace(/\s+/g, " ").trim().slice(0, 120) : "";
                const source = typeof preview.source === "string"
                    ? preview.source.replace(/\s+/g, " ").trim().slice(0, 60) : "";
                if (title && !this.searchFindings.some(item => item.title === title)) {
                    this.searchFindings.push({ title, snippet, source });
                }
            }
            this.searchFindings = this.searchFindings.slice(-4);
        }
        this._renderWorkProgress();
        if (!this.workSteps.some(step => step.status === "running")) this._stopWorkTicker();
        this.workActivity = [...this.workSteps].reverse().find(step => step.status === "running")?.activity
            || "organizing";
        this._syncWorkState();
        this.activeToolName = "";
        this._setWorkUi({
            title: failed ? "次の手順を試しています"
                : activity === "searching" && Number.isInteger(payload.result_count)
                    ? `${payload.result_count} 件の出典が見つかりました` : "ケイが整理しています",
            activity: "working",
        });
        return true;
    }

    markResultReady(turnId, payload = {}) {
        if (!this._acceptTurn(turnId, { allowCreate: true })) return false;
        if (payload.has_reply && !payload.speakerReady) {
            if (this.workState === "result") return true;
            const draft = this.pendingResult?.turnId === turnId ? this.pendingResult : null;
            this.pendingResult = { turnId, payload, text: draft?.text || "", summary: draft?.summary || "" };
            this._setWorkUi({ title: "ケイが整理しています", activity: "working" });
            return true;
        }

        this._cancelReturn();
        this._stopWorkTicker();
        this._bumpGeneration();
        this.activeToolName = "";
        this.workState = "result";
        this.workActivity = "idle";
        this._applyScene("cg1");
        this._setSources();
        this._setWorkUi({
            title: "結果がまとまりました",
            activity: payload.activity || "result_ready",
        });
        if (payload.has_reply === false) {
            this.finishPresentation(turnId, { final: true, completed: true, delay: 2000 });
        }
        return true;
    }

    startResultPresentation(turnId) {
        const pending = this.pendingResult;
        if (!pending || pending.turnId !== turnId || !this._acceptTurn(turnId)) return false;
        this.pendingResult = null;
        this.markResultReady(turnId, { ...pending.payload, speakerReady: true });
        this._setResultSummary(pending.text, pending.summary);
        return true;
    }

    renderResult(turnId, text, summary = "") {
        // Replies can arrive before agent.done; retain them until real playback.
        if (this.workState === "working" && this._acceptTurn(turnId)) {
            this.pendingResult = { turnId, payload: { has_reply: true }, text, summary };
            return true;
        }
        if (this.pendingResult?.turnId === turnId && this._acceptTurn(turnId)) {
            Object.assign(this.pendingResult, { text, summary });
            return true;
        }
        if (!this._acceptTurn(turnId) || this.workState !== "result") return false;
        this._cancelReturn();
        this._setResultSummary(text, summary);
        return true;
    }

    finishPresentation(turnId, { final = true, completed = true, delay = 2000 } = {}) {
        if (!final || !completed || !this._acceptTurn(turnId) || this.workState !== "result") return false;

        this._cancelReturn();
        const generation = this.generation;
        this.returnTimer = window.setTimeout(() => {
            if (
                generation !== this.generation
                || this.activeAgentTurnId !== turnId
            ) {
                return;
            }
            // Keep the summary intact while the panel fades out.
            this.workState = "fading";
            this._setWorkUi({});
            this.returnTimer = window.setTimeout(() => {
                if (generation !== this.generation || this.activeAgentTurnId !== turnId) return;
                this.returnTimer = null;
                this.resetToIdle(turnId);
            }, 240);
        }, delay);
        return true;
    }

    interrupt(turnId) {
        if (turnId && this.activeAgentTurnId && turnId !== this.activeAgentTurnId) {
            return false;
        }
        this.resetToIdle(turnId || this.activeAgentTurnId);
        return true;
    }

    resetToIdle(turnId = null, { clearRevision = false } = {}) {
        if (turnId && this.activeAgentTurnId && turnId !== this.activeAgentTurnId) {
            return false;
        }

        this._cancelReturn();
        this._stopWorkTicker();
        this._bumpGeneration();
        if (clearRevision) this.lastSceneRevision = 0;
        this._retireTurn(this.activeAgentTurnId || turnId);
        this.activeAgentTurnId = null;
        this.activeToolName = "";
        this.completedTools = [];
        this.completedActivities = [];
        this.workSteps = [];
        this.workStepSequence = 0;
        this.searchFindings = [];
        this.hasToolPresentation = false;
        this.activeActivity = "working";
        this.workState = "idle";
        this.workActivity = "idle";
        this._applyScene("cg1");
        this.pendingResult = null;
        this._setResultSummary("");
        this._setSources();
        this._renderWorkProgress();
        this._setWorkUi({
            title: "待機中",
            activity: "working",
        });
        return true;
    }

    handleRuntimeEvent(event) {
        const turnId = event?.turn_id || null;
        const payload = event?.payload || {};
        if (event?.type === "agent.scene.snapshot") {
            const revision = Number(payload.revision);
            if (!Number.isSafeInteger(revision) || revision <= this.lastSceneRevision) return false;
            if (!turnId) {
                this.resetToIdle();
                this.lastSceneRevision = revision;
                return true;
            }
            this.retiredTurnIds.delete(turnId);
            if (!this.beginAgent(turnId)) return false;
            for (const step of Array.isArray(payload.steps) ? payload.steps.slice(-6) : []) {
                if (!step || typeof step !== "object") continue;
                this.toolStart(turnId, step);
                if (step.status !== "running") this.toolEnd(turnId, step);
            }
            this.lastSceneRevision = revision;
            return true;
        }
        const revision = Number(payload.scene_revision);
        if (Number.isSafeInteger(revision) && revision > 0
            && revision <= this.lastSceneRevision) return false;
        let accepted = false;
        switch (event?.type) {
            case "agent.begin": accepted = this.beginAgent(turnId, payload); break;
            case "agent.tool.start": accepted = this.toolStart(turnId, payload); break;
            case "agent.tool.end": accepted = this.toolEnd(turnId, payload); break;
            case "agent.done": accepted = this.markResultReady(turnId, payload); break;
            default: return false;
        }
        if (accepted && Number.isSafeInteger(revision) && revision > 0) {
            this.lastSceneRevision = revision;
        }
        return accepted;
    }
}

window.SceneController = SceneController;



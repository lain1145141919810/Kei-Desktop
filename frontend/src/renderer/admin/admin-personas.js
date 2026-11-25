"use strict";
// Admin: 人格・振る舞い — Generic editable Character & Persona Performance Policy editor.
// Separates model selection from persona selection with explicit model <-> persona pairing,
// ships blank + separately labeled filled starter templates, opens edits as a new draft copy
// when desired, previews two contrasting contexts before saving, persists across restarts,
// and never logs raw private persona text.

(function () {
    const api = window.kei?.personas;
    const $ = id => document.getElementById(id);
    if (!api || !$("personas")) return;

    const ERRORS = {
        invalid_persona: "人格名と方針テキストを正しく入力してください（方針は8000文字以内）。",
        invalid_persona_id: "人格IDの形式が正しくありません。",
        persona_exists: "同じIDの人格がすでに存在します。",
        persona_not_found: "指定された人格が見つかりません。",
        persona_limit: "保存できる人格数の上限に達しました。",
        persona_builtin_protected: "既定の人格は削除できません（既定に戻すことはできます）。",
        persona_not_restorable: "既定に戻せるのは組み込み人格のみです。",
        invalid_pairing: "モデルと人格の組み合わせが正しくありません。",
        forbidden: "このウィンドウからは変更できません。",
    };

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
        const node = $("toast");
        if (!node) return;
        node.textContent = text;
        node.classList.add("visible");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => node.classList.remove("visible"), 3600);
    }

    let state = null;
    // Draft editor state:
    // mode === "new" -> creating a new saved persona (either blank, filled example, or draft copy from saved persona)
    // mode === "edit" -> updating an existing personaId in place
    let draft = {
        mode: "new",
        targetId: null,
        basedOn: null,
        isExample: false,
        name: "",
        policyText: "",
        dirty: false,
    };
    let busy = false;

    const localeSelect = $("persona-locale");
    const nameInput = $("persona-name");
    const policyInput = $("persona-policy");
    const previewModelSelect = $("persona-preview-model");

    function currentTemplate() {
        const loc = localeSelect?.value || "ja";
        return state?.templates?.[loc] || state?.templates?.ja || state?.templates?.["zh-CN"] || null;
    }

    function setFormError(message) {
        $("persona-form-error").textContent = message || "";
    }

    function clearPreview() {
        const panel = $("persona-preview-panel");
        if (panel) panel.hidden = true;
        const grid = $("persona-preview-grid");
        if (grid) grid.replaceChildren();
    }

    function loadDraft(next) {
        draft = {
            mode: next.mode || "new",
            targetId: next.targetId ?? null,
            basedOn: next.basedOn ?? null,
            isExample: Boolean(next.isExample),
            name: next.name ?? "",
            policyText: next.policyText ?? "",
            dirty: Boolean(next.dirty),
        };
        nameInput.value = draft.name;
        policyInput.value = draft.policyText;
        setFormError("");
        clearPreview();
        syncEditorChrome();
        renderPersonaList();
    }

    function openBlankDraft() {
        const tpl = currentTemplate();
        loadDraft({
            mode: "new",
            targetId: null,
            basedOn: null,
            isExample: false,
            name: tpl?.blankName || "新しいペルソナ",
            policyText: tpl?.blankTemplate || "",
            dirty: false,
        });
        toast("白紙テンプレートから新規ドラフトを開きました");
    }

    function openExampleDraft() {
        const tpl = currentTemplate();
        if (!tpl) return;
        loadDraft({
            mode: "new",
            targetId: null,
            basedOn: null,
            isExample: true,
            name: tpl.exampleName || "静かな相棒",
            policyText: tpl.filledExample || "",
            dirty: true,
        });
        toast(tpl.exampleLabel || "記入例（参考用）を読み込みました");
    }

    function openCopyDraftFrom(persona) {
        loadDraft({
            mode: "new",
            targetId: null,
            basedOn: persona.id,
            isExample: false,
            name: `${persona.name}（ドラフト）`,
            policyText: persona.policyText || "",
            dirty: true,
        });
        toast(`「${persona.name}」のコピーから新規ドラフトを開きました（元は保持されます）`);
    }

    function openEditExisting(persona) {
        loadDraft({
            mode: "edit",
            targetId: persona.id,
            basedOn: persona.basedOn || null,
            isExample: false,
            name: persona.name || "",
            policyText: persona.policyText || "",
            dirty: false,
        });
    }

    function syncEditorChrome() {
        const title = $("persona-editor-title");
        const badge = $("persona-draft-badge");
        const hint = $("persona-draft-hint");
        const saveBtn = $("persona-save-btn");
        const saveCopyBtn = $("persona-save-copy-btn");
        const restoreBtn = $("persona-restore-btn");

        const target = draft.mode === "edit" && state?.personas?.find(p => p.id === draft.targetId);
        if (draft.mode === "edit" && target) {
            title.textContent = `編集：${target.name}`;
            badge.textContent = target.isBuiltin ? "既定プロファイル編集中" : "保存済み編集中";
            badge.className = "badge on";
            hint.textContent = target.isBuiltin
                ? "既定の Kei プロファイルを直接更新します。「別名で新規保存」を使えば既定を残したまま新しい人格を作れます。"
                : "保存済みプロファイルを更新します。「別名で新規保存」で元を残して複製することもできます。";
            saveBtn.textContent = "上書き保存";
            saveCopyBtn.hidden = false;
            restoreBtn.hidden = !target.isBuiltin;
        } else if (draft.isExample) {
            const tpl = currentTemplate();
            title.textContent = "新規ドラフト（記入例から開始）";
            badge.textContent = "記入例・参考サンプル";
            badge.className = "badge warn";
            hint.textContent = tpl?.exampleLabel || "白紙テンプレートとは別の参考用記入例です。自由に書き換えてプレビュー・保存してください。";
            saveBtn.textContent = "新規人格として保存";
            saveCopyBtn.hidden = true;
            restoreBtn.hidden = true;
        } else if (draft.basedOn) {
            const orig = state?.personas?.find(p => p.id === draft.basedOn);
            title.textContent = "新規ドラフト（コピー元を保持）";
            badge.textContent = "元を保持する新規ドラフト";
            badge.className = "badge on";
            hint.textContent = `「${orig?.name || draft.basedOn}」は変更されません。書き換えてプレビュー確認後に新規人格として保存できます。`;
            saveBtn.textContent = "新規人格として保存";
            saveCopyBtn.hidden = true;
            restoreBtn.hidden = true;
        } else {
            title.textContent = "新規ドラフト（白紙テンプレート）";
            badge.textContent = "白紙ドラフト";
            badge.className = "badge off";
            hint.textContent = "最初の3項目だけ埋めても始められます。保存前に2つの対照的な場面でプレビューできます。";
            saveBtn.textContent = "新規人格として保存";
            saveCopyBtn.hidden = true;
            restoreBtn.hidden = true;
        }
        saveBtn.disabled = busy;
        saveCopyBtn.disabled = busy;
        restoreBtn.disabled = busy;
        $("persona-preview-btn").disabled = busy;
    }

    function renderPairingSection() {
        const banner = $("persona-active-banner");
        const modelList = $("persona-model-list");
        if (!state) return;
        const activePersona = state.personas.find(p => p.id === state.activePersonaId);
        const cap = state.activeCapabilities || {};
        banner.textContent =
            `現在のアクティブ組み合わせ：モデル「${cap.modelName || state.activeModel}」（${state.activeModel}） ↔ 人格「${activePersona?.name || state.activePersonaId}」` +
            ` · ${cap.supportsBodyMotion ? "全身モーション対応" : "表情・会話のみ（全身モーションなし）"} · 表情 ${(cap.supportedFaces || []).length} 種`;

        const models = Array.isArray(state.models) ? state.models : [];
        modelList.replaceChildren(...models.map(model => {
            const isActive = model.modelKey === state.activeModel;
            const select = el("select", {
                "aria-label": `${model.modelKey} に割り当てる人格`,
                dataset: { modelKey: model.modelKey, role: "pair-select" },
            });
            for (const p of state.personas) {
                const suffix = p.isBuiltin && !p.name.includes("既定") ? "（既定）" : "";
                select.append(el("option", { value: p.id, selected: p.id === model.pairedPersonaId }, `${p.name}${suffix}`));
            }
            select.value = model.pairedPersonaId;
            const applyBtn = el("button", {
                type: "button",
                class: "small",
                disabled: busy,
                dataset: { modelKey: model.modelKey, role: "pair-apply" },
                onclick: async () => {
                    await setPairing(model.modelKey, select.value);
                },
            }, "ペアリングを適用");

            return el("div", { class: "persona-model-card", dataset: { modelKey: model.modelKey, active: String(isActive) } },
                el("div", { class: "persona-model-head" },
                    el("strong", { text: `${model.modelName || model.modelKey}` }),
                    el("span", { class: "plugin-id", text: model.modelKey }),
                    el("span", { class: `badge ${isActive ? "on" : "off"}`, text: isActive ? "現在アクティブ" : "待機モデル" }),
                    el("span", { class: `badge ${model.supportsBodyMotion ? "on" : "warn"}`, text: model.supportsBodyMotion ? "全身対応" : "表情のみ" }),
                ),
                el("div", { class: "meta" },
                    el("span", { text: `対応表情：${(model.supportedFaces || []).length} 種` }),
                    el("span", { text: `頭部反応：${(model.supportedGestures || []).length} 種` }),
                ),
                el("label", { class: "field" }, "使用する人格", select),
                el("div", { class: "row" }, applyBtn),
            );
        }));

        // Update preview model dropdown preserving current selection
        const prevModel = previewModelSelect.value;
        previewModelSelect.replaceChildren(...models.map(m =>
            el("option", { value: m.modelKey },
                `${m.modelName || m.modelKey}（${m.modelKey} · ${m.supportsBodyMotion ? "全身対応" : "全身なし"}）`)
        ));
        if (prevModel && models.some(m => m.modelKey === prevModel)) {
            previewModelSelect.value = prevModel;
        } else {
            previewModelSelect.value = state.activeModel || models[0]?.modelKey || "vrm";
        }
    }

    function renderPersonaList() {
        const list = $("persona-list");
        if (!state || !list) return;
        const pairings = state.pairings || {};
        list.replaceChildren(...state.personas.map(persona => {
            const pairedModels = Object.entries(pairings)
                .filter(([, pid]) => pid === persona.id)
                .map(([mkey]) => mkey);
            const isSelected = draft.mode === "edit" && draft.targetId === persona.id;
            const excerpt = (persona.policyText || "").split("\n").slice(0, 2).join("\n");

            const actions = [
                el("button", {
                    type: "button",
                    class: "small",
                    dataset: { personaId: persona.id, role: "copy-draft" },
                    onclick: () => openCopyDraftFrom(persona),
                }, "コピーから新規編集"),
                el("button", {
                    type: "button",
                    class: "ghost small",
                    dataset: { personaId: persona.id, role: "edit-existing" },
                    onclick: () => openEditExisting(persona),
                }, "直接編集"),
                el("button", {
                    type: "button",
                    class: "ghost small",
                    disabled: busy || state.pairings?.[state.activeModel] === persona.id,
                    dataset: { personaId: persona.id, role: "pair-active" },
                    onclick: () => setPairing(state.activeModel, persona.id),
                }, `${state.activeModel} に適用`),
            ];
            if (persona.isBuiltin) {
                actions.push(el("button", {
                    type: "button",
                    class: "ghost small",
                    disabled: busy || !persona.isEdited,
                    dataset: { personaId: persona.id, role: "restore" },
                    onclick: () => restorePersona(persona.id),
                }, "既定に戻す"));
            } else {
                actions.push(el("button", {
                    type: "button",
                    class: "danger small",
                    disabled: busy,
                    dataset: { personaId: persona.id, role: "delete" },
                    onclick: () => deletePersona(persona),
                }, "削除"));
            }

            return el("div", { class: "persona-item", dataset: { personaId: persona.id, selected: String(isSelected) } },
                el("div", { class: "persona-item-head" },
                    el("span", { class: "persona-item-name", text: persona.name }),
                    persona.isBuiltin ? el("span", { class: "badge off", text: persona.isEdited ? "既定・編集済" : "既定" }) : null,
                    ...pairedModels.map(m => el("span", { class: "badge on", text: `${m} 使用中` })),
                ),
                el("p", { class: "persona-item-preview", text: excerpt }),
                el("div", { class: "row" }, ...actions),
            );
        }));
    }

    function renderAll() {
        if (!state) return;
        $("persona-summary").textContent = `${state.personas.length} 件の人格 · アクティブ：${state.activeModel} ↔ ${state.activePersonaId}`;
        $("persona-error").textContent = "";
        renderPairingSection();
        renderPersonaList();
        syncEditorChrome();
    }

    async function setPairing(modelKey, personaId) {
        if (busy) return;
        busy = true;
        renderAll();
        const reply = await api.setPairing({ modelKey, personaId }).catch(() => null);
        busy = false;
        if (!reply?.ok) {
            renderAll();
            toast(ERRORS[reply?.error?.code] || `ペアリングを変更できませんでした（${reply?.error?.code || "error"}）`);
            return;
        }
        state = reply.value;
        renderAll();
        toast(`モデル「${modelKey}」の人格を切り替えました（次の応答から有効）`);
    }

    async function saveDraft({ forceCreate = false } = {}) {
        if (busy) return;
        const name = nameInput.value.trim();
        const policyText = policyInput.value.trim();
        if (!name || !policyText) {
            setFormError("人格名と方針テキストの両方を入力してください。");
            return;
        }
        setFormError("");
        busy = true;
        $("persona-form-status").textContent = "保存中…";
        syncEditorChrome();
        let reply;
        const payload = {
            name,
            policyText,
            locale: localeSelect.value || "ja",
            basedOn: draft.basedOn || undefined,
        };
        if (!forceCreate && draft.mode === "edit" && draft.targetId) {
            reply = await api.update(draft.targetId, payload).catch(() => null);
        } else {
            reply = await api.create(payload).catch(() => null);
        }
        busy = false;
        $("persona-form-status").textContent = "";
        if (!reply?.ok) {
            syncEditorChrome();
            setFormError(ERRORS[reply?.error?.code] || `保存できませんでした（${reply?.error?.code || "error"}）`);
            return;
        }
        state = reply.value.state;
        const saved = reply.value.persona;
        loadDraft({
            mode: "edit",
            targetId: saved.id,
            basedOn: saved.basedOn || null,
            isExample: false,
            name: saved.name,
            policyText: saved.policyText,
            dirty: false,
        });
        renderAll();
        toast(`人格「${saved.name}」を保存しました（次の応答から反映されます）`);
    }

    async function restorePersona(id) {
        if (busy) return;
        busy = true;
        syncEditorChrome();
        const reply = await api.restore(id).catch(() => null);
        busy = false;
        if (!reply?.ok) {
            syncEditorChrome();
            toast(ERRORS[reply?.error?.code] || "既定に戻せませんでした。");
            return;
        }
        state = reply.value.state;
        const restored = reply.value.persona;
        if (draft.mode === "edit" && draft.targetId === id) {
            openEditExisting(restored);
        }
        renderAll();
        toast("既定の Kei 人格プロファイルに戻しました");
    }

    async function deletePersona(persona) {
        if (busy) return;
        busy = true;
        renderAll();
        const reply = await api.remove(persona.id).catch(() => null);
        busy = false;
        if (!reply?.ok) {
            renderAll();
            toast(ERRORS[reply?.error?.code] || "削除できませんでした。");
            return;
        }
        state = reply.value.state;
        if (draft.mode === "edit" && draft.targetId === persona.id) {
            openBlankDraft();
        }
        renderAll();
        toast(`人格「${persona.name}」を削除しました`);
    }

    async function previewDraft() {
        if (busy) return;
        const name = nameInput.value.trim() || "ドラフト人格";
        const policyText = policyInput.value.trim();
        if (!policyText) {
            setFormError("プレビューする前に方針テキストを入力してください。");
            return;
        }
        setFormError("");
        busy = true;
        $("persona-form-status").textContent = "2つの対照場面をプレビュー中…";
        syncEditorChrome();
        const reply = await api.preview({
            name,
            policyText,
            modelKey: previewModelSelect.value || state?.activeModel || "vrm",
        }).catch(() => null);
        busy = false;
        $("persona-form-status").textContent = "";
        syncEditorChrome();
        if (!reply?.ok) {
            setFormError(ERRORS[reply?.error?.code] || `プレビューできませんでした（${reply?.error?.code || "error"}）`);
            return;
        }
        const preview = reply.value;
        const panel = $("persona-preview-panel");
        const modeBadge = $("persona-preview-mode");
        const grid = $("persona-preview-grid");
        modeBadge.textContent = preview.mode === "live-llm"
            ? `実LLMプレビュー（未保存 · ${preview.modelKey}）`
            : `ローカル方針ドライラン（未保存 · ${preview.modelKey} · 会話モデル未設定）`;
        modeBadge.className = `badge ${preview.mode === "live-llm" ? "on" : "warn"}`;
        grid.replaceChildren(...(preview.contexts || []).map(ctx => {
            const bodySummary = Array.isArray(ctx.visual?.body) && ctx.visual.body.length
                ? ctx.visual.body.map(s => s.motion).join(" → ")
                : "なし（静かな姿勢 / []）";
            return el("div", { class: "persona-preview-card", dataset: { contextId: ctx.contextId } },
                el("h4", { text: ctx.contextTitle }),
                el("p", { class: "persona-preview-utterance", text: `入力：${ctx.utterance}` }),
                el("p", { class: "persona-preview-reply", text: ctx.reply }),
                el("div", { class: "persona-preview-meta", text: `face: ${ctx.visual?.face || "neutral"} · head: ${ctx.visual?.motion || "none"} · body: ${bodySummary}` }),
                ctx.degradedNotice ? el("p", { class: "persona-preview-degrade", text: ctx.degradedNotice }) : null,
            );
        }));
        panel.hidden = false;
    }

    $("persona-new-blank")?.addEventListener("click", openBlankDraft);
    $("persona-load-example")?.addEventListener("click", openExampleDraft);
    $("persona-preview-btn")?.addEventListener("click", previewDraft);
    $("persona-save-copy-btn")?.addEventListener("click", () => void saveDraft({ forceCreate: true }));
    $("persona-restore-btn")?.addEventListener("click", () => {
        if (draft.targetId) void restorePersona(draft.targetId);
    });
    $("persona-discard-btn")?.addEventListener("click", () => {
        if (draft.mode === "edit" && draft.targetId) {
            const orig = state?.personas?.find(p => p.id === draft.targetId);
            if (orig) { openEditExisting(orig); toast("変更を破棄しました"); return; }
        }
        openBlankDraft();
    });
    $("persona-form")?.addEventListener("submit", event => {
        event.preventDefault();
        void saveDraft({ forceCreate: false });
    });
    nameInput?.addEventListener("input", () => { draft.name = nameInput.value; draft.dirty = true; });
    policyInput?.addEventListener("input", () => { draft.policyText = policyInput.value; draft.dirty = true; });
    localeSelect?.addEventListener("change", () => {
        if (draft.mode === "new" && !draft.dirty && !draft.basedOn) {
            const tpl = currentTemplate();
            if (tpl) {
                nameInput.value = tpl.blankName;
                policyInput.value = tpl.blankTemplate;
                draft.name = tpl.blankName;
                draft.policyText = tpl.blankTemplate;
            }
        }
    });

    async function refresh() {
        const reply = await api.state().catch(() => null);
        if (!reply?.ok) {
            $("persona-summary").textContent = "";
            $("persona-error").textContent = "Kei ホストに接続できないため、人格設定を表示できません。";
            return;
        }
        const firstLoad = !state;
        state = reply.value;
        if (firstLoad) {
            const active = state.personas.find(p => p.id === state.activePersonaId) || state.personas[0];
            if (active) openEditExisting(active);
            else openBlankDraft();
        }
        renderAll();
    }

    api.onChanged?.(() => refresh());
    $("refresh")?.addEventListener("click", refresh);
    refresh();
})();

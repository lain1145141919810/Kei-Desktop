"use strict";
// Frame host for plugin pages inside Kei's trusted windows.
// Each page is a sandboxed iframe without allow-same-origin whose
// document is served once by main with the host-controlled CSP. Messages are accepted
// only from that iframe's own contentWindow and are answered only to it.

(function () {
    const ERROR_TEXT = {
        page_closed: "ページは閉じられました。",
        scope_denied: "この操作は許可されていません。",
        action_failed: "操作に失敗しました。",
        plugin_disabled: "このプラグインは無効です。",
        entry_not_found: "ページが見つかりません。",
        page_limit: "開けるページの上限に達しました。",
        rate_limited: "操作が多すぎます。少し待ってください。",
        invalid_request: "不正なリクエストです。",
        malformed_entry: "プラグインのページ情報が正しくないため開けません。",
        observation_unavailable: "画面観察プラグインが有効ではありません（権限の許可が必要です）。",
        capture_source_unavailable: "観察できる画面やウィンドウが見つかりません。",
        vision_scope_denied: "画面観察の許可がありません。",
        capture_closed: "観察対象が有効ではありません。",
        capture_configure_failed: "画面観察を開始できませんでした。",
        invalid_capture_source: "観察対象を指定してください。",
        mcp_scope_denied: "このプラグインにはこの MCP ツールの実行が許可されていません。",
        // Round 09: chat and reading
        conversation_busy: "前の質問への返答を待っています。中止するか、返答を待ってください。",
        chat_request_conflict: "同じリクエストで別の質問が送られました。",
        chat_provider_error: "モデルがエラーを返しました。",
        chat_provider_unauthorized: "モデルの認証に失敗しました（環境変数または権限を確認してください）。",
        chat_provider_unconfigured: "会話モデルが未設定です（管理 → モデル から設定できます）。",
        chat_credential_unavailable: "会話モデルで指定した認証情報の環境変数が見つかりません。",
        invalid_chat_config: "会話モデルの設定内容が正しくありません。",
        invalid_chat_endpoint: "HTTPS またはローカルの HTTP（127.0.0.1 / localhost）エンドポイントを入力してください。",
        insecure_chat_endpoint: "外部への非 HTTPS URL や URL 内の認証情報は使えません。HTTPS またはローカル HTTP を使ってください。",
        invalid_chat_model: "モデル名を入力してください。",
        invalid_credential_ref: "認証情報の参照は環境変数名（例：OPENAI_API_KEY）で入力してください（ローカル不要なら空欄）。",
        invalid_chat_timeout: "タイムアウトは 1〜60 秒の整数で入力してください。",
        chat_timeout: "モデルの応答が時間内にありませんでした。",
        chat_connection_failed: "モデルに接続できませんでした。",
        chat_protocol_error: "モデルの応答を読み取れませんでした。",
        chat_empty_reply: "モデルから返答がありませんでした。",
        chat_response_too_large: "モデルの返答が大きすぎます。",
        chat_host_restarted: "返答の前に Kei ホストが再起動しました。",
        chat_cancelled: "中止しました。",
        chat_failed: "会話に失敗しました。",
        chat_queue_full: "ほかの会話の処理が多すぎます。少し待ってください。",
        invalid_chat_request: "質問を入力してください（4000 文字まで）。",
        conversation_not_found: "会話が見つかりません。",
        conversation_changed: "会話が切り替わったため、この結果は破棄しました。",
        invalid_selection: "選択した文章が正しくありません。",
        empty_selection: "先に文章を選択してください（空白だけの選択は送れません）。",
        selection_unsupported: "この環境では選択中の文章を直接読み込めません。貼り付けてください。",
        selection_external_focus: "PDF ウィンドウで文章を選択し、Ctrl + Alt + Q を押してください。",
        reading_unavailable: "読書プラグイン（kei.pdf）を有効にしてください。",
        message_too_large: "データが大きすぎます。",
        slot_denied: "このウィンドウでは開けないページです。",
        host_unavailable: "Kei ホストに接続できません。",
        forbidden: "このウィンドウからは実行できません。",
        invalid_archive: "プラグインのパッケージ（ZIP）が正しくありません。",
        invalid_manifest: "metadata.yaml が正しくありません。",
        unsupported_api: "このバージョンの Kei では使えないプラグインです。",
        unsupported_feature: "このプラグインが必要とする機能に Kei が対応していません。",
        plugin_exists: "同じ ID のプラグインがすでにインストールされています。",
        duplicate_entry: "プラグイン内でページ ID が重複しています。",
        invalid_grants: "許可する権限が正しくありません。",
        activation_failed: "プラグインを起動できませんでした。",
        plugin_not_found: "プラグインが見つかりません。",
        package_too_large: "パッケージが大きすぎます（上限 8 MiB）。",
        internal_error: "内部エラーが発生しました。",
        // Round 07: executors
        cli_missing: "CLI が見つかりません。",
        codex_not_configured: "Codex が設定されていません。",
        executor_unavailable: "この実行エージェントは現在使えません。",
        executor_not_found: "実行エージェントが見つかりません。",
        invalid_task_input: "依頼内容を入力してください（8000 文字まで）。",
        invalid_options: "オプションが正しくありません。",
        request_conflict: "同じリクエスト ID の別のタスクがあります。",
        runtime_restarted: "ホストの再起動で中断されました（再実行はしていません）。",
        cancelled: "中止されました。",
        adapter_exited: "実行エージェントが異常終了しました。",
        task_not_found: "タスクが見つかりません。",
        // Round 07: MCP
        user_cancelled: "実行をキャンセルしました。",
        confirmation_required: "実行の確認が必要です。",
        mcp_transport_error: "MCP サーバーに接続できません。",
        mcp_executable_unavailable: "stdio の実行ファイルが見つかりません。",
        mcp_server_disabled: "この MCP サーバーは無効です。",
        mcp_server_not_found: "MCP サーバーが見つかりません。",
        mcp_timeout: "MCP サーバーの応答が時間内にありませんでした。",
        mcp_protocol_error: "MCP サーバーがプロトコルエラーを返しました。",
        mcp_outcome_unknown: "前回の要求が実行されたかどうか不明です（再送していません）。",
        mcp_sdk_unavailable: "ホストに MCP SDK がインストールされていません。",
        invalid_server_id: "ID は英小文字・数字・._- で入力してください。",
        invalid_server_name: "名前を入力してください。",
        invalid_transport: "接続方式が正しくありません。",
        invalid_timeout: "タイムアウトは 1〜60 秒で入力してください。",
        invalid_protocol_mode: "プロトコルの指定が正しくありません。",
        invalid_read_only_tools: "読み取り専用ツール名が正しくありません。",
        invalid_credential_ref: "環境変数名が正しくありません（英数字と _ のみ）。",
        invalid_command: "コマンドを入力してください。",
        invalid_args: "引数が正しくありません。",
        invalid_cwd: "作業フォルダが正しくありません。",
        invalid_url: "URL が正しくありません。",
        credential_in_url: "URL に認証情報を含めないでください。",
        insecure_credential_url: "認証情報を使う HTTP 接続は HTTPS かループバック（127.0.0.1）だけです。",
        invalid_arguments: "引数は JSON オブジェクトで入力してください。",
    };
    const CLOSE_REASON = {
        "plugin.disabled": "プラグインが無効になったため閉じました",
        "plugin.reloaded": "プラグインを再読み込みしたため閉じました。もう一度開いてください",
        "plugin.uninstalled": "プラグインがアンインストールされたため閉じました",
        "plugin.activation_failed": "プラグインの起動に失敗したため閉じました",
        page_closed: "ページの接続が切れたため閉じました",
        host_unavailable: "ホストとの接続が切れたため閉じました",
        host_disconnected: "ホストとの接続が切れたため閉じました",
        reset: "ホストが再起動したため閉じました",
        navigated: "ページが移動しようとしたため閉じました",
        user: "",
    };

    const errorText = code => ERROR_TEXT[code] || `エラー（${code}）`;

    class PluginFrameHost {
        constructor(bridge, { onClosed } = {}) {
            this.bridge = bridge;
            this.frames = new Map(); // tag -> { iframe, info, loads }
            this.onClosed = onClosed || (() => {});
            window.addEventListener("message", event => this.#onMessage(event));
            // Kei plugin base style: keep every mounted page on the shell's colour theme.
            document.addEventListener("kei:theme", () => { for (const record of this.frames.values()) this.#postTheme(record); });
            bridge.pages.onEvent((tag, event) => this.#deliverEvent(tag, event));
            bridge.pages.onClosed((tag, reason) => this.#remove(tag, reason));
        }

        // Opens (pluginId, entryId) and mounts it into container. Returns frame info or throws.
        async mount(container, pluginId, entryId, isCurrent = () => true) {
            const response = await this.bridge.pages.open(pluginId, entryId);
            if (!response?.ok) {
                const error = new Error(errorText(response?.error?.code));
                error.code = response?.error?.code;
                throw error;
            }
            const info = response.frame;
            if (!isCurrent()) {
                await this.bridge.pages.close(info.tag).catch(() => {});
                return null;
            }
            const iframe = document.createElement("iframe");
            iframe.className = "plugin-frame";
            // Round 09: allow-forms lets packaged pages (kei.pdf) receive submit events. Actual
            // submission still goes nowhere: the host CSP has form-action 'none' and main denies
            // every frame navigation. allow-same-origin is never granted.
            iframe.setAttribute("sandbox", "allow-scripts allow-forms");
            iframe.setAttribute("referrerpolicy", "no-referrer");
            iframe.setAttribute("allow", "");
            iframe.title = info.title;
            iframe.dataset.keiFrame = info.tag;
            iframe.dataset.pluginId = info.pluginId;
            iframe.dataset.entryId = info.entryId;
            const record = { iframe, info, loads: 0 };
            // The first load is our document; any later load means the child navigated.
            iframe.addEventListener("load", () => {
                record.loads += 1;
                if (record.loads > 1) this.close(info.tag, "navigated");
                else this.#postTheme(record);
            });
            this.frames.set(info.tag, record);
            iframe.src = info.url;
            container.append(iframe);
            return info;
        }

        #postTheme(record) {
            const theme = window.KeiTheme?.current?.() || document.documentElement.dataset.theme || "hakuji";
            record.iframe.contentWindow?.postMessage({ type: "kei:theme", theme }, "*");
        }

        #recordFor(source) {
            if (!source) return null;
            for (const [tag, record] of this.frames) {
                if (record.iframe.contentWindow === source) return [tag, record];
            }
            return null;
        }

        async #onMessage(event) {
            // Round 08: a plugin frame is sandboxed without allow-same-origin, so its messages
            // must carry the opaque origin "null" as well as come from its own contentWindow.
            if (event.origin !== "null") return;
            const found = this.#recordFor(event.source);
            if (!found) return; // not from one of our plugin frames
            const [tag, record] = found;
            const data = event.data;
            if (data && typeof data === "object" && data.type === "kei:capture-request") {
                // Round 08: a page may only *ask* main to start or stop trusted capture.
                const id = typeof data.id === "string" ? data.id.slice(0, 128) : null;
                let reply;
                try { reply = await this.bridge.capture.request(tag, data.enabled === true); } catch { reply = { ok: false, error: { code: "action_failed" } }; }
                if (!this.frames.has(tag) || !record.iframe.contentWindow) return;
                record.iframe.contentWindow.postMessage(reply?.ok
                    ? { type: "kei:result", id, ok: true, result: { enabled: Boolean(reply.status?.active) } }
                    : { type: "kei:result", id, ok: false, error: { code: reply?.error?.code || "action_failed", message: errorText(reply?.error?.code) } }, "*");
                return;
            }
            if (data && typeof data === "object" && data.type === "kei:mcp-confirm") {
                // Round 08 decision 1: only serverId/toolName/arguments are forwarded; main binds the plugin.
                const id = typeof data.id === "string" ? data.id.slice(0, 128) : null;
                let reply;
                try { reply = await this.bridge.mcpConfirm(tag, { serverId: data.serverId, toolName: data.toolName, arguments: data.arguments }); }
                catch { reply = { ok: false, error: { code: "action_failed" } }; }
                if (!this.frames.has(tag) || !record.iframe.contentWindow) return;
                record.iframe.contentWindow.postMessage(reply?.ok
                    ? { type: "kei:result", id, ok: true, result: { confirmation: reply.confirmation, readOnly: reply.readOnly } }
                    : { type: "kei:result", id, ok: false, error: { code: reply?.error?.code || "action_failed", message: errorText(reply?.error?.code) } }, "*");
                return;
            }
            if (!data || typeof data !== "object" || data.type !== "kei:call") return;
            // Forward only the fields the protocol defines; main validates them again.
            const message = { type: "kei:call", id: data.id, action: data.action, arguments: data.arguments };
            let reply;
            try {
                reply = await this.bridge.pages.call(tag, message);
            } catch {
                reply = { ok: false, id: data.id, error: { code: "action_failed" } };
            }
            if (!this.frames.has(tag) || !record.iframe.contentWindow) return;
            const id = typeof data.id === "string" ? data.id : null;
            const out = reply.ok
                ? { type: "kei:result", id, ok: true, result: reply.result }
                : { type: "kei:result", id, ok: false, error: { code: reply.error?.code || "action_failed", message: errorText(reply.error?.code) } };
            record.iframe.contentWindow.postMessage(out, "*");
        }

        #deliverEvent(tag, event) {
            const record = this.frames.get(tag);
            if (!record?.iframe.contentWindow) return;
            record.iframe.contentWindow.postMessage({ type: "kei:event", topic: event.topic, data: event.data }, "*");
        }

        #remove(tag, reason) {
            const record = this.frames.get(tag);
            if (!record) return;
            this.frames.delete(tag);
            record.iframe.remove();
            this.onClosed(record.info, reason, CLOSE_REASON[reason] ?? "ページを閉じました");
        }

        async close(tag, reason = "user") {
            if (!this.frames.has(tag)) return;
            this.#remove(tag, reason);
            await this.bridge.pages.close(tag, reason === "navigated" ? "navigated" : "user").catch(() => {});
        }

        // Round 09: deliver a selection that main has already vetted for this frame.
        sendSelection(tag, selection) {
            const record = this.frames.get(tag);
            if (!record?.iframe.contentWindow) return false;
            const deliver = () => {
                if (this.frames.get(tag) !== record) return;
                record.iframe.contentWindow?.postMessage({ type: "kei:selection", text: selection.text, source: selection.source, page: selection.page }, "*");
            };
            if (record.loads === 0) record.iframe.addEventListener("load", deliver, { once: true });
            else deliver();
            return true;
        }

        closeAll(reason = "user") {
            for (const tag of [...this.frames.keys()]) this.close(tag, reason);
        }

        openTags() { return [...this.frames.keys()]; }
    }

    window.KeiPluginFrames = { PluginFrameHost, errorText };
})();

"use strict";
// Plain-language descriptions and risk levels for plugin permission scopes, used by the
// plugin cards in the admin window. Unknown scopes fall back to a pattern, then to "unknown".
(function () {
    const KNOWN = {
        "attachments.read": ["添付ファイルを読む", "会話に添付したファイルの文章を読み取ります。", "low", "file"],
        "focus.read": ["タイマーの状態を見る", "集中タイマーの残り時間や記録を読みます。", "low", "time"],
        "focus.control": ["タイマーを操作する", "集中タイマーの開始・一時停止・スキップを行います。", "low", "time"],
        "focus.migrate": ["以前のタイマー記録を取り込む", "旧 Kei Desktop の集中タイマーの記録を読み込みます。", "mid", "import"],
        "pdf.read": ["読書プランを見る", "読書プランと進み具合を読みます。", "low", "book"],
        "pdf.write": ["読書プランを変更する", "読書プランの作成や進み具合の更新を行います。", "mid", "book"],
        "pdf.migrate": ["以前の読書プランを取り込む", "旧 Kei Desktop の読書プランを読み込み、取り消しもできます。", "mid", "import"],
        "chat.ask": ["ケイに質問を送る", "選んだ文章と質問を会話モデルに送ります。モデルの利用料がかかる場合があります。", "mid", "chat"],
        "observation.read": ["画面観察の状態を見る", "画面観察が動いているかどうかを読みます。", "low", "eye"],
        "observation.control": ["画面観察を切り替える", "画面観察の開始・停止を求めます。開始には毎回あなたの選択が必要です。", "mid", "eye"],
        "vision.describe": ["画面の画像をモデルに送る", "観察中の画面を画像としてモデルに送り、短い説明を作ります。画面の内容が外部のモデルに渡ります。", "high", "eye"],
        "bili.read": ["Bilibili を検索・閲覧する", "動画の検索や情報の取得を読み取り専用で行います。", "net", "net"],
        "bili.interact": ["Bilibili に投稿する", "コメントなどを投稿します。実行のたびに確認ダイアログが出ます。", "high", "net"],
        "mcp.call": ["MCP ツールを実行する", "登録した MCP サーバーのツールを呼び出します。読み取り専用以外のツールは毎回確認が出ます。", "high", "tool"],
        "astrbot.memory.read": ["AstrBot の記憶を見る", "AstrBot の連携状態や取り込み結果を読みます。", "net", "net"],
        "astrbot.memory.handoff": ["会話を AstrBot に渡す", "確認した会話の記録を AstrBot に送ります。", "high", "net"],
        "counter.read": ["カウンターを見る", "カウンターの値を読みます。", "low", "data"],
        "counter.write": ["カウンターを変更する", "カウンターの値を増やしたり戻したりします。", "low", "data"],
    };
    const PATTERNS = [
        [/^model\.provide\.(tts|asr|vision|embedding)$/, m => [`${{ tts: "音声合成", asr: "音声認識", vision: "画像理解", embedding: "埋め込み" }[m[1]]}モデルを提供する`, "管理 → モデル で選ばれたとき、このプラグインがその機能を担当します。", "mid", "model"]],
        [/\.(read|preview)$/, () => ["データを読む", "このプラグインのデータを読み取ります。", "low", "data"]],
        [/\.(write|control|settings|select|solve)$/, () => ["設定や状態を変更する", "このプラグインの設定や状態を変更します。", "mid", "data"]],
        [/\.(migrate|import)$/, () => ["以前のデータを取り込む", "古い形式のデータを読み込みます。", "mid", "import"]],
    ];
    const RISK = {
        low: ["読み取り・軽い操作", "low"],
        mid: ["変更を伴う", "mid"],
        net: ["インターネット接続", "mid"],
        high: ["外部に送信・実行", "high"],
        unknown: ["説明なし", "unknown"],
    };
    function describe(scope) {
        if (KNOWN[scope]) { const [label, desc, risk, icon] = KNOWN[scope]; return { scope, label, desc, risk, icon, known: true }; }
        for (const [pattern, make] of PATTERNS) {
            const m = scope.match(pattern);
            if (m) { const [label, desc, risk, icon] = make(m); return { scope, label, desc, risk, icon, known: false }; }
        }
        return { scope, label: scope, desc: "このプラグインが独自に定義した権限です。内容をプラグインの説明で確認してください。", risk: "unknown", icon: "data", known: false };
    }
    const ICONS = {
        file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
        time: '<circle cx="12" cy="13" r="7"/><path d="M12 9v4l2.5 2M9 3h6"/>',
        import: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
        book: '<path d="M12 6c-2-1.3-4.5-1.6-7-1v13c2.5-.6 5-.3 7 1 2-1.3 4.5-1.6 7-1V5c-2.5-.6-5-.3-7 1zM12 6v13"/>',
        chat: '<path d="M5 5h14v10H10l-5 4z"/>',
        eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
        net: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
        tool: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
        model: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
        data: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
    };
    window.KeiPermissions = { describe, RISK, ICONS };
})();

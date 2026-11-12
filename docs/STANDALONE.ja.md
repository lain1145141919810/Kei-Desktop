# Kei Desktop 設定ガイド

[Windows x64 版](https://github.com/lain1145141919810/Kei-Desktop/releases/tag/v0.3.0)を展開し、Kei Desktop.exe を起動します。「操作」から管理ウィンドウを開き、「設定 → 接続設定を開く」で standalone.json を編集してください。保存後はアプリを再起動します。

## 接続設定

| 項目 | 設定 |
|---|---|
| chat | provider は compatible。url に /v1/chat/completions まで含む URL、model にモデル名、必要に応じて key を指定します。回答は日本語で生成するよう指示します。 |
| astrbot | 任意。chat.provider を astrbot にし、astrbot.url に /api/v1/chat の URL、astrbot.key に API キーを指定します。 |
| dsh | 管理ウィンドウで「DSH タスク」を選びます。リモート接続では url に /executors/run の URL、token にブリッジトークンを指定し、サーバー側で DSH を選びます。ローカル実行では Node.js と @deepseek-ai/dsh をインストールしてログインし、url は空欄、entry は @deepseek-ai/dsh/lib/bin.js の絶対パス、workspace は作業フォルダーを指定します。 |
| vision | 画像入力に対応した url、model、必要に応じて key を指定します。url が空の場合は chat の設定を使います。 |

## デスクトップ

- **Live2D** のモデル・テクスチャ・シェーダーは同梱されています。管理ウィンドウの「設定」から立ち絵・起動画面・終了画面を個別に変更できます。PNG、JPEG、WebP、GIF、MP4、WebM に対応します。変更後は再起動してください。media.portrait を空にすると同梱モデルに戻ります。
- **マイク** は F8 または「操作」の録音ボタンで開始し、もう一度押して終了します。Windows のマイク使用を許可してください。音声認識には Python 3.11 と faster-whisper が必要です。下記を PowerShell で実行し、asr.python に作成した python.exe の絶対パスを設定します。asr.model の既定値 small は初回使用時にモデルをダウンロードします。取得済みの CTranslate2 モデルのフォルダーも指定できます。

      py -3.11 -m venv "$env:LOCALAPPDATA/KeiASR"
      & "$env:LOCALAPPDATA/KeiASR/Scripts/python.exe" -m pip install faster-whisper

- **長期記憶** は「覚えておいて：好きな色は青」と伝えるか、管理ウィンドウの「設定 → 長期記憶」で登録します。ユーザーごとの memory.sqlite に保存され、関連する会話でモデルに渡されます。個別に削除できます。「以前の記憶を取り込む」で個人用の MemoryCompanion の memory_companion.db を選ぶと、有効な記憶の本文を現在のユーザーへ取り込みます。元のデータベースは読み取り専用で開きます。
- **PDF 読書** はリーダーで文章を選択して Ctrl+Alt+Q を押します。「読書」パネルへの貼り付け、抜粋への質問、読書計画と進捗の記録にも対応します。
- **画面観察** は「操作」または Ctrl+Alt+S で切り替えます。有効にするとカーソルのある画面の画像を vision の接続先に送り、日本語の説明を受け取ります。オフにすると撮影を止め、直近の観察キャッシュを消去します。

## GPT-SoVITS v3 と学習済み音声

1. [上流の手順](https://github.com/RVC-Boss/GPT-SoVITS/tree/9da7e17efe05041e31d3c3f42c8730ae890397f2)に従って v3 を導入します。[Windows 用配布パッケージ](https://huggingface.co/lj1995/GPT-SoVITS-windows-package/resolve/main/GPT-SoVITS-v3lora-20250228.7z)も利用できます。ソースから導入する場合は RoBERTa、HuBERT、v3 基本モデル、BigVGAN などの[学習済みファイル](https://huggingface.co/lj1995/GPT-SoVITS/tree/main)を配置します。
2. [key-e15.ckpt](https://github.com/lain1145141919810/Kei-Desktop/releases/download/v0.2.0/key-e15.ckpt) を GPT_weights_v3 に、[key_e2_s706_l32.pth](https://github.com/lain1145141919810/Kei-Desktop/releases/download/v0.2.0/key_e2_s706_l32.pth) を SoVITS_weights_v3 に置きます。
3. GPT_SoVITS/configs/tts_infer.yaml をルートの kei-v3.yaml にコピーします。custom セクションに v3 セクションの設定を写し、version を v3、t2s_weights_path を GPT_weights_v3/key-e15.ckpt、vits_weights_path を SoVITS_weights_v3/key_e2_s706_l32.pth にします。device と is_half は環境に合わせてください。配布パッケージのルートで実行します。

       .\runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c kei-v3.yaml

4. speech.enabled を true、speech.url を http://127.0.0.1:9880/tts に設定します。referencePath はサーバーから読める参照 WAV の絶対パス、referenceText は録音どおりの書き起こし、referenceLanguage はその録音の言語です。参照 WAV は各自で用意してください。読み上げ言語は日本語です。

## ローカル HTTP API

起動中は http://127.0.0.1:17883 で利用できます。ポートは api.port で変更できます。POST は JSON と Authorization: Bearer ヘッダーを使います。トークンは初回起動時に api.token に保存されます。

| パス | 入出力 |
|---|---|
| GET /health | 稼働状態を返します。認証は不要です。 |
| POST /v1/chat | text と任意の session、history を受け取り、text を返します。history は role と content の配列です。 |
| POST /v1/task | text と任意の session を受け取り、DSH の結果を返します。 |
| POST /v1/speech | text から日本語の WAV 音声を生成します。 |

    $headers = @{Authorization = "Bearer 設定ファイルのトークン"}
    $body = @{text = "こんにちは"; session = "example"} | ConvertTo-Json
    Invoke-RestMethod http://127.0.0.1:17883/v1/chat -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body
    Invoke-WebRequest http://127.0.0.1:17883/v1/speech -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body -OutFile reply.wav

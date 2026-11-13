# Kei Desktop v0.3.2 中文安装与配置指南

从 [v0.3.2 发布页](https://github.com/lain1145141919810/Kei-Desktop/releases/tag/v0.3.2)下载 Kei-Desktop-Windows-x64.zip，完整解压到自己有写入权限的文件夹，双击 **Kei Desktop.exe**。程序包已包含 Electron 和 Live2D。文字对话需连接模型服务。麦克风识别、语音朗读、AstrBot、DSH 按需配置。

需要让 AI 帮忙安装时，可直接复制[中文 AI 安装提示词](../KeiDesktop/standalone/AI-INSTALL.zh.txt)。发布页也提供这两份中文文件的独立下载。软件界面、默认回复和语音使用日语，下面保留界面里的日文按钮名，方便对照。

## 安装、更新与首次设置

1. 下载并完整解压 ZIP，运行文件夹里的 Kei Desktop.exe。更新时先退出旧版，再将新包解压到新的文件夹并启动。用户设置、记忆和角色素材存放在应用的用户数据目录中。
2. 首次启动会出现「キャラクター設定」。填写角色名和人格提示词，按需选择立绘、起动画面、结束画面和开机音效。也可直接保存默认角色，或选择「パックを読み込む」导入别人配布的 character.json。
3. 保存后进入桌面。在「操作」里选择「管理ウィンドウを開く」，再选择「設定 → 接続設定を開く」，打开本机 standalone.json。填写模型接口后保存并重启。
4. 发送一条短消息，确认日语回复。需要语音时，再按下方步骤启用。
5. 后续可从「操作 → キャラクター設定」修改角色。角色名立即用于主窗口、小窗口和后续生成的历史显示；人格立即用于新的对话、PDF 问答、屏幕观察、AstrBot、DSH 和本地 API 请求。

角色设置中支持直接输入人格，或从 UTF-8 TXT / Markdown 读取。「配布用に書き出す」会导出角色名、人格及所选素材组成的文件夹。分享整个文件夹即可。接收者选择 character.json、检查内容并保存，素材会复制到应用的用户目录中。API 密钥和记忆不包含在角色包里。开机音效支持 WAV、MP3、OGG、M4A、FLAC，修改后从下次启动生效。

## 对话、视觉与任务接口

| 配置项 | 填写方法 |
|---|---|
| chat | provider 默认 compatible。url 填完整的 Chat Completions 地址，例如 http://127.0.0.1:11434/v1/chat/completions；model 填服务实际提供的模型名；需要鉴权时填写 key。 |
| vision | 填支持图片输入的 url、model 和可选 key。vision.url 留空时使用 chat 的兼容接口。 |
| astrbot | 可选。chat.provider 改为 astrbot，astrbot.url 填完整 /api/v1/chat 地址，astrbot.key 填有效密钥。 |
| dsh | 可选。远程任务接口填 dsh.url（完整 /executors/run 地址）、dsh.token，并在服务端选择 DSH。 |
| dsh.entry、dsh.workspace | 本机运行时，安装 Node.js 和 @deepseek-ai/dsh 并完成其登录。留空 dsh.url；entry 填全局模块目录下 @deepseek-ai/dsh/lib/bin.js 的绝对路径；workspace 填已存在的工作文件夹。管理窗口选择「DSH タスク」使用。 |

直接编辑 standalone.json 后需重启。角色设置和「音声読み上げ設定」界面保存的修改会在后续请求中生效。

## 自选语音朗读服务

打开管理窗口的「設定 → 音声読み上げ設定」，勾选「読み上げを有効にする」，选择 GPT-SoVITS 或「外部 TTS API」，保存即可。未启用时可继续文字对话。两种方式共用本地 POST /v1/speech 和桌面播放流程，旧配置按 GPT-SoVITS 沿用。

### 使用自己的 TTS API

填写完整的 POST URL。本文字段名填服务接受的字段，/v1/audio/speech 兼容端点常用 input，其他服务可能用 text。按提供方规格填写模型、音色 ID、可选的 Bearer 密钥和附加 JSON 参数，例如 {"speed":1.0,"response_format":"mp3"}。实际字段和值以服务文档为准。

请求会将输入文本放到指定字段，model、voice 非空时一并提交，其余固定字段取自附加 JSON。服务需直接返回 audio/* 类型的音频二进制。WAV、MP3 等能由客户端解码的格式可以使用。当前不支持 JSON 内的 Base64、音频下载链接或自定义鉴权头。使用外部 TTS 时可省去 GPT-SoVITS 环境和模型下载。密钥留空会保留已保存值，勾选删除可清除。

### 使用 GPT-SoVITS v3 和凯伊权重

1. 按 [GPT-SoVITS 上游说明](https://github.com/RVC-Boss/GPT-SoVITS/tree/9da7e17efe05041e31d3c3f42c8730ae890397f2)部署 v3。Windows 可使用上游的 [v3 整合包](https://huggingface.co/lj1995/GPT-SoVITS-windows-package/resolve/main/GPT-SoVITS-v3lora-20250228.7z)。源码安装需准备 RoBERTa、HuBERT、v3 基础模型、BigVGAN 等[预训练文件](https://huggingface.co/lj1995/GPT-SoVITS/tree/main)。
2. 下载 [key-e15.ckpt](https://github.com/lain1145141919810/Kei-Desktop/releases/download/v0.2.0/key-e15.ckpt)，放入 GPT_weights_v3；下载 [key_e2_s706_l32.pth](https://github.com/lain1145141919810/Kei-Desktop/releases/download/v0.2.0/key_e2_s706_l32.pth)，放入 SoVITS_weights_v3。
3. 将 GPT_SoVITS/configs/tts_infer.yaml 复制为根目录的 kei-v3.yaml。custom 段采用原文件 v3 段的参数，version 为 v3；t2s_weights_path 设为 GPT_weights_v3/key-e15.ckpt，vits_weights_path 设为 SoVITS_weights_v3/key_e2_s706_l32.pth。device 和 is_half 按机器配置。在整合包根目录执行下方命令，源码部署使用对应环境的 python。

       .\runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c kei-v3.yaml

4. 在朗读设置里选择 GPT-SoVITS，URL 填 http://127.0.0.1:9880/tts。referencePath 填语音服务器可读取的参考 WAV 绝对路径；referenceText 填录音逐字文本；referenceLanguage 填参考音频语言，例如 ja。参考录音由用户自行提供。朗读语言为日语。
5. 保存后发送一条短消息，确认声音能播放。

## 麦克风、记忆与阅读

- **麦克风识别**需要 Python 3.11。执行下方命令后，将 standalone.json 中的 asr.python 填为生成的 python.exe 绝对路径。asr.model 默认 small，首次识别时下载；也可填已有 CTranslate2 Whisper 模型目录。允许 Windows 麦克风访问，按 F8 或「操作」中的录音按钮开始，再按一次结束。识别语言为日语，识别在本机 CPU 上运行。

      py -3.11 -m venv "$env:LOCALAPPDATA/KeiASR"
      & "$env:LOCALAPPDATA/KeiASR/Scripts/python.exe" -m pip install faster-whisper

- **长期记忆**可用「覚えておいて：……」登记，或在管理窗口的「設定 → 長期記憶」添加、删除。记忆保存在用户目录的 memory.sqlite。导入个人 MemoryCompanion 的 memory_companion.db 时，程序只读源库，将有效记忆正文复制到当前用户；关系图、权限与聊天日志需另外处理。
- **PDF 阅读**在阅读器中选中文字后按 Ctrl+Alt+Q，或在「読書」面板粘贴摘录。支持片段问答、阅读计划和页码进度。
- **屏幕观察**在「操作」或用 Ctrl+Alt+S 开关。开启后，光标所在显示器的截图会发送给配置的视觉模型。关闭会停止后续捕获并清除当前观察缓存。
- **立绘和过场**支持 PNG、JPEG、WebP、GIF、MP4、WebM。在角色设置中可单独恢复默认素材。原桌面的窗口和工具栏沿用原布局。

## 本地 HTTP API

程序启动后默认监听 http://127.0.0.1:17883。端口可在 api.port 调整。POST 使用 JSON 和 Authorization: Bearer <api.token>，令牌首次启动时生成。

| 路径 | 请求与返回 |
|---|---|
| GET /health | 返回运行状态，无需鉴权。 |
| POST /v1/chat | text 必填，session 和 history 可选；history 各项包含 role（user 或 assistant）和 content。返回 text。 |
| POST /v1/task | text 必填，session 可选，返回 DSH 任务结果。 |
| POST /v1/speech | text 必填，使用当前选中的 TTS 服务，保留其音频 Content-Type。GPT-SoVITS 返回 WAV，外部服务可能返回 MP3 等。 |

PowerShell 调用示例，下面的文件扩展名按实际输出格式调整。

    $headers = @{Authorization = "Bearer 配置里的令牌"}
    $body = @{text = "こんにちは"; session = "example"} | ConvertTo-Json
    Invoke-RestMethod http://127.0.0.1:17883/v1/chat -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body
    Invoke-WebRequest http://127.0.0.1:17883/v1/speech -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body -OutFile reply.wav

## 从源码启动

安装 Node.js 24 和 Git 后克隆仓库，在 KeiDesktop 目录执行 npm ci、npm start。Windows 压缩包可通过 Build-Portable.ps1 构建。原 AstrBot 插件链的部署流程见[原版迁移指南](MIGRATION.zh.md)。

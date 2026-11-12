# 独立版配置

从 [v0.3.0 发布页](https://github.com/lain1145141919810/Kei-Desktop/releases/tag/v0.3.0) 下载 Kei-Desktop-Windows-x64.zip。解压整个目录，运行 **Kei Desktop.exe**。文字对话需要一个可用的模型服务。桌面程序可先离线启动、显示角色和更换素材。开发者也可以在 KeiDesktop 目录执行 `npm ci`、`npm start`。运行 `./Build-Portable.ps1` 可重新生成 Windows 压缩包。

## 对话与任务

在主窗口通过「操作 → 管理」打开管理窗口，再选择「设置 → 打开接口配置」。这是当前 Windows 用户的 standalone.json，含本地 API 令牌。保存后退出并重启程序。

| 配置项 | 填写内容 |
|---|---|
| chat.provider | 默认 compatible。使用提供 Chat Completions 格式的本地或远程模型，填写 chat.url 的完整 /v1/chat/completions 地址和 chat.model 的实际模型名。需要鉴权时填写 chat.key。 |
| astrbot | 可选。将 chat.provider 改为 astrbot，填写 astrbot.url（完整 /api/v1/chat 地址）及 astrbot.key。使用 AstrBot 的流式文本与会话接口。 |
| dsh | 可选。任务模式与普通对话分开。使用现有 KeiRuntime 时，填 dsh.url（完整 /executors/run 地址）及 dsh.token（其 desktop-bridge.token），并在服务端选 DSH 后端。 |
| dsh.entry、dsh.workspace | 独立运行本机 DSH 时，留空 dsh.url，安装 Node.js 和 @deepseek-ai/dsh，完成 DSH 自身登录。用 `npm root -g` 找到全局模块目录，把其下 @deepseek-ai/dsh/lib/bin.js 的完整路径填入 entry，workspace 填一个已存在的任务目录。先在该目录运行 `dsh headless "回复 OK"` 确认服务可用。任务按当前 Windows 用户的权限执行。 |

## 原桌面与本地功能

默认打开原版桌面。通过「操作 → 管理」打开接口设置、DSH 任务和素材设置。Live2D 模型、纹理和着色器随程序提供，离线即可显示；清空 media.portrait 并重启可从自定义立绘切回模型。

- **语音输入**。先安装 Python 3.11，在 PowerShell 执行 `py -3.11 -m venv "$env:LOCALAPPDATA/KeiASR"`，然后执行 `& "$env:LOCALAPPDATA/KeiASR/Scripts/python.exe" -m pip install faster-whisper`。在配置的 asr.python 填这个 python.exe 的实际绝对路径。asr.model 默认 small，首次识别时下载模型，也可填现有 CTranslate2 Whisper 模型目录。按 F8 开始和结束录音，识别出的文字直接进入对话。需要 Windows 麦克风权限，识别在本机 CPU 上运行。
- **长期记忆**。对凯伊说「记住：……」或在管理窗口的「设置 → 长期记忆」添加条目。记忆保存到当前用户的 memory.sqlite；可逐条删除。导入个人旧库时选择 MemoryCompanion 的 memory_companion.db，程序只读源库，将有效条目的正文复制到本地。导入后属于当前桌面用户。这里不迁移关系图、权限和聊天日志。
- **PDF 阅读**。在阅读器中选中文字后按 Ctrl+Alt+Q，或在「読書」面板粘贴片段。可以创建阅读计划、更新页码、围绕片段提问。PDF 原文件保留在阅读器中。
- **屏幕观察**。在「操作」中打开或关闭，快捷键为 Ctrl+Alt+S。观察会把当前显示器截图发给配置的视觉模型。填写 vision.url、vision.model 和可选的 vision.key；留空 vision.url 时使用 chat 的兼容接口，该模型须支持图片输入。关闭观察会停止后续捕获并清除当前观察缓存。
- 原 AstrBot 插件链仍可通过 [旧版部署流程](MIGRATION.zh.md) 启动。

## 绘制角色与过场

在「设置」中分别选择「替换立绘」「替换开头画面」「替换结尾画面」。支持 PNG、JPEG、WebP、GIF、MP4、WebM。立绘可以用透明 PNG 或循环视频。静态过场约显示 1.5 秒，点击可以跳过。素材路径保存在 media 中；文件移走后使用内置素材。清空相应路径并重启即可恢复默认。

## GPT-SoVITS v3 与凯伊权重

1. 根据 [GPT-SoVITS 上游说明](https://github.com/RVC-Boss/GPT-SoVITS/tree/9da7e17efe05041e31d3c3f42c8730ae890397f2) 安装 v3 环境。Windows 可下载上游的 [v3 整合包](https://huggingface.co/lj1995/GPT-SoVITS-windows-package/resolve/main/GPT-SoVITS-v3lora-20250228.7z)。源码安装需准备上游列出的中文 RoBERTa、HuBERT、v3 基础模型和 BigVGAN 等[预训练文件](https://huggingface.co/lj1995/GPT-SoVITS/tree/main)。
2. 从本项目发布页下载训练后的 [GPT 权重 key-e15.ckpt](https://github.com/lain1145141919810/Kei-Desktop/releases/download/v0.2.0/key-e15.ckpt) 和 [SoVITS 权重 key_e2_s706_l32.pth](https://github.com/lain1145141919810/Kei-Desktop/releases/download/v0.2.0/key_e2_s706_l32.pth)，分别放入 GPT-SoVITS 根目录的 GPT_weights_v3 和 SoVITS_weights_v3。
3. 复制 GPT_SoVITS/configs/tts_infer.yaml 为 kei-v3.yaml，在副本的 custom 段采用原文件 v3 段的参数，保留 version 为 v3。将 t2s_weights_path 设为 GPT_weights_v3/key-e15.ckpt，vits_weights_path 设为 SoVITS_weights_v3/key_e2_s706_l32.pth。根据机器选择 device 和 is_half。使用整合包时在其根目录执行以下命令，源码安装则使用对应环境的 python。

       .\runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c kei-v3.yaml

4. 在桌面设置中将 speech.enabled 设为 true，speech.url 填 http://127.0.0.1:9880/tts。referencePath 填语音服务器能读取的干净参考 WAV 路径，referenceText 填这段录音的逐字文本，referenceLanguage 填参考音频语言（如 ja），language 填要朗读的文本语言（如 zh）。参考音频需自行提供。JSON 路径可使用正斜杠。
5. 重启桌面端，发送一句短消息。也可直接调用下方语音 API，检查能否得到 WAV。

## 本地 HTTP API

启动桌面程序后访问 http://127.0.0.1:17883。端口可在 api.port 修改。除 GET /health 外，所有请求均使用 POST、JSON 请求体和 Authorization: Bearer <api.token>。首次启动自动生成令牌。服务仅监听本机。

| 路径 | 请求与返回 |
|---|---|
| GET /health | 返回 service 和 status |
| POST /v1/chat | text 必填，session 可选。兼容模型可传 history 数组，每项含 role（user 或 assistant）及 content；服务返回 text。AstrBot 通过 session 维护历史。 |
| POST /v1/task | text 必填，session 可选。调用配置的 DSH 接口或本地命令，返回任务结果。 |
| POST /v1/speech | text 必填，以已配置的声音合成，返回 audio/wav 二进制内容。 |

PowerShell 示例：

    $headers = @{Authorization = "Bearer 把这里换成配置里的令牌"}
    $body = @{text = "你好"; session = "example"} | ConvertTo-Json
    Invoke-RestMethod http://127.0.0.1:17883/v1/chat -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body
    Invoke-WebRequest http://127.0.0.1:17883/v1/speech -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body -OutFile reply.wav

两份训练权重的 SHA-256：

    7eb0a0c112a2c986e510b8e79cef7af4cfbf5470e6dd17649734f80ab9f2a6ff  key-e15.ckpt
    99ed32207a3bebe02cb5b08e4d338f42e035e8cd9a144d13c676018e6340d610  key_e2_s706_l32.pth

# Kei Desktop

Kei 是运行在 Windows 上的角色桌面助手。Electron 主窗口通过本机 KeiRuntime 连接 Live2D、语音、DSH/Codex 和 AstrBot。此仓库保存可迁移的应用代码、角色运行素材、依赖清单及本机服务适配层。

| 目录 | 内容 |
|---|---|
| KeiDesktop | 桌面端、管理页、角色模型和场景、已构建的 Live2D 渲染器、测试、启动器 |
| KeiRuntime | FastAPI、语音输入输出、会话续接、存储管理、执行器、AstrBot 转交 |
| AstrBot-plugins | 已部署的六个插件及 AstrBot 兼容补丁 |
| GPT-SoVITS-overlay | Kei 的语音服务入口、监督脚本和路径配置 |

## 在新 Windows 机器上部署

1. 准备 D: 盘、Python 3.11（原机 3.11.9）、Node 24 和 Git。部署脚本沿用原机的 D:/KeiDesktop 与 D:/KeiRuntime。完整运行还需要原机的语音权重和 ASR 模型。
2. 克隆本仓库。在用户主目录克隆 GPT-SoVITS 并检出原机版本：

       git clone https://github.com/RVC-Boss/GPT-SoVITS.git "$env:USERPROFILE/GPT-SoVITS"
       git -C "$env:USERPROFILE/GPT-SoVITS" checkout 9da7e17efe05041e31d3c3f42c8730ae890397f2

3. 在本仓库执行 `./Install-KeiFiles.ps1 -WhatIf` 预览路径，再执行 `./Install-KeiFiles.ps1`。脚本拒绝覆盖已有安装。单独更新旧机器时请先备份。
4. 在 D:/KeiDesktop 以及 D:/KeiDesktop/live2d-official 中分别执行 `npm ci`。在 D:/KeiRuntime 创建虚拟环境并安装依赖：

       py -3.11 -m venv D:/KeiRuntime/.venv
       D:/KeiRuntime/.venv/Scripts/python.exe -m pip install -r D:/KeiRuntime/requirements-windows.txt

5. 安装 uv 并用 `uv tool install --python 3.11 astrbot==4.28.2` 安装 AstrBot。原启动器使用用户目录下的 uv 工具路径。用 AstrBot 管理页重新配置身份、模型提供商、插件和 API 密钥。桌面桥插件首次启动会创建本机专用令牌。将 ASTRBOT_API_KEY 设置为本机用户环境变量。
6. 在 GPT-SoVITS 目录创建 .venv，按上游说明安装对应 CUDA/PyTorch 依赖，再安装与原环境匹配的 aqua-tts 0.2.0。恢复下方列出的权重和参考音频。
7. 若使用 DSH，安装 `npm install -g @deepseek-ai/dsh` 并配置自己的 DeepSeek 凭据。若使用 Codex，在 D:/KeiRuntime/tools/codex-cli 执行 `npm ci`，重新登录；核对 data/executors.json 中受验证的程序、工作区和 SHA-256。更换二进制后先做权限测试。
8. 在 D:/KeiDesktop 运行 `npm test`，再运行 `./Start-Kei.ps1 -CheckOnly`。通过后用 `./Start-Kei.ps1` 启动。在管理页看服务健康状态，发送一条文字消息，确认回复、语音和口型。再用一个临时文本文件验证执行器能读到文件内容。

## 需要通过私有介质迁移的内容

- 从原机复制 D:/KeiRuntime/models 和实际启用的语音权重、预训练模型、参考音频。具体文件路径见 voices.json、aqua_astrbot_config.json、KeiRuntime/voice/references.json 以及 v2pro_compat_server.py。使用 V2Pro 时还需其对应的模型目录。训练权重与 GPU 环境未打包。
- 如需保留聊天历史，先关闭原机桌面端及后台，再复制 KeiRuntime/data/desktop-chat、Electron 用户数据下的 conversations，以及 AstrBot 的 data/plugin_data（原生长期记忆）。数据库请冷备整目录。执行器任务、附件分别在 data/executors、data/executor-workspace；原生 Codex 会话可能位于用户自己的 .codex/sessions。
- AstrBot 的私有提供商配置、人格、授权身份及插件设置由本人通过加密介质迁移或重新配置。重新登录 GitHub、Codex、DSH 和第三方服务。勿向公开仓库提交这些私有目录、数据库、访问令牌、观察截图或日志。
- 服务常用端口：17881（KeiRuntime）、17882（AstrBot 桌面桥）、17880/9880（语音）、6185（AstrBot）、5000（Live2D 开发服务）。启动器及部分底层集成依赖 Windows 固定路径。

仓库保留各组件自带的许可和声明。Live2D、角色素材及外部模型按各自条款使用。依赖下载、GPU 语音以及真实账号服务需要在目标机验收。

DSH 主模型和子代理使用 KeiRuntime/data/dsh-models.json；添加模型与重载步骤见 [模型目录说明](KeiRuntime/data/DSH-MODELS.zh.md)。

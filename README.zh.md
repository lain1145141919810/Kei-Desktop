<div align="center">

<img src="KeiDesktop/assets/branding/kei-logo.png" width="180" alt="Kei Desktop Logo">

# Kei Desktop

**与你交谈，陪你阅读，也能把工作交给她。**

Windows 桌面上的 Live2D AI 助手

[功能](#功能) · [实机展示](#实机展示) · [中文安装指南](docs/STANDALONE.zh.md) · [模型配置](KeiRuntime/data/DSH-MODELS.zh.md)

</div>

## Windows 独立版

[下载 Windows x64 独立版](https://github.com/lain1145141919810/Kei-Desktop/releases/tag/v0.3.2) · [中文安装与配置指南](docs/STANDALONE.zh.md) · [中文 AI 安装提示词](KeiDesktop/standalone/AI-INSTALL.zh.txt)

解压后运行 Kei Desktop.exe。可直接连接模型 API，按需接入 AstrBot、DSH 和 GPT-SoVITS。独立版沿用原桌面，支持 Live2D、语音输入、本地长期记忆、PDF 选段问答和屏幕观察。

![Kei Desktop 完整窗口](docs/screenshots/full-window.png)

## 功能

| 日常陪伴 | 工作与学习 |
|---|---|
| **语音与文字对话** — 输入问题或直接开口，字幕、口型与表情跟随语音播放 | **任务执行** — 把工作交给 DSH 或 Codex，查看进展和执行结果 |
| **桌面小窗** — 让凯伊留在桌面，用气泡交流，随时回到完整窗口 | **子 agent 分工** — 自动委派、先询问或手动指定执行与复核模型 |
| **对话续接** — 查看历史、选择旧对话继续，长对话通过摘要开启下一段 | **文件上下文** — 拖入文件，让执行器带着资料完成任务 |
| **屏幕陪伴** — 开启观察后，让凯伊了解你眼前的工作 | **PDF 阅读** — 围绕选中文字提问，记录阅读计划与进度 |
| **存储管理** — 按日期展开记录，清理上下文，释放空闲执行器 | **专注计时** — 在对话旁使用番茄钟，安排工作与休息 |

## 实机展示

### 留在桌面的凯伊

小窗保留角色、对话气泡和输入入口。双击角色、按 Esc 或 Ctrl + Alt + K，可以回到完整窗口。

![Kei Desktop 小窗模式](docs/screenshots/compact-mode.png)

### 专注一会儿

打开计时器，在聊天与工作之间安排一段专注时间。

![番茄钟](docs/screenshots/focus-timer.png)

### 一起读一份 PDF

在阅读器中选中文字，用 Ctrl + Alt + Q 交给凯伊解释、总结或翻译，也可以制定阅读计划。

![PDF 阅读面板](docs/screenshots/pdf-reading.png)

## 开始使用

1. 从上面的发布页下载并完整解压 Windows ZIP，运行 Kei Desktop.exe。
2. 在首次「キャラクター設定」中设置名字、人格、立绘和开机音效，也可导入别人配布的角色包。
3. 通过「操作 → 管理ウィンドウを開く → 設定 → 接続設定を開く」填写模型地址、模型名和必要的密钥，保存并重启。
4. 需要朗读时，在「設定 → 音声読み上げ設定」选择 GPT-SoVITS 或自己的外部 TTS API。外部服务需直接返回音频二进制。
5. 需要 AI 代为安装时，复制上面的中文 AI 安装提示词。

软件界面与语音使用日语。角色名、人格和素材的配布方法、麦克风识别、屏幕观察、本地 API 及源码启动步骤见[中文指南](docs/STANDALONE.zh.md)。原 AstrBot 插件链的安装方法见[原版迁移指南](docs/MIGRATION.zh.md)。

## 项目结构

| 目录 | 用途 |
|---|---|
| KeiDesktop/ | Electron 窗口、Live2D、界面与测试 |
| KeiRuntime/ | 对话、语音、任务执行与会话存储 |
| AstrBot-plugins/astrbot_plugin_kei/ | Kei 自身的后台桥接 |
| GPT-SoVITS-overlay/ | 语音服务适配 |

## 开源与致谢

自有代码采用 [MIT License](LICENSE)。素材与第三方组件的作者、来源和许可见[借物表](THIRD_PARTY_NOTICES.md)。

# 给凯伊添加 DSH 模型

编辑同目录 dsh-models.json；dsh-models.example.json 是结构示例。内置别名 flash、pro 仍然可用。每个新模型使用一个唯一的小写别名，可以包含数字和下划线；work 和 review 是保留名称。label 用于管理界面，model 必须与服务端标识完全一致。同一 provider 可注册多个模型。

1. 在 dsh_providers 中填写 DSH pi-ai 路由。OpenAI 兼容服务使用 openai-completions 和服务自己的 baseURL。远程使用 HTTPS，本机服务可以使用 http://127.0.0.1:端口/v1。API 密钥只放在后台进程可见的环境变量中，apiKeyEnv 填变量名。更改 Windows 用户环境变量后需从能读取新值的环境重新启动后台。对于 DSH 内置 DeepSeek 路由，直接使用 deepseek-official，无需增加服务条目。
2. 在 dsh_models 中填写别名、名称、provider、model，设 enabled 为 true。默认主模型由 dsh_default 指定。主执行器需要支持流式响应和工具调用，子模型的实际可用性取决于提供商、权限及协议兼容性。
3. 管理 → 実行エージェント → モデル一覧を再読み込み。手动模式可分别选择执行和复核的模型，自动与询问模式也使用同一目录。当前手动角色引用的模型须先换成其他模型，再移除。关闭子 agent 不会禁用主模型。
4. 做一次简单计算并要求用新别名独立复核，在执行器状态里确认子调用及结果。注册到目录不等于已验证服务连通；没有为未配置的外部服务自动发送请求。

这里设置的是 DSH 执行器与其原生子 agent；日常对话、语音和 Codex 继续使用各自的配置。

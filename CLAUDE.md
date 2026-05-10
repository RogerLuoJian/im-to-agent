# im-to-agent

通过飞书、企业微信等 IM 工具与电脑上的 Claude Code / Codex 交互的桥接服务。

## 项目结构

```
src/
├── index.ts              # 入口，启动服务
├── config.ts             # config.json 配置加载
├── logger.ts             # 日志工具
├── bridge.ts             # 核心桥接逻辑，处理消息路由
├── im/
│   ├── types.ts          # IM 适配器接口定义
│   ├── feishu/
│   │   ├── feishu-adapter.ts    # 飞书适配器实现
│   │   └── feishu-formatter.ts  # 消息卡片格式化
│   └── wecom/
│       ├── wecom-adapter.ts     # 企业微信适配器实现
│       ├── wecom-formatter.ts   # 企微消息格式化
│       ├── wecom-crypto.ts      # 企微消息加解密
│       └── wecom-token.ts       # access_token 管理
├── agent/
│   ├── types.ts           # Agent 会话接口
│   └── session-manager.ts # 多 Agent 会话管理
├── claude/
│   ├── claude-session.ts  # Claude SDK 会话封装
│   └── plugins.ts         # Claude Code 插件加载
└── codex/
    └── codex-session.ts   # Codex CLI 会话封装
```

## 常用命令

```bash
npm run dev        # 开发模式运行（tsx）
npm run build      # 编译 TypeScript
npm run start      # 运行编译后的代码
npm run typecheck  # 类型检查
```

## 服务管理

生产环境由 launchd 管理（`com.im-to-agent`），日志写入 `logs/stdout.log` 和 `logs/stderr.log`。

**重启服务**（构建后必须用此命令，禁止用 `npm run start` 手动启动）：

```bash
npm run build && launchctl kickstart -k gui/$(id -u)/com.im-to-agent
```

直接 `npm run start` 会产生第二个进程，导致消息被两个进程瓜分、日志不完整。

## 配置

通过项目根目录的 `config.json` 配置，参见 `config.json.example`：

- `imPlatforms` — IM 平台选择，支持 `feishu` / `wecom`
- `projects` — 可访问项目列表
- `feishuBots` — 飞书机器人列表，每个机器人可指定自己的项目子集和 `agent`
- `agent.provider` — 默认 Agent，支持 `claude` / `codex`
- `wecom` — 企业微信应用和回调配置
- `claude` — Claude Code 权限、预算、会话超时等配置
- `codex` — Codex CLI 命令、模型、sandbox、approval policy 等配置
- `logLevel` — 日志级别

### 多飞书机器人配置

通过项目根目录的 `config.json` 配置多个飞书机器人，每个机器人绑定不同的项目子集。
参见 `config.json.example` 模板。`config.json` 是必需配置文件。

## 用户命令

在 IM 中可使用的命令：

- `/projects` — 列出所有可用项目
- `/project <name>` — 切换到指定项目（会重置当前会话）
- `/reset` — 清除对话历史，开始新会话
- `/stop` — 立即中断当前正在处理的任务
- `/help` — 显示帮助信息

## 架构说明

1. **IMAdapter 接口**: 抽象 IM 平台，便于扩展其他平台（如微信、Slack）
2. **Bridge**: 连接 IM 和当前 Agent，处理命令（/reset, /stop, /help）和消息转发
3. **ClaudeSession**: 封装 Claude Agent SDK，支持会话恢复和流式输出
4. **CodexSession**: 封装 Codex CLI，支持非交互执行和尽力恢复会话
5. **AgentSessionManager**: 管理多会话，自动清理超时会话

## 开发注意事项

- 使用 ESM 模块（import 需要 `.js` 后缀）
- Node.js 版本要求 >= 20.0.0
- 飞书适配器使用 WebSocket 长连接接收消息
- 企微适配器使用 HTTP 回调接收消息（需公网可访问地址）
- 企微不支持消息更新，中间进度不发送，仅发送最终结果

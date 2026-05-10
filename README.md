# im-to-agent

通过飞书等 IM 工具与电脑上的 Claude Code / Codex 交互的桥接服务。

在飞书中发消息，即可远程操控本机的 Claude Code 或 Codex 帮你写代码、改 Bug、做重构——无需打开终端。

## 工作原理

```
飞书 ──WebSocket──▶ 桥接服务（本机运行） ──Agent──▶ Claude Code / Codex
                        ◀── 流式卡片更新 ──┘                 │
                                                           读写你的代码
```

桥接服务在你的电脑上运行，通过飞书 WebSocket 长连接接收消息，调用 Claude Agent SDK 或 Codex CLI 执行任务，并将结果以消息卡片的形式实时回传到飞书。

## 前置要求

- Node.js >= 20.0.0
- 飞书开发者账号及自建应用
- Claude Code CLI 已安装并完成认证（使用 Claude 时）
- Codex CLI 已安装并完成认证（使用 Codex 时，`codex` 命令可正常使用）

## 快速开始

### 1. 创建飞书应用

1. 前往 [飞书开放平台](https://open.feishu.cn/) 创建企业自建应用
2. 添加「机器人」能力
3. 在「事件订阅」中添加 `im.message.receive_v1` 事件，并选择 **WebSocket** 接收方式
4. 在「权限管理」中开通以下权限：
   - `im:message` — 获取与发送单聊、群组消息
   - `im:message:send_as_bot` — 以应用的身份发送消息
5. 发布应用版本并通过审核

### 2. 安装与配置

```bash
git clone https://github.com/RogerLuoJian/im-to-agent.git
cd im-to-agent
npm install
```

复制配置模板并填入配置：

```bash
cp config.json.example config.json
```

编辑 `config.json` 文件：

```json
{
  "imPlatforms": ["feishu"],
  "projects": [
    { "name": "myapp", "path": "/Users/yourname/projects/myapp" }
  ],
  "feishuBots": [
    {
      "name": "claude-bot",
      "appId": "cli_xxxxx",
      "appSecret": "xxxxx",
      "agent": "claude",
      "projects": ["myapp"],
      "defaultProject": "myapp"
    }
  ]
}
```

### 3. 启动服务

```bash
# 开发模式
npm run dev

# 或编译后运行
npm run build && npm run start
```

看到类似以下日志即表示启动成功：

```
[INFO] 启动飞书 WebSocket 连接...
[INFO] 飞书 WebSocket 已连接
[INFO] Bridge 已启动，使用 Feishu 适配器
```

### 4. 开始使用

在飞书中找到你的机器人，发送任意消息即可开始与对应 Agent 对话：

- 私聊机器人直接发消息
- 群聊中 @机器人 发消息

## 聊天命令

| 命令 | 说明 |
| --- | --- |
| `/projects` | 列出所有可用项目 |
| `/project <name>` | 切换到指定项目（会重置当前会话） |
| `/reset` | 清除对话历史，开始新会话 |
| `/help` | 显示帮助信息 |

## 配置说明

所有配置通过项目根目录的 `config.json` 设置：

| 字段 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `imPlatforms` | 是 | — | 启用的平台：`feishu` / `wecom` |
| `projects` | 是 | — | 可访问项目列表 |
| `feishuBots` | 启用飞书时是 | — | 飞书机器人列表，每个机器人可指定自己的项目和 Agent |
| `agent.provider` | 否 | `claude` | 默认 Agent：`claude` / `codex` |
| `claude.defaultProject` | 否 | 第一个项目 | 默认项目名 |
| `claude.permissionMode` | 否 | `bypassPermissions` | Claude 权限模式：`default` / `acceptEdits` / `bypassPermissions` |
| `claude.maxBudgetUsd` | 否 | `5` | Claude 单次会话预算上限（美元） |
| `claude.sessionTimeoutMinutes` | 否 | `30` | 会话超时时间（分钟），超时后自动清理 |
| `codex.command` | 否 | `codex` | Codex CLI 命令路径 |
| `codex.model` | 否 | — | Codex 使用的模型 |
| `codex.sandbox` | 否 | `workspace-write` | Codex sandbox：`read-only` / `workspace-write` / `danger-full-access` |
| `codex.approvalPolicy` | 否 | `never` | Codex approval policy |
| `codex.fullAuto` | 否 | `false` | 是否使用 `codex --full-auto` |
| `codex.dangerouslyBypassApprovalsAndSandbox` | 否 | `false` | 是否跳过 Codex approvals 和 sandbox |
| `codex.extraArgs` | 否 | `[]` | 追加传给 `codex exec` 的参数数组 |
| `logLevel` | 否 | `info` | 日志级别：`debug` / `info` / `warn` / `error` |

### 权限模式说明

- **`default`** — 默认模式，工具调用需要手动确认（需要在终端交互，远程场景不适用）
- **`acceptEdits`** — 自动接受文件编辑，其他操作仍需确认
- **`bypassPermissions`** — 跳过所有权限确认（推荐远程使用，请确保在可信环境下运行）

### 多项目配置

通过 `projects` 可以配置多个项目，在聊天中用 `/project` 命令切换。每个飞书机器人可以通过 `feishuBots[].projects` 限定自己能访问的项目。

使用时：

```
你: /projects
Bot: 可用项目:
     → frontend: /Users/me/code/frontend
       backend: /Users/me/code/backend
       docs: /Users/me/code/docs

你: /project backend
Bot: 已切换到项目: backend
```

### 多飞书机器人与 Agent 选择

使用 `config.json` 可以为每个飞书机器人指定不同 Agent：

```json
{
  "projects": [
    { "name": "frontend", "path": "/Users/me/code/frontend" },
    { "name": "backend", "path": "/Users/me/code/backend" }
  ],
  "feishuBots": [
    {
      "name": "claude-bot",
      "appId": "cli_xxxxx",
      "appSecret": "xxxxx",
      "agent": "claude",
      "projects": ["frontend", "backend"],
      "defaultProject": "frontend"
    },
    {
      "name": "codex-bot",
      "appId": "cli_yyyyy",
      "appSecret": "yyyyy",
      "agent": "codex",
      "projects": ["backend"],
      "defaultProject": "backend"
    }
  ]
}
```

群聊里多个机器人可以共存：普通消息和其他 bot 消息会被记录为上下文；只有明确 @ 当前机器人时才会触发该机器人处理。

## 项目结构

```
src/
├── index.ts              # 入口，启动服务
├── config.ts             # config.json 配置加载
├── logger.ts             # 日志工具
├── bridge.ts             # 核心桥接逻辑，处理消息路由
├── im/
│   ├── types.ts          # IM 适配器接口定义
│   └── feishu/
│       ├── feishu-adapter.ts    # 飞书适配器实现
│       └── feishu-formatter.ts  # 消息卡片格式化
├── agent/
│   ├── types.ts           # Agent 会话接口
│   └── session-manager.ts # 多 Agent 会话管理
├── claude/
│   ├── claude-session.ts  # Claude Agent SDK 会话封装
│   └── plugins.ts         # Claude Code 插件加载
└── codex/
    └── codex-session.ts   # Codex CLI 会话封装
```

## 架构设计

- **IMAdapter 接口** — 抽象 IM 平台的消息收发，便于扩展到其他平台（微信、Slack 等）
- **Bridge** — 核心桥接层，连接 IM 和当前 Agent，处理命令路由和并发控制
- **ClaudeSession** — 封装 Claude Agent SDK，支持会话恢复（resume）和流式输出
- **CodexSession** — 封装 Codex CLI，支持非交互执行和尽力恢复会话
- **AgentSessionManager** — 管理多用户会话，自动清理超时会话释放资源

## 注册为系统服务

可以将桥接服务注册为系统服务，实现开机自启和崩溃自动重启。

### macOS（launchd）

```bash
bash scripts/service.sh install     # 安装并启动服务
bash scripts/service.sh status      # 查看服务状态
bash scripts/service.sh logs        # 实时查看日志
bash scripts/service.sh uninstall   # 卸载服务
```

### Windows（计划任务）

以管理员身份打开 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\service.ps1 install     # 安装并启动服务
powershell -ExecutionPolicy Bypass -File scripts\service.ps1 status      # 查看服务状态
powershell -ExecutionPolicy Bypass -File scripts\service.ps1 logs        # 实时查看日志
powershell -ExecutionPolicy Bypass -File scripts\service.ps1 uninstall   # 卸载服务
```

服务日志保存在项目 `logs/` 目录下。

## 开发

```bash
npm run dev        # 开发模式运行（tsx，支持热重载）
npm run build      # 编译 TypeScript
npm run start      # 运行编译后的代码
npm run typecheck  # 类型检查
```

## License

MIT

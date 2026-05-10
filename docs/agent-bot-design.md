# 多 Agent 飞书机器人设计

## 目标

同一个桥接服务可以同时连接多个飞书机器人，并允许每个机器人指定自己的代码 Agent：

- Claude 机器人连接 Claude Code。
- Codex 机器人连接 Codex CLI。
- 多个机器人可以进入同一个群聊，读取同一段群聊上下文，但只有被明确 @ 的机器人会响应。

## 配置模型

`config.json` 中的每个 `feishuBots` 条目可以配置 `agent`：

```json
{
  "projects": [
    { "name": "app", "path": "/Users/me/code/app" }
  ],
  "feishuBots": [
    {
      "name": "claude-bot",
      "appId": "cli_xxx",
      "appSecret": "xxx",
      "agent": "claude",
      "projects": ["app"],
      "defaultProject": "app"
    },
    {
      "name": "codex-bot",
      "appId": "cli_yyy",
      "appSecret": "yyy",
      "agent": "codex",
      "projects": ["app"],
      "defaultProject": "app"
    }
  ]
}
```

兼容规则：

1. `feishuBots[].agent` 优先。
2. 未配置时使用 `agent.provider`。
3. 仍未配置时默认 `claude`。

## 运行机制

Bridge 不直接依赖 Claude 或 Codex，而是依赖统一的 `AgentSession` 接口：

- `sendMessage(prompt)`：发送用户请求并返回流式进度。
- `stop()`：中断当前请求。
- `reset()`：清空当前对话状态。
- `setCwd(path)`：切换项目目录，并重置会话。
- `cwd` / `lastActivity`：供项目展示和空闲清理使用。

`AgentSessionManager` 根据当前机器人的 agent 类型创建对应 session：

- `claude` 使用现有 Claude Agent SDK。
- `codex` 使用 `codex exec --json` 子进程。

## Codex 调用

Codex 默认以非交互方式运行：

```bash
codex exec --json --cd <project-path> --sandbox workspace-write --ask-for-approval never <prompt>
```

可通过 `config.json` 的 `codex` 字段调整：

- `model`
- `sandbox`
- `approvalPolicy`
- `fullAuto`
- `dangerouslyBypassApprovalsAndSandbox`
- `extraArgs`

会话连续性：

- 首次请求使用 `codex exec --json`。
- 如果 JSONL 事件中包含 session id，则后续请求使用 `codex exec resume --json <session-id>`。
- `/reset` 或 `/project` 会清除 session id。
- 如果无法识别 session id，Codex 仍可单轮运行，只是不保留连续上下文。

## 群聊上下文机制

群聊中所有可读文本消息都会进入上下文缓存，但不会都触发 agent：

- 用户普通发言：缓存，不响应。
- 用户 @ 当前机器人：读取最近群聊上下文并触发当前机器人。
- 用户 @ 其他机器人：缓存，不响应。
- 其他机器人消息：缓存，不响应。
- 当前机器人自己发送的消息：默认不缓存，避免重复污染上下文。

发送给 agent 的 prompt 会包含最近群聊上下文，并明确说明：上下文可能包含其他机器人的历史回复，只作为参考；最后一条 @ 当前机器人的用户请求才是本次要执行的指令。

缓存策略：

- 每个群最多保留最近 50 条。
- 消息超过 1 小时自动过期。
- 被 @ 触发后不清空缓存，保持群聊连续性。

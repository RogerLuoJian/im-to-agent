# 企业微信对接设计方案

## 一、概述

在现有 IMAdapter 接口基础上，新增企业微信适配器，实现通过企业微信与 Claude Code 交互。整体架构保持不变，遵循现有的适配器模式。

## 二、企业微信与飞书的关键差异

| 特性 | 飞书 | 企业微信 |
|------|------|----------|
| 消息接收 | WebSocket 长连接 | HTTP 回调（需启动 HTTP Server） |
| 消息格式 | JSON | XML（需加解密） |
| 认证方式 | appId + appSecret | corpId + corpSecret |
| access_token | 自动管理（SDK） | 需手动获取和刷新（2小时过期） |
| 消息发送 | REST API | REST API |
| 富文本消息 | 消息卡片（interactive） | Markdown 消息（仅企微内部应用支持） |
| 消息更新 | 支持 patch 更新已发消息 | **不支持更新已发消息** |

## 三、核心挑战：不支持消息更新

企业微信 **不支持修改已发送的消息**，这与飞书有本质区别。飞书适配器的流式更新（每 3 秒更新同一张卡片）在企微中无法直接复用。

### 解决方案：先发占位消息 + 完成后发送最终结果

1. 收到用户消息后，立即回复一条"正在处理中..."的文本消息
2. Claude 处理期间不发送中间进度（避免消息刷屏）
3. 处理完成后，发送最终结果为一条新的 Markdown 消息
4. 如果处理时间较长（超过配置的阈值），可以每隔较长间隔（如 30 秒）发送一条简短进度提示

> **说明**：Bridge 层已有 `isFinal` 字段区分中间进度和最终结果，企微适配器在 `send()` 中可根据此字段决定行为——中间进度消息可选择不发送或低频发送，仅发送最终结果。

## 四、文件结构

```
src/
├── config.ts              # 修改：新增企微配置，重构为多 IM 支持
├── index.ts               # 修改：根据配置选择启动哪个适配器
├── im/
│   ├── types.ts           # 不变
│   └── feishu/            # 不变
│   └── wecom/
│       ├── wecom-adapter.ts      # 企微适配器实现
│       ├── wecom-formatter.ts    # 企微消息格式化
│       ├── wecom-crypto.ts       # 企微消息加解密
│       └── wecom-token.ts        # access_token 管理
```

## 五、详细设计

### 5.1 配置变更 (`config.ts`)

新增环境变量：

```
# 选择 IM 平台
IM_PLATFORM=wecom          # feishu | wecom

# 企业微信配置
WECOM_CORP_ID=ww...        # 企业 ID
WECOM_CORP_SECRET=...      # 应用 Secret
WECOM_AGENT_ID=1000002     # 应用 AgentId
WECOM_TOKEN=...            # 回调 Token（用于验证回调来源）
WECOM_ENCODING_AES_KEY=... # 回调 EncodingAESKey（用于消息加解密）
WECOM_CALLBACK_PORT=3001   # 回调 HTTP Server 端口
```

Config 接口调整：

```typescript
interface Config {
  imPlatform: 'feishu' | 'wecom';

  feishu: { ... };  // 保持不变

  wecom: {
    corpId: string;
    corpSecret: string;
    agentId: number;
    token: string;
    encodingAesKey: string;
    callbackPort: number;
  };

  claude: { ... };  // 保持不变
  logLevel: ...;
}
```

### 5.2 消息加解密 (`wecom-crypto.ts`)

企业微信回调消息使用 AES 加密，需要实现：

- `decrypt(encryptedMsg: string): string` — 解密回调消息体
- `encrypt(replyMsg: string): string` — 加密回复消息体（被动回复时使用）
- `verifySignature(signature, timestamp, nonce, encrypt): boolean` — 验签

使用 Node.js 内置 `crypto` 模块实现，**无需额外依赖**。

加解密算法：
- AES-256-CBC，key 由 EncodingAESKey Base64 解码得到
- 消息体包含：随机字符串(16B) + 消息长度(4B, network order) + 明文消息 + corpId
- 签名验证：`SHA1(sort([token, timestamp, nonce, encrypt]))`

### 5.3 access_token 管理 (`wecom-token.ts`)

```typescript
class WecomTokenManager {
  private token: string | null;
  private expiresAt: number;

  async getToken(): Promise<string>;   // 获取 token，过期时自动刷新
  private async refresh(): Promise<void>;  // 调用 API 刷新 token
}
```

- 调用 `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=&corpsecret=`
- token 有效期 7200 秒，提前 5 分钟刷新
- 使用内置 `fetch`（Node.js 20+ 原生支持），**无需额外依赖**

### 5.4 企微适配器 (`wecom-adapter.ts`)

```typescript
class WecomAdapter implements IMAdapter {
  readonly name = 'wecom';

  private server: http.Server;
  private tokenManager: WecomTokenManager;
  private crypto: WecomCrypto;

  async start(onMessage: (msg: IncomingMessage) => void): Promise<void>;
  async send(msg: OutgoingMessage): Promise<SendResult>;
  async stop(): Promise<void>;
}
```

#### 消息接收（HTTP 回调）

启动一个轻量 HTTP Server（使用 Node.js 内置 `http` 模块）：

1. **GET 请求**：URL 验证（企微首次配置回调时发送）
   - 解密 `echostr` 参数并返回明文
2. **POST 请求**：接收消息
   - 解析 XML → 解密 → 提取文本内容
   - 构造 `IncomingMessage` 并调用 `onMessage`
   - 立即返回空响应（异步处理消息）

XML 解析使用轻量库 `fast-xml-parser`（唯一新增的外部依赖）。

#### 消息发送

调用企微 API 发送应用消息：

```
POST https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=TOKEN
```

消息类型策略：
- **最终结果 (`isFinal: true`)**：使用 Markdown 类型消息发送完整内容
- **中间进度 (`isFinal: false`)**：
  - 首条进度消息（占位消息）：发送文本"正在处理中..."
  - 后续进度：**不发送**（避免刷屏）

> 注意：企微 Markdown 消息仅在企业微信客户端内支持渲染，微信端查看会降级为纯文本。

#### 消息更新

`updateMessageId` 字段在企微适配器中的处理：
- 由于企微不支持消息更新，当 `updateMessageId` 存在且 `isFinal: false` 时，**跳过发送**
- 当 `isFinal: true` 时，忽略 `updateMessageId`，发送新消息

### 5.5 消息格式化 (`wecom-formatter.ts`)

```typescript
function formatAsMarkdown(content: string, isFinal: boolean): object;
```

- 企微 Markdown 消息有 2048 字节限制
- 超长内容需截断并添加省略提示
- 将 Claude 输出的 Markdown 适配为企微支持的子集（企微 Markdown 支持有限，例如不支持表格）

企微支持的 Markdown 语法：
- 标题（`#` 到 `######`）
- 加粗 `**text**`
- 链接 `[text](url)`
- 行内代码 `` `code` ``
- 引用 `> text`
- 字体颜色 `<font color="info">text</font>`

不支持的需转换/移除：
- 表格 → 转为缩进文本
- 代码块 → 保持（企微实际支持渲染，但未在官方文档中列出）
- 图片 → 移除或转为链接

### 5.6 入口调整 (`index.ts`)

```typescript
function createAdapter(config: Config): IMAdapter {
  switch (config.imPlatform) {
    case 'feishu':
      return new FeishuAdapter(config.feishu);
    case 'wecom':
      return new WecomAdapter(config.wecom);
    default:
      throw new Error(`Unsupported IM platform: ${config.imPlatform}`);
  }
}
```

## 六、新增依赖

| 依赖 | 用途 | 备注 |
|------|------|------|
| `fast-xml-parser` | 解析企微回调的 XML 消息 | 轻量、零依赖、性能好 |

其余功能均使用 Node.js 内置模块：
- `crypto` — 消息加解密
- `http` — 回调 HTTP Server
- `fetch` — 调用企微 API（Node.js 20+ 内置）

## 七、实现步骤

1. **`wecom-crypto.ts`** — 实现消息加解密和签名验证
2. **`wecom-token.ts`** — 实现 access_token 自动管理
3. **`wecom-formatter.ts`** — 实现消息格式化
4. **`wecom-adapter.ts`** — 实现适配器主体
5. **`config.ts`** — 新增企微配置项和 `imPlatform` 选择
6. **`index.ts`** — 适配器工厂逻辑
7. **`.env.example`** — 补充企微相关环境变量说明
8. **测试验证** — typecheck 通过

## 八、后续扩展考虑

- **消息分段发送**：对于超过 2048 字节的长回复，可以拆分为多条消息发送
- **文件发送**：Claude 生成的代码文件可通过企微文件消息类型发送
- **群聊支持**：当前设计支持单聊和群聊（群聊中需 @机器人 触发）
- **被动回复 vs 主动发送**：当前设计采用主动发送模式（需要 access_token），更灵活

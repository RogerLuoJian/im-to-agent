/** 从 IM 平台收到的消息 */
export interface IncomingMessage {
  /** 平台的会话/群组 ID */
  chatId: string;
  /** 平台的消息 ID */
  messageId: string;
  /** 发送者 ID */
  senderId: string;
  /** 纯文本内容 */
  text: string;
  /** 飞书 image_key — 消息为图片时存在 */
  imageKey?: string;
  /** 发言人名称（群聊时标注） */
  senderName?: string;
  /** flush 群聊缓存的回调，Bridge 在确定非命令消息时调用 */
  flushGroupContext?: () => string;
  /** 原始平台事件数据 */
  raw: unknown;
}

/** 发送到 IM 平台的消息 */
export interface OutgoingMessage {
  chatId: string;
  /** 如果设置，更新这条已有消息而非发新消息 */
  updateMessageId?: string;
  /** 消息标题（支持卡片的平台使用） */
  title?: string;
  /** 消息内容（Markdown） */
  content: string;
  /** 是否为最终结果（非中间状态） */
  isFinal: boolean;
}

/** 发送结果 */
export interface SendResult {
  messageId: string;
}

/** IM 平台适配器接口 */
export interface IMAdapter {
  readonly name: string;

  /** 启动监听，收到消息时调用 onMessage */
  start(onMessage: (msg: IncomingMessage) => void): Promise<void>;

  /** 发送或更新消息 */
  send(msg: OutgoingMessage): Promise<SendResult>;

  /** 主动推送消息给指定用户（定时提醒用） */
  sendProactive(openId: string, content: string): Promise<void>;

  /** 优雅停止 */
  stop(): Promise<void>;

  /** 下载消息中的图片，保存到 targetPath */
  downloadImage?(messageId: string, fileKey: string, targetPath: string): Promise<void>;
}

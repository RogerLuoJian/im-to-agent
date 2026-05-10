import * as Lark from '@larksuiteoapi/node-sdk';
import type { IMAdapter, IncomingMessage, OutgoingMessage, SendResult } from '../types.js';
import type { FeishuBotConfig } from '../../config.js';
import { formatAsCard } from './feishu-formatter.js';
import { log } from '../../logger.js';
import { sharedGroupChatBuffer } from './group-chat-buffer.js';
import { UserNameCache } from './user-name-cache.js';

export class FeishuAdapter implements IMAdapter {
  readonly name: string;

  private client: InstanceType<typeof Lark.Client>;
  private wsClient: Lark.WSClient;
  private botOpenId: string = '';
  private groupChatBuffer = sharedGroupChatBuffer;
  private userNameCache: UserNameCache;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: FeishuBotConfig) {
    this.name = `Feishu(${config.name})`;
    this.client = new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
    });

    this.wsClient = new Lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
      domain: Lark.Domain.Feishu,
    });

    this.userNameCache = new UserNameCache(this.client);
  }

  async start(onMessage: (msg: IncomingMessage) => void): Promise<void> {
    log.info('启动飞书 WebSocket 连接...');

    // 获取机器人自身的 open_id
    try {
      const resp: any = await this.client.request({
        method: 'GET',
        url: 'https://open.feishu.cn/open-apis/bot/v3/info/',
      });
      // 响应可能是 { bot: { open_id } } 或 { data: { bot: { open_id } } }
      this.botOpenId = resp?.bot?.open_id || resp?.data?.bot?.open_id || '';
      if (this.botOpenId) {
        log.info('获取机器人 open_id 成功', { botOpenId: this.botOpenId.slice(0, 8) + '...' });
      } else {
        log.warn('获取机器人 open_id 失败，群聊 @检测 可能不工作', { resp: JSON.stringify(resp).slice(0, 200) });
      }
    } catch (err) {
      log.warn('获取机器人信息失败', err);
    }

    // 定期清理长期无活动的群聊缓存
    this.cleanupTimer = setInterval(() => {
      this.groupChatBuffer.cleanupStale();
    }, 5 * 60 * 1000);

    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        try {
          const message = data.message;
          const messageType = message.message_type;

          if (messageType !== 'text' && messageType !== 'image' && messageType !== 'post' && messageType !== 'interactive') {
            log.debug('忽略不支持的消息类型', { type: messageType });
            return;
          }

          const content = JSON.parse(message.content);
          let text = '';
          let imageKey: string | undefined;

          if (messageType === 'text') {
            text = (content.text as string) || '';
            // 去掉 @机器人 的标记
            text = text.replace(/@_user_\d+/g, '').trim();
          } else if (messageType === 'image') {
            imageKey = content.image_key as string;
          } else if (messageType === 'post') {
            // post（富文本）：遍历二维 content 数组，提取文字和第一张图片
            const paragraphs: Array<Array<{ tag: string; text?: string; image_key?: string }>> =
              content.content || [];
            const texts: string[] = [];
            for (const paragraph of paragraphs) {
              for (const el of paragraph) {
                if ((el.tag === 'text' || el.tag === 'a') && el.text) {
                  texts.push(el.text);
                } else if (el.tag === 'img' && el.image_key && !imageKey) {
                  imageKey = el.image_key;
                }
              }
            }
            text = texts.join('').replace(/@_user_\d+/g, '').trim();
            if (content.title) {
              text = `${content.title}\n${text}`;
            }
          } else {
            text = this.extractInteractiveText(content);
          }

          if (!text && !imageKey) return;

          const chatType = message.chat_type; // 'p2p' | 'group'

          if (chatType === 'group') {
            // 群聊：检查是否 @机器人
            const mentions: Array<{ key: string; id: { open_id?: string }; name: string }> | undefined =
              message.mentions;
            const isMentioned = this.botOpenId
              ? mentions?.some((m) => m.id?.open_id === this.botOpenId)
              : false;

            const senderId = data.sender?.sender_id?.open_id || data.sender?.sender_id?.app_id || 'unknown';
            const rawSenderType = String(data.sender?.sender_type || data.sender?.sender_id?.user_id_type || '');
            const senderType = rawSenderType === 'app' || rawSenderType === 'bot'
              ? 'bot'
              : 'user';
            const senderAppId = data.sender?.sender_id?.app_id;
            const isSelfMessage =
              (!!this.botOpenId && senderId === this.botOpenId) ||
              (!!senderAppId && senderAppId === this.config.appId);
            const senderName = await this.userNameCache.getName(senderId);

            if (isSelfMessage) {
              log.debug('忽略当前机器人自己的群聊消息', { chatId: message.chat_id });
              return;
            }

            if (!isMentioned || senderType === 'bot') {
              // 未 @ 当前机器人，或其他机器人消息：只缓存，不响应
              if (text) {
                this.groupChatBuffer.push(message.chat_id, {
                  senderName,
                  senderType,
                  text,
                  timestamp: Date.now(),
                });
                log.debug('群聊消息已缓存', { chatId: message.chat_id, senderName, senderType });
              }
              return;
            }

            // 已 @：调 onMessage，携带 flushGroupContext 闭包
            log.info('收到群聊 @机器人 消息', {
              chatId: message.chat_id,
              senderName,
              text: text.slice(0, 100),
              hasImage: !!imageKey,
            });

            onMessage({
              chatId: message.chat_id,
              messageId: message.message_id,
              senderId,
              text,
              imageKey,
              senderName,
              flushGroupContext: () => this.groupChatBuffer.flush(message.chat_id),
              raw: data,
            });
          } else {
            // 私聊：保持现有行为
            log.info('收到飞书消息', {
              chatId: message.chat_id,
              type: messageType,
              text: text.slice(0, 100),
              hasImage: !!imageKey,
            });

            onMessage({
              chatId: message.chat_id,
              messageId: message.message_id,
              senderId: data.sender?.sender_id?.open_id || 'unknown',
              text,
              imageKey,
              raw: data,
            });
          }
        } catch (err) {
          log.error('处理飞书消息出错', err);
        }
      },
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    log.info('飞书 WebSocket 已连接');
  }

  async send(msg: OutgoingMessage): Promise<SendResult> {
    try {
      if (msg.updateMessageId) {
        // 更新已有的消息卡片
        await this.client.im.message.patch({
          data: {
            content: formatAsCard(msg.content, { title: msg.title, isFinal: msg.isFinal }),
          },
          path: {
            message_id: msg.updateMessageId,
          },
        });
        this.cacheOutgoingBotMessage(msg);
        return { messageId: msg.updateMessageId };
      } else {
        // 发送新消息
        const resp = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: msg.chatId,
            content: formatAsCard(msg.content, { title: msg.title, isFinal: msg.isFinal }),
            msg_type: 'interactive',
          },
        });
        const messageId = resp?.data?.message_id || '';
        this.cacheOutgoingBotMessage(msg);
        return { messageId };
      }
    } catch (err) {
      log.error('发送飞书消息失败', err);
      throw err;
    }
  }

  async sendProactive(openId: string, content: string): Promise<void> {
    if (!openId) {
      log.warn('sendProactive: ownerOpenId 未配置，跳过推送');
      return;
    }
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          content: formatAsCard(content, { isFinal: true }),
          msg_type: 'interactive',
        },
      });
      log.info('主动推送消息成功', { openId: openId.slice(0, 8) + '...' });
    } catch (err) {
      log.error('主动推送消息失败', err);
      throw err;
    }
  }

  async downloadImage(messageId: string, fileKey: string, targetPath: string): Promise<void> {
    log.debug('下载飞书图片', { messageId, fileKey });
    const resp = await this.client.im.messageResource.get({
      params: { type: 'image' },
      path: { message_id: messageId, file_key: fileKey },
    });
    await resp.writeFile(targetPath);
    log.debug('飞书图片已保存', { targetPath });
  }

  private cacheOutgoingBotMessage(msg: OutgoingMessage): void {
    if (!msg.isFinal || !msg.content.trim()) return;
    this.groupChatBuffer.push(msg.chatId, {
      senderName: this.config.name,
      senderType: 'bot',
      text: msg.content,
      timestamp: Date.now(),
    });
    log.debug('机器人回复已写入群聊共享缓存', {
      chatId: msg.chatId,
      botName: this.config.name,
    });
  }

  private extractInteractiveText(content: unknown): string {
    const parts: string[] = [];
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const obj = value as Record<string, unknown>;
      for (const key of ['content', 'text', 'title']) {
        const raw = obj[key];
        if (typeof raw === 'string' && raw.trim()) {
          parts.push(raw.trim());
        } else {
          visit(raw);
        }
      }
      for (const nested of Object.values(obj)) {
        visit(nested);
      }
    };

    visit(content);
    return [...new Set(parts)].join('\n').trim();
  }

  async stop(): Promise<void> {
    log.info('飞书适配器停止');
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.wsClient.close();
  }
}

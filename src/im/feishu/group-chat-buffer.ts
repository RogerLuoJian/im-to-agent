import { log } from '../../logger.js';

export interface BufferedMessage {
  senderName: string;
  senderType: 'user' | 'bot' | 'unknown';
  text: string;
  timestamp: number;
}

const MAX_MESSAGES = 50;
const MAX_AGE_MS = 60 * 60 * 1000; // 1 小时

export class GroupChatBuffer {
  private buffers = new Map<string, BufferedMessage[]>();

  push(chatId: string, msg: BufferedMessage): void {
    let msgs = this.buffers.get(chatId);
    if (!msgs) {
      msgs = [];
      this.buffers.set(chatId, msgs);
    }

    // 清理过期消息
    const cutoff = Date.now() - MAX_AGE_MS;
    const filtered = msgs.filter((m) => m.timestamp > cutoff);

    filtered.push(msg);

    // 超出条数上限，丢弃最旧的
    if (filtered.length > MAX_MESSAGES) {
      filtered.splice(0, filtered.length - MAX_MESSAGES);
    }

    this.buffers.set(chatId, filtered);
  }

  snapshot(chatId: string): string {
    const msgs = this.buffers.get(chatId);

    if (!msgs || msgs.length === 0) return '';

    // 清理过期消息
    const cutoff = Date.now() - MAX_AGE_MS;
    const valid = msgs.filter((m) => m.timestamp > cutoff);
    if (valid.length === 0) return '';

    const lines = valid.map((m) => {
      const date = new Date(m.timestamp);
      const hh = String(date.getHours()).padStart(2, '0');
      const mm = String(date.getMinutes()).padStart(2, '0');
      const typeLabel = m.senderType === 'bot' ? '机器人' : '用户';
      return `[${hh}:${mm}] ${m.senderName}（${typeLabel}）: ${m.text}`;
    });

    return [
      '[群聊上下文 - 最近消息记录]',
      '注意：上下文中可能包含其他机器人的历史回复，仅作为参考；请优先执行最后一条被 @ 的用户请求。',
      lines.join('\n'),
    ].join('\n');
  }

  flush(chatId: string): string {
    return this.snapshot(chatId);
  }

  cleanupStale(maxIdleMs: number = 2 * 60 * 60 * 1000): void {
    const cutoff = Date.now() - maxIdleMs;
    for (const [chatId, msgs] of this.buffers) {
      if (msgs.length === 0 || msgs[msgs.length - 1].timestamp < cutoff) {
        this.buffers.delete(chatId);
        log.debug('清理群聊缓存', { chatId });
      }
    }
  }
}

export const sharedGroupChatBuffer = new GroupChatBuffer();

import http from 'node:http';
import { URL } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import type { IMAdapter, IncomingMessage, OutgoingMessage, SendResult } from '../types.js';
import type { Config } from '../../config.js';
import { WecomCrypto } from './wecom-crypto.js';
import { WecomTokenManager } from './wecom-token.js';
import { formatAsMarkdown, formatAsText } from './wecom-formatter.js';
import { log } from '../../logger.js';

/**
 * 企业微信适配器
 *
 * - 通过 HTTP 回调接收消息（需要公网可访问的地址）
 * - 通过 REST API 主动发送消息
 * - 不支持消息更新，中间进度消息会被跳过，仅发送最终结果
 */
export class WecomAdapter implements IMAdapter {
  readonly name = 'WeCom';

  private server: http.Server | null = null;
  private crypto: WecomCrypto;
  private tokenManager: WecomTokenManager;
  private xmlParser: XMLParser;
  private readonly agentId: number;
  private readonly port: number;

  /** 记录每个 chat 是否已发送过占位消息，避免重复发送 */
  private placeholderSent = new Set<string>();

  constructor(private readonly config: Config['wecom']) {
    this.crypto = new WecomCrypto(config.token, config.encodingAesKey, config.corpId);
    this.tokenManager = new WecomTokenManager(config.corpId, config.corpSecret);
    this.xmlParser = new XMLParser();
    this.agentId = config.agentId;
    this.port = config.callbackPort;
  }

  async start(onMessage: (msg: IncomingMessage) => void): Promise<void> {
    log.info('启动企微 HTTP 回调服务器...');

    this.server = http.createServer((req, res) => {
      if (req.method === 'GET') {
        this.handleVerification(req, res);
      } else if (req.method === 'POST') {
        this.handleCallback(req, res, onMessage);
      } else {
        res.writeHead(405);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, () => {
        log.info(`企微回调服务器已启动，端口: ${this.port}`);
        resolve();
      });
    });
  }

  async send(msg: OutgoingMessage): Promise<SendResult> {
    // 企微不支持消息更新
    // 当 updateMessageId 存在且不是最终结果时，跳过发送（避免刷屏）
    if (msg.updateMessageId && !msg.isFinal) {
      log.debug('企微跳过中间进度消息', { chatId: msg.chatId });
      return { messageId: msg.updateMessageId };
    }

    // 首条非最终消息：发送占位文本
    if (!msg.isFinal && !msg.updateMessageId) {
      this.placeholderSent.add(msg.chatId);
      return this.sendMessage(msg.chatId, formatAsText('收到，正在处理...'));
    }

    // 最终结果：发送 Markdown 消息
    this.placeholderSent.delete(msg.chatId);
    const body = formatAsMarkdown(msg.content, { isFinal: true });
    return this.sendMessage(msg.chatId, body);
  }

  async sendProactive(openId: string, content: string): Promise<void> {
    log.warn('WecomAdapter.sendProactive 暂未实现', { openId, contentLen: content.length });
  }

  async stop(): Promise<void> {
    log.info('企微适配器停止');
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((err) => (err ? reject(err) : resolve()));
      });
      this.server = null;
    }
  }

  // ─── 内部方法 ───────────────────────────────────────

  /** 处理 URL 验证（GET 请求，企微首次配置回调时发送） */
  private handleVerification(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      const url = new URL(req.url || '/', `http://localhost:${this.port}`);
      const msgSignature = url.searchParams.get('msg_signature') || '';
      const timestamp = url.searchParams.get('timestamp') || '';
      const nonce = url.searchParams.get('nonce') || '';
      const echostr = url.searchParams.get('echostr') || '';

      if (!this.crypto.verifySignature(msgSignature, timestamp, nonce, echostr)) {
        log.warn('URL 验证签名失败');
        res.writeHead(403);
        res.end('signature mismatch');
        return;
      }

      const decrypted = this.crypto.decrypt(echostr);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(decrypted);
      log.info('URL 验证成功');
    } catch (err) {
      log.error('URL 验证出错', err);
      res.writeHead(500);
      res.end('error');
    }
  }

  /** 处理消息回调（POST 请求） */
  private handleCallback(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    onMessage: (msg: IncomingMessage) => void,
  ): void {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      // 必须立即返回空响应，否则企微会重试
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('success');

      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        const url = new URL(req.url || '/', `http://localhost:${this.port}`);
        const msgSignature = url.searchParams.get('msg_signature') || '';
        const timestamp = url.searchParams.get('timestamp') || '';
        const nonce = url.searchParams.get('nonce') || '';

        // 解析外层 XML
        const outerXml = this.xmlParser.parse(body);
        const encrypt = outerXml?.xml?.Encrypt;
        if (!encrypt) {
          log.warn('回调消息缺少 Encrypt 字段');
          return;
        }

        // 验签
        if (!this.crypto.verifySignature(msgSignature, timestamp, nonce, encrypt)) {
          log.warn('回调消息签名验证失败');
          return;
        }

        // 解密
        const decryptedXml = this.crypto.decrypt(encrypt);
        const msgXml = this.xmlParser.parse(decryptedXml);
        const msgData = msgXml?.xml;

        if (!msgData) {
          log.warn('解密后消息解析失败');
          return;
        }

        const msgType = msgData.MsgType;
        if (msgType !== 'text') {
          log.debug('忽略非文本消息', { type: msgType });
          return;
        }

        const text = String(msgData.Content || '').trim();
        if (!text) return;

        const chatId = String(msgData.FromUserName);
        const messageId = String(msgData.MsgId);

        log.info('收到企微消息', { chatId, text: text.slice(0, 100) });

        onMessage({
          chatId,
          messageId,
          senderId: chatId, // 企微单聊中发送者即 chatId
          text,
          raw: msgData,
        });
      } catch (err) {
        log.error('处理企微回调消息出错', err);
      }
    });
  }

  /** 调用企微 API 发送应用消息 */
  private async sendMessage(userId: string, body: object): Promise<SendResult> {
    const token = await this.tokenManager.getToken();
    const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;

    const payload = {
      touser: userId,
      agentid: this.agentId,
      ...body,
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      throw new Error(`发送企微消息失败: HTTP ${resp.status}`);
    }

    const data = (await resp.json()) as {
      errcode: number;
      errmsg: string;
      msgid?: string;
    };

    if (data.errcode !== 0) {
      throw new Error(`发送企微消息失败: ${data.errcode} ${data.errmsg}`);
    }

    const messageId = String(data.msgid || '');
    log.debug('企微消息已发送', { userId, messageId });
    return { messageId };
  }
}

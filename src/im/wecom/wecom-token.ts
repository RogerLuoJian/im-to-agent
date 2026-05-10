import { log } from '../../logger.js';

/**
 * 企业微信 access_token 管理
 *
 * access_token 有效期 7200 秒，此类自动在过期前刷新。
 * API 文档: https://developer.work.weixin.qq.com/document/path/91039
 */
export class WecomTokenManager {
  private token: string | null = null;
  private expiresAt = 0;

  constructor(
    private readonly corpId: string,
    private readonly corpSecret: string,
  ) {}

  /** 获取有效的 access_token，过期时自动刷新 */
  async getToken(): Promise<string> {
    // 提前 5 分钟刷新
    if (this.token && Date.now() < this.expiresAt - 5 * 60 * 1000) {
      return this.token;
    }
    await this.refresh();
    return this.token!;
  }

  private async refresh(): Promise<void> {
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(this.corpId)}&corpsecret=${encodeURIComponent(this.corpSecret)}`;

    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`获取 access_token 失败: HTTP ${resp.status}`);
    }

    const data = (await resp.json()) as {
      errcode: number;
      errmsg: string;
      access_token?: string;
      expires_in?: number;
    };

    if (data.errcode !== 0 || !data.access_token) {
      throw new Error(`获取 access_token 失败: ${data.errcode} ${data.errmsg}`);
    }

    this.token = data.access_token;
    this.expiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;
    log.info('企微 access_token 已刷新', { expiresIn: data.expires_in });
  }
}

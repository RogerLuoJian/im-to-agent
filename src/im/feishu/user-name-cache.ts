import * as Lark from '@larksuiteoapi/node-sdk';
import { log } from '../../logger.js';

export class UserNameCache {
  private cache = new Map<string, string>();

  constructor(private readonly client: InstanceType<typeof Lark.Client>) {}

  async getName(openId: string): Promise<string> {
    const cached = this.cache.get(openId);
    if (cached) return cached;

    try {
      const resp = await this.client.contact.user.get({
        params: { user_id_type: 'open_id' },
        path: { user_id: openId },
      });
      const name = resp?.data?.user?.name;
      if (name) {
        this.cache.set(openId, name);
        return name;
      }
    } catch (err) {
      log.warn('获取飞书用户名失败，降级使用 openId', { openId: openId.slice(0, 8), err });
    }

    // 降级：使用 openId 前 8 位
    const fallback = openId.slice(0, 8) + '...';
    this.cache.set(openId, fallback);
    return fallback;
  }
}

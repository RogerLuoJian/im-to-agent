import crypto from 'node:crypto';

/**
 * 企业微信消息加解密工具
 *
 * 实现参考: https://developer.work.weixin.qq.com/document/path/90968
 * 加密方案: AES-256-CBC, key = Base64Decode(EncodingAESKey + "=")
 * 消息体: random(16B) + msgLen(4B, network order) + msg + corpId
 */
export class WecomCrypto {
  private readonly key: Buffer;
  private readonly iv: Buffer;

  constructor(
    private readonly token: string,
    private readonly encodingAesKey: string,
    private readonly corpId: string,
  ) {
    // EncodingAESKey 固定 43 个字符，Base64 解码后得到 32 字节 AES key
    this.key = Buffer.from(encodingAesKey + '=', 'base64');
    this.iv = this.key.subarray(0, 16);
  }

  /** 验证回调签名 */
  verifySignature(signature: string, timestamp: string, nonce: string, encrypt: string): boolean {
    const computed = this.computeSignature(timestamp, nonce, encrypt);
    return computed === signature;
  }

  /** 计算签名: SHA1(sort([token, timestamp, nonce, encrypt])) */
  computeSignature(timestamp: string, nonce: string, encrypt: string): string {
    const items = [this.token, timestamp, nonce, encrypt].sort();
    return crypto.createHash('sha1').update(items.join('')).digest('hex');
  }

  /** 解密消息 */
  decrypt(encrypted: string): string {
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.key, this.iv);
    decipher.setAutoPadding(false);

    const decrypted = Buffer.concat([
      decipher.update(encrypted, 'base64'),
      decipher.final(),
    ]);

    // 去除 PKCS#7 padding
    const pad = decrypted[decrypted.length - 1];
    const content = decrypted.subarray(0, decrypted.length - pad);

    // 消息体结构: random(16B) + msgLen(4B) + msg + corpId
    const msgLen = content.readUInt32BE(16);
    const msg = content.subarray(20, 20 + msgLen).toString('utf-8');

    // 验证 corpId
    const extractedCorpId = content.subarray(20 + msgLen).toString('utf-8');
    if (extractedCorpId !== this.corpId) {
      throw new Error(`corpId 不匹配: 预期 ${this.corpId}，实际 ${extractedCorpId}`);
    }

    return msg;
  }

  /** 加密消息 */
  encrypt(msg: string): string {
    const random = crypto.randomBytes(16);
    const msgBuf = Buffer.from(msg, 'utf-8');
    const corpIdBuf = Buffer.from(this.corpId, 'utf-8');

    // 消息长度（4 字节，网络字节序）
    const msgLenBuf = Buffer.alloc(4);
    msgLenBuf.writeUInt32BE(msgBuf.length, 0);

    const plaintext = Buffer.concat([random, msgLenBuf, msgBuf, corpIdBuf]);

    // PKCS#7 padding
    const blockSize = 32;
    const padLen = blockSize - (plaintext.length % blockSize);
    const padding = Buffer.alloc(padLen, padLen);
    const padded = Buffer.concat([plaintext, padding]);

    const cipher = crypto.createCipheriv('aes-256-cbc', this.key, this.iv);
    cipher.setAutoPadding(false);

    return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
  }

  /** 生成加密后的回复 XML */
  encryptReplyXml(replyMsg: string, timestamp: string, nonce: string): string {
    const encrypted = this.encrypt(replyMsg);
    const signature = this.computeSignature(timestamp, nonce, encrypted);

    return [
      '<xml>',
      `<Encrypt><![CDATA[${encrypted}]]></Encrypt>`,
      `<MsgSignature><![CDATA[${signature}]]></MsgSignature>`,
      `<TimeStamp>${timestamp}</TimeStamp>`,
      `<Nonce><![CDATA[${nonce}]]></Nonce>`,
      '</xml>',
    ].join('\n');
  }
}

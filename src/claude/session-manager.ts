import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ClaudeSession } from './claude-session.js';
import type { Config } from '../config.js';
import { log } from '../logger.js';

export class SessionManager {
  private sessions = new Map<string, ClaudeSession>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: Config['claude']) {}

  start() {
    const timeoutMs = this.config.sessionTimeoutMinutes * 60 * 1000;
    this.cleanupInterval = setInterval(() => {
      // sessionTimeoutMinutes=0 表示永不自动清理
      if (timeoutMs > 0) {
        const now = Date.now();
        for (const [chatId, session] of this.sessions) {
          if (now - session.lastActivity > timeoutMs) {
            log.info(`清理空闲会话: ${chatId}`);
            session.reset();
            this.sessions.delete(chatId);
          }
        }
      }
      // 清理过期临时图片（超过 1 小时）
      this.cleanupTempFiles().catch((err) => log.error('清理临时文件失败', err));
    }, 60_000);
  }

  /** 清理所有项目目录下过期的 .claude-tmp 文件（超过 1 小时） */
  private async cleanupTempFiles() {
    const maxAge = 60 * 60 * 1000; // 1 小时
    const now = Date.now();
    const cwds = new Set(this.config.projects.map((p) => p.path));

    for (const cwd of cwds) {
      const tmpDir = path.join(cwd, '.claude-tmp');
      try {
        const files = await readdir(tmpDir);
        for (const file of files) {
          const filePath = path.join(tmpDir, file);
          try {
            const s = await stat(filePath);
            if (now - s.mtimeMs > maxAge) {
              await unlink(filePath);
              log.debug('清理过期临时文件', { filePath });
            }
          } catch { /* ignore individual file errors */ }
        }
      } catch { /* tmpDir doesn't exist, skip */ }
    }
  }

  get(chatId: string): ClaudeSession | undefined {
    return this.sessions.get(chatId);
  }

  getOrCreate(chatId: string): ClaudeSession {
    let session = this.sessions.get(chatId);
    if (!session) {
      log.info(`创建新 Claude 会话: ${chatId}`);
      session = new ClaudeSession(chatId, this.config);
      this.sessions.set(chatId, session);
    }
    return session;
  }

  reset(chatId: string) {
    const session = this.sessions.get(chatId);
    if (session) {
      session.reset();
      this.sessions.delete(chatId);
    }
  }

  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    for (const [, session] of this.sessions) {
      session.reset();
    }
    this.sessions.clear();
  }
}

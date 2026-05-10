import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ClaudeSession } from '../claude/claude-session.js';
import { CodexSession } from '../codex/codex-session.js';
import type { Config } from '../config.js';
import { log } from '../logger.js';
import type { AgentSession } from './types.js';

export interface AgentSessionManagerConfig {
  provider: Config['agent']['provider'];
  claude: Config['claude'];
  codex: Config['codex'];
}

export class AgentSessionManager {
  private sessions = new Map<string, AgentSession>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: AgentSessionManagerConfig) {}

  start() {
    const timeoutMs = this.config.claude.sessionTimeoutMinutes * 60 * 1000;
    this.cleanupInterval = setInterval(() => {
      if (timeoutMs > 0) {
        const now = Date.now();
        for (const [chatId, session] of this.sessions) {
          if (now - session.lastActivity > timeoutMs) {
            log.info(`清理空闲 ${this.config.provider} 会话: ${chatId}`);
            session.reset();
            this.sessions.delete(chatId);
          }
        }
      }
      this.cleanupTempFiles().catch((err) => log.error('清理临时文件失败', err));
    }, 60_000);
  }

  /** 清理所有项目目录下过期的临时图片（超过 1 小时） */
  private async cleanupTempFiles() {
    const maxAge = 60 * 60 * 1000;
    const now = Date.now();
    const cwds = new Set(this.config.claude.projects.map((p) => p.path));

    for (const cwd of cwds) {
      const tmpDir = path.join(cwd, '.agent-tmp');
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

  get(chatId: string): AgentSession | undefined {
    return this.sessions.get(chatId);
  }

  getOrCreate(chatId: string): AgentSession {
    let session = this.sessions.get(chatId);
    if (!session) {
      log.info(`创建新 ${this.config.provider} 会话: ${chatId}`);
      session = this.createSession(chatId);
      this.sessions.set(chatId, session);
    }
    return session;
  }

  private createSession(chatId: string): AgentSession {
    if (this.config.provider === 'codex') {
      return new CodexSession(chatId, this.config.claude, this.config.codex);
    }
    return new ClaudeSession(chatId, this.config.claude);
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


import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Config } from '../config.js';
import { log } from '../logger.js';
import type { AgentSession, QueryProgress } from '../agent/types.js';

type JsonObject = Record<string, unknown>;

export class CodexSession implements AgentSession {
  private sessionId: string | null = null;
  private _lastActivityAt: number = Date.now();
  private _cwd: string;
  private currentProcess: ChildProcess | null = null;

  constructor(
    private readonly chatId: string,
    private readonly projectConfig: Config['claude'],
    private readonly codexConfig: Config['codex'],
  ) {
    const defaultProject = projectConfig.projects.find((p) => p.name === projectConfig.defaultProject);
    this._cwd = defaultProject?.path || projectConfig.projects[0]?.path || process.cwd();
  }

  get cwd(): string {
    return this._cwd;
  }

  get lastActivity(): number {
    return this._lastActivityAt;
  }

  setCwd(cwd: string) {
    if (this._cwd !== cwd) {
      this._cwd = cwd;
      this.reset();
      log.info('Codex 会话切换目录', { chatId: this.chatId, cwd });
    }
  }

  async *sendMessage(prompt: string): AsyncGenerator<QueryProgress> {
    this._lastActivityAt = Date.now();

    const commandError = this.validateCommand();
    if (commandError) {
      yield { text: `[错误] ${commandError}`, done: true };
      return;
    }

    const args = this.buildArgs(prompt);
    log.debug('启动 Codex', { chatId: this.chatId, args: args.filter((a) => a !== prompt) });

    const child = spawn(this.codexConfig.command, args, {
      cwd: this._cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.currentProcess = child;

    let fullText = '';
    let stderr = '';
    let spawnErrorMessage = '';
    const rawStdoutLines: string[] = [];
    const stdout = createInterface({ input: child.stdout });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    try {
      const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('error', (err) => {
          spawnErrorMessage = err.message;
          resolve({ code: null, signal: null });
        });
        child.once('close', (code, signal) => resolve({ code, signal }));
      });

      for await (const line of stdout) {
        if (!line.trim()) continue;
        rawStdoutLines.push(line);

        const parsed = this.parseJsonLine(line);
        if (!parsed) {
          continue;
        }

        const nextSessionId = this.extractSessionId(parsed);
        if (nextSessionId && !this.sessionId) {
          this.sessionId = nextSessionId;
          log.debug('Codex 会话已创建', { sessionId: this.sessionId, chatId: this.chatId });
        }

        const delta = this.extractDelta(parsed);
        const text = delta ? fullText + delta : this.extractText(parsed);
        if (text && text !== fullText) {
          fullText = text;
          yield { text: fullText, done: false };
        }
      }

      const { code, signal } = await closePromise;

      if (spawnErrorMessage) {
        yield { text: `[错误] 无法启动 Codex: ${spawnErrorMessage}`, done: true };
        return;
      }

      if (code && code !== 0) {
        const details = stderr.trim() || `Codex 退出码: ${code}${signal ? ` (${signal})` : ''}`;
        yield { text: `[错误] ${details}`, done: true };
        return;
      }

      if (!fullText) {
        fullText = this.extractFallbackText(rawStdoutLines) || 'Codex 已完成。';
      }
      yield { text: fullText, done: true };
    } catch (err) {
      log.error('Codex 查询出错', err);
      yield { text: `[错误] ${err instanceof Error ? err.message : String(err)}`, done: true };
    } finally {
      stdout.close();
      this.currentProcess = null;
      this._lastActivityAt = Date.now();
    }
  }

  async stop(): Promise<boolean> {
    if (!this.currentProcess) return false;
    this.currentProcess.kill('SIGINT');
    setTimeout(() => {
      if (this.currentProcess && !this.currentProcess.killed) {
        this.currentProcess.kill('SIGTERM');
      }
    }, 2_000);
    log.info('Codex 查询已中断', { chatId: this.chatId });
    return true;
  }

  reset() {
    this.sessionId = null;
    log.info('Codex 会话已重置', { chatId: this.chatId });
  }

  private buildArgs(prompt: string): string[] {
    const args: string[] = ['exec'];

    if (this.sessionId) {
      args.push('resume', '--json');
      this.appendCodexCommonArgs(args, { includeWorkspace: false });
      args.push(this.sessionId, prompt);
      return args;
    }

    args.push('--json', '--cd', this._cwd, '--skip-git-repo-check');
    this.appendCodexCommonArgs(args, { includeWorkspace: true });
    args.push(prompt);
    return args;
  }

  private validateCommand(): string | null {
    const command = this.codexConfig.command.trim();
    if (!command) {
      return 'codex.command 为空，请在 config.json 中配置 Codex 可执行文件';
    }

    if ((command.startsWith('/') || command.startsWith('.')) && !existsSync(command)) {
      return `Codex 可执行文件不存在: ${command}`;
    }

    return null;
  }

  private appendCodexCommonArgs(args: string[], options: { includeWorkspace: boolean }) {
    if (this.codexConfig.model) {
      args.push('--model', this.codexConfig.model);
    }

    if (this.codexConfig.dangerouslyBypassApprovalsAndSandbox) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (this.codexConfig.fullAuto) {
      args.push('--full-auto');
    } else if (options.includeWorkspace) {
      args.push('--sandbox', this.codexConfig.sandbox);
    }

    args.push(...this.codexConfig.extraArgs);
  }

  private parseJsonLine(line: string): JsonObject | null {
    try {
      const parsed = JSON.parse(line) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : null;
    } catch {
      return null;
    }
  }

  private extractSessionId(event: JsonObject): string | null {
    const keys = ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'threadId'];
    for (const key of keys) {
      const value = this.findStringByKey(event, key);
      if (value) return value;
    }
    return null;
  }

  private extractText(event: JsonObject): string {
    const eventType = String(event.type || event.event || '');
    const textKeys = ['message', 'text', 'content', 'final_response', 'last_message'];
    const parts: string[] = [];

    for (const key of textKeys) {
      const value = this.findStringByKey(event, key);
      if (value) parts.push(value);
    }

    const text = parts.find((part) => part.trim().length > 0) || '';
    if (!text) return '';

    if (eventType.includes('stderr') || eventType.includes('error')) {
      return '';
    }

    return text;
  }

  private extractDelta(event: JsonObject): string {
    const eventType = String(event.type || event.event || '');
    if (eventType.includes('stderr') || eventType.includes('error')) {
      return '';
    }
    return this.findStringByKey(event, 'delta') || '';
  }

  private findStringByKey(value: unknown, key: string): string | null {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.findStringByKey(item, key);
        if (found) return found;
      }
      return null;
    }

    const obj = value as JsonObject;
    const direct = obj[key];
    if (typeof direct === 'string' && direct.trim()) {
      return direct;
    }

    for (const nested of Object.values(obj)) {
      const found = this.findStringByKey(nested, key);
      if (found) return found;
    }
    return null;
  }

  private extractFallbackText(lines: string[]): string {
    const textParts = lines
      .map((line) => this.parseJsonLine(line))
      .filter((item): item is JsonObject => !!item)
      .map((item) => this.extractText(item))
      .filter(Boolean);

    return textParts[textParts.length - 1] || '';
  }
}

import { query, type Query, type SDKAssistantMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from '../config.js';
import { log } from '../logger.js';
import { loadInstalledPlugins, type PluginConfig } from './plugins.js';
import type { AgentSession, QueryProgress } from '../agent/types.js';

export class ClaudeSession implements AgentSession {
  private sessionId: string | null = null;
  private _lastActivityAt: number = Date.now();
  private _cwd: string;
  private plugins: PluginConfig[] | null = null;
  private currentQuery: Query | null = null;

  constructor(
    private readonly chatId: string,
    private readonly config: Config['claude'],
  ) {
    // 使用默认项目的路径
    const defaultProject = config.projects.find((p) => p.name === config.defaultProject);
    this._cwd = defaultProject?.path || config.projects[0]?.path || process.cwd();
  }

  /** 加载用户已安装的插件 */
  private async ensurePluginsLoaded(): Promise<PluginConfig[]> {
    if (this.plugins === null) {
      this.plugins = await loadInstalledPlugins();
    }
    return this.plugins;
  }

  get cwd(): string {
    return this._cwd;
  }

  /** 切换工作目录（会重置会话） */
  setCwd(cwd: string) {
    if (this._cwd !== cwd) {
      this._cwd = cwd;
      this.reset();
      log.info('Claude 会话切换目录', { chatId: this.chatId, cwd });
    }
  }

  get lastActivity(): number { return this._lastActivityAt; }

  /**
   * 发送消息并以异步生成器方式返回流式进度
   */
  async *sendMessage(prompt: string): AsyncGenerator<QueryProgress> {
    this._lastActivityAt = Date.now();

    // 加载用户已安装的插件
    const plugins = await this.ensurePluginsLoaded();

    const options: Parameters<typeof query>[0]['options'] = {
      cwd: this._cwd,
      permissionMode: this.config.permissionMode,
      allowDangerouslySkipPermissions: this.config.permissionMode === 'bypassPermissions',
      maxBudgetUsd: this.config.maxBudgetUsd,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project'],
      plugins: plugins.length > 0 ? plugins : undefined,
    };

    // 如果已有 session，使用 resume 继续对话
    if (this.sessionId) {
      options.resume = this.sessionId;
    }

    const q = query({ prompt, options });
    this.currentQuery = q;

    let fullText = '';

    try {
      for await (const msg of q) {
        // 记录 session_id 用于后续 resume
        if (!this.sessionId && msg.session_id) {
          this.sessionId = msg.session_id;
          log.debug('Claude 会话已创建', { sessionId: this.sessionId, chatId: this.chatId });
        }

        if (msg.type === 'assistant') {
          const assistantMsg = msg as SDKAssistantMessage;
          const content = assistantMsg.message.content as Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;

          const newText = content
            .filter((block) => block.type === 'text' && block.text)
            .map((block) => block.text!)
            .join('');
          if (newText && newText !== fullText) {
            fullText = newText;
            yield { text: fullText, done: false };
          }

          // 检测 AskUserQuestion 工具调用，把问题内容转发给用户
          const askBlock = content.find((block) => block.type === 'tool_use' && block.name === 'AskUserQuestion');
          if (askBlock?.input) {
            const question = String(askBlock.input['question'] ?? '');
            const options = askBlock.input['options'];
            let questionText = `Claude Code 需要您回答：\n${question}`;
            if (Array.isArray(options) && options.length > 0) {
              questionText += `\n选项：${(options as string[]).join(' / ')}`;
            }
            questionText += '\n\n请回复后重新发送您的请求（包含答案）。';
            fullText = questionText;
            yield { text: fullText, done: false };
          }
        }

        if (msg.type === 'result') {
          const resultMsg = msg as SDKResultMessage;
          if (resultMsg.subtype === 'success') {
            fullText = (resultMsg as Extract<SDKResultMessage, { subtype: 'success' }>).result || fullText;
          } else {
            const errorMsg = resultMsg as Exclude<SDKResultMessage, { subtype: 'success' }>;
            const details = errorMsg.errors.length > 0 ? errorMsg.errors.join('; ') : errorMsg.subtype;
            fullText = fullText || `[错误] ${details}`;
          }
          yield { text: fullText, done: true };
        }
      }
    } catch (err) {
      log.error('Claude 查询出错', err);
      yield { text: `[错误] ${err instanceof Error ? err.message : String(err)}`, done: true };
    } finally {
      this.currentQuery = null;
    }

    this._lastActivityAt = Date.now();
  }

  /** 中断当前正在进行的查询 */
  async stop(): Promise<boolean> {
    if (!this.currentQuery) return false;
    await this.currentQuery.interrupt();
    log.info('Claude 查询已中断', { chatId: this.chatId });
    return true;
  }

  /** 重置会话（清除 session ID，下次会开新会话） */
  reset() {
    this.sessionId = null;
    log.info('Claude 会话已重置', { chatId: this.chatId });
  }
}

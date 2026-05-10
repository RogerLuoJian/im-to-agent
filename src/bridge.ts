import type { IMAdapter, IncomingMessage, OutgoingMessage, SendResult } from './im/types.js';
import { AgentSessionManager } from './agent/session-manager.js';
import type { AgentProvider, Config, Project } from './config.js';
import { log } from './logger.js';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const HELP_TEXT = `可用命令:
/reset - 清除对话历史，开始新会话
/stop - 中断当前正在处理的请求
/projects - 列出所有可用项目
/project <name> - 切换到指定项目（也可直接说"去 xxx 项目"）
/help - 显示帮助信息

其它文本将直接发送给当前 Agent 处理。`;

export class Bridge {
  private sessions: AgentSessionManager;
  private readonly projects: Project[];
  private readonly agentName: string;
  /** 跟踪每个 chat 的进行中请求，防止并发 */
  private processing = new Set<string>();

  constructor(
    private readonly adapter: IMAdapter,
    private readonly config: Config,
    projects: Project[],
    defaultProject: string,
    private readonly agentProvider: AgentProvider,
  ) {
    const scopedClaudeConfig = {
      ...config.claude,
      projects,
      defaultProject,
    };
    this.projects = projects;
    this.agentName = agentProvider === 'codex' ? 'Codex' : 'Claude Code';
    this.sessions = new AgentSessionManager({
      provider: agentProvider,
      claude: scopedClaudeConfig,
      codex: config.codex,
    });
  }

  async start() {
    this.sessions.start();
    await this.adapter.start((msg) => this.handleMessage(msg));
    log.info(`Bridge 已启动，使用 ${this.adapter.name} 适配器`, { agent: this.agentProvider });
  }

  private send(msg: OutgoingMessage): Promise<SendResult> {
    return this.adapter.send({
      title: msg.title || (msg.isFinal ? this.agentName : `${this.agentName} (thinking...)`),
      ...msg,
    });
  }

  private async handleMessage(msg: IncomingMessage) {
    const { chatId, text } = msg;

    // 处理内置命令
    const parts = text.split(' ');
    const cmd = parts[0].toLowerCase();

    if (cmd === '/reset') {
      this.sessions.reset(chatId);
      this.processing.delete(chatId);
      await this.send({ chatId, content: '会话已清除，开始新对话。', isFinal: true });
      return;
    }

    if (cmd === '/stop') {
      const session = this.sessions.get(chatId);
      const stopped = session ? await session.stop() : false;
      await this.send({
        chatId,
        content: stopped ? '已发送中断信号，请求将停止。' : '当前没有正在处理的请求。',
        isFinal: true,
      });
      return;
    }

    if (cmd === '/help') {
      await this.send({ chatId, content: HELP_TEXT, isFinal: true });
      return;
    }

    if (cmd === '/projects') {
      const projects = this.projects;
      const session = this.sessions.getOrCreate(chatId);
      const currentPath = session.cwd;
      const currentProject = projects.find((p) => p.path === currentPath);

      const list = projects
        .map((p) => `${p.name === currentProject?.name ? '→ ' : '  '}${p.name}: ${p.path}`)
        .join('\n');

      await this.send({
        chatId,
        content: `可用项目:\n${list}\n\n使用 /project <name> 切换项目`,
        isFinal: true,
      });
      return;
    }

    if (cmd === '/project') {
      const projectName = parts[1]?.trim();
      if (!projectName) {
        await this.send({
          chatId,
          content: '请指定项目名称，例如: /project myapp\n使用 /projects 查看可用项目',
          isFinal: true,
        });
        return;
      }

      const project = this.projects.find(
        (p) => p.name.toLowerCase() === projectName.toLowerCase(),
      );

      if (!project) {
        const available = this.projects.map((p) => p.name).join(', ');
        await this.send({
          chatId,
          content: `未找到项目 "${projectName}"\n可用项目: ${available}`,
          isFinal: true,
        });
        return;
      }

      const session = this.sessions.getOrCreate(chatId);
      session.setCwd(project.path);
      await this.send({
        chatId,
        content: `已切换到项目: ${project.name}\n路径: ${project.path}`,
        isFinal: true,
      });
      return;
    }

    // 检测项目切换意图（自然语言）
    if (this.isProjectSwitchIntent(text)) {
      await this.handleProjectSwitch(chatId, text);
      return;
    }

    // 防止同一 chat 并发请求
    if (this.processing.has(chatId)) {
      await this.send({
        chatId,
        content: '上一个请求还在处理中，请等待完成后再发送。',
        isFinal: true,
      });
      return;
    }

    this.processing.add(chatId);

    try {
      // 立即发送"处理中"卡片
      const initial = await this.send({
        chatId,
        content: '收到，正在处理...',
        isFinal: false,
      });

      const session = this.sessions.getOrCreate(chatId);
      let lastUpdateTime = 0;
      const UPDATE_INTERVAL_MS = 3000; // 每 3 秒更新一次卡片

      // 如果是图片消息，下载图片并构造 prompt
      let prompt = text;
      if (msg.imageKey) {
        const imagePrompt = await this.prepareImagePrompt(msg);
        if (!imagePrompt) {
          return; // prepareImagePrompt 已发送错误消息
        }
        prompt = imagePrompt;
      }

      // 群聊上下文拼接
      if (msg.flushGroupContext) {
        const groupContext = msg.flushGroupContext();
        if (groupContext) {
          prompt = `${groupContext}\n\n---\n本次被 @ 的用户请求（优先执行）:\n${msg.senderName || '用户'} 说:\n${prompt}`;
        } else if (msg.senderName) {
          prompt = `${msg.senderName} 说:\n${prompt}`;
        }
      }

      for await (const progress of session.sendMessage(prompt)) {
        const now = Date.now();

        if (progress.done) {
          // 最终结果 — 一定要发送
          await this.send({
            chatId,
            updateMessageId: initial.messageId,
            content: progress.text,
            isFinal: true,
          });
        } else if (now - lastUpdateTime > UPDATE_INTERVAL_MS) {
          // 节流的进度更新
          await this.send({
            chatId,
            updateMessageId: initial.messageId,
            content: progress.text,
            isFinal: false,
          });
          lastUpdateTime = now;
        }
      }
    } catch (err) {
      log.error(`处理消息出错: chat=${chatId}`, err);
      await this.send({
        chatId,
        content: `[错误] ${err instanceof Error ? err.message : String(err)}`,
        isFinal: true,
      });
    } finally {
      this.processing.delete(chatId);
    }
  }

  /**
   * 下载并保存图片，返回包含图片路径的 prompt。
   * 失败时返回 null 并向用户发送错误消息。
   */
  private async prepareImagePrompt(msg: IncomingMessage): Promise<string | null> {
    if (!('downloadImage' in this.adapter) || typeof this.adapter.downloadImage !== 'function') {
      await this.send({
        chatId: msg.chatId,
        content: '当前平台不支持图片消息。',
        isFinal: true,
      });
      return null;
    }

    const session = this.sessions.getOrCreate(msg.chatId);
    const tmpDir = path.join(session.cwd, '.agent-tmp');
    await mkdir(tmpDir, { recursive: true });

    const fileName = `img_${Date.now()}_${msg.messageId.slice(-6)}.png`;
    const targetPath = path.join(tmpDir, fileName);

    try {
      await this.adapter.downloadImage(msg.messageId, msg.imageKey!, targetPath);
    } catch (err) {
      log.error('图片下载失败', err);
      await this.send({
        chatId: msg.chatId,
        content: `[错误] 图片下载失败: ${err instanceof Error ? err.message : String(err)}`,
        isFinal: true,
      });
      return null;
    }

    if (msg.text) {
      return `${msg.text}\n\n用户同时发送了一张图片，已保存到: ${targetPath}\n请读取该图片，然后结合用户的文字进行回复。`;
    }
    return `用户发送了一张图片，已保存到: ${targetPath}\n请读取该图片，然后描述你看到的内容。`;
  }

  /** 检测是否为切换项目的意图 */
  private isProjectSwitchIntent(text: string): boolean {
    const t = text.trim();

    // 精确命令：总是视为切换意图
    if (/^(切换项目|换个项目|项目列表)$/.test(t)) return true;
    if (/^(去|切到|切换到|换到)\s*.+?\s*项目$/.test(t)) return true;

    // "去 xxx" 形式：只在 xxx 匹配已有项目名时才视为切换
    const shortMatch = t.match(/^(去|切到|切换到|换到)\s*(.+)$/);
    if (shortMatch) {
      const target = shortMatch[2].trim().toLowerCase();
      return this.projects.some(
        (p) =>
          p.name.toLowerCase() === target ||
          p.name.toLowerCase().includes(target) ||
          target.includes(p.name.toLowerCase()),
      );
    }

    return false;
  }

  /** 处理项目切换 */
  private async handleProjectSwitch(chatId: string, text: string): Promise<void> {
    const projects = this.projects;
    const session = this.sessions.getOrCreate(chatId);
    const currentProject = projects.find((p) => p.path === session.cwd);

    // 尝试从文本中提取目标项目名
    const targetMatch = text.trim().match(/^(?:去|切到|切换到|换到)\s*(.+?)(?:\s*项目)?$/);
    if (targetMatch) {
      const targetName = targetMatch[1].trim();
      const project = projects.find(
        (p) =>
          p.name.toLowerCase() === targetName.toLowerCase() ||
          p.name.toLowerCase().includes(targetName.toLowerCase()),
      );
      if (project) {
        session.setCwd(project.path);
        await this.send({
          chatId,
          content: `已切换到项目: **${project.name}**\n路径: \`${project.path}\``,
          isFinal: true,
        });
        return;
      }
    }

    // 未指定或未找到，展示项目列表
    const list = projects
      .map((p, i) => {
        const isCurrent = p.name === currentProject?.name;
        return `${isCurrent ? '▶' : `${i + 1}.`} **${p.name}**`;
      })
      .join('\n');

    await this.send({
      chatId,
      content: `**可用项目：**\n\n${list}\n\n回复项目名称切换，例如：\`去 my-universe\``,
      isFinal: true,
    });
  }

  async stop() {
    await this.adapter.stop();
    this.sessions.stop();
    log.info('Bridge 已停止');
  }
}

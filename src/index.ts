import { loadConfig, type Config } from './config.js';
import { setLogLevel, log } from './logger.js';
import type { IMAdapter } from './im/types.js';
import { Bridge } from './bridge.js';
import { Scheduler } from './scheduler.js';

async function main() {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const platforms = config.imPlatforms;
  log.info('启动 im-to-agent 桥接服务', { platforms, defaultAgent: config.agent.provider });

  // 为每个平台创建独立的 adapter + bridge
  const adapters: IMAdapter[] = [];
  const bridges: Bridge[] = [];
  const schedulers: Scheduler[] = [];

  for (const platform of platforms) {
    if (platform === 'feishu') {
      // 多机器人：每个 bot 创建独立 adapter + bridge
      for (const bot of config.feishuBots) {
        const { FeishuAdapter } = await import('./im/feishu/feishu-adapter.js');
        const adapter = new FeishuAdapter(bot);
        adapters.push(adapter);
        bridges.push(new Bridge(adapter, config, bot.projects, bot.defaultProject, bot.agent));

        // Scheduler: 有 ownerOpenId 且项目列表包含 my-universe
        const targetProject = bot.projects.find((p) => p.name === 'my-universe');
        if (bot.ownerOpenId && targetProject) {
          schedulers.push(new Scheduler(adapter, bot.ownerOpenId, targetProject.path));
        }
      }
    } else if (platform === 'wecom') {
      const { WecomAdapter } = await import('./im/wecom/wecom-adapter.js');
      const adapter = new WecomAdapter(config.wecom);
      adapters.push(adapter);
      bridges.push(new Bridge(
        adapter,
        config,
        config.claude.projects,
        config.claude.defaultProject,
        config.agent.provider,
      ));
    }
  }

  const shutdown = async (signal: string) => {
    log.info(`收到 ${signal} 信号，正在停止...`);
    schedulers.forEach((s) => s.stop());
    await Promise.all(bridges.map((b) => b.stop()));
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 并行启动所有 bridge
  await Promise.all(bridges.map((b) => b.start()));

  // 启动调度器（bridge 启动后）
  schedulers.forEach((s) => s.start());

  log.info(`桥接服务已运行 (${platforms.join(', ')})。给机器人发消息即可开始使用。`);
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});

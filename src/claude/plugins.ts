import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { log } from '../logger.js';

interface InstalledPlugin {
  scope: 'user' | 'project';
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  gitCommitSha: string;
}

interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, InstalledPlugin[]>;
}

export interface PluginConfig {
  type: 'local';
  path: string;
}

/**
 * 读取用户已安装的 Claude Code plugins
 * @returns 已安装的 plugins 配置列表
 */
export async function loadInstalledPlugins(): Promise<PluginConfig[]> {
  const pluginsFilePath = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');

  try {
    const content = await readFile(pluginsFilePath, 'utf-8');
    const data: InstalledPluginsFile = JSON.parse(content);

    const plugins: PluginConfig[] = [];

    for (const [pluginName, installations] of Object.entries(data.plugins)) {
      // 取最新安装的版本（通常是第一个）
      const installation = installations[0];
      if (installation?.installPath) {
        plugins.push({
          type: 'local',
          path: installation.installPath,
        });
        log.debug('加载插件', { name: pluginName, path: installation.installPath });
      }
    }

    log.info('已加载用户插件', { count: plugins.length });
    return plugins;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log.debug('未找到插件配置文件，跳过插件加载');
    } else {
      log.warn('读取插件配置失败', err);
    }
    return [];
  }
}

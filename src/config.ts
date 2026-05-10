import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Project {
  name: string;
  path: string;
}

export type AgentProvider = 'claude' | 'codex';

export interface FeishuBotConfig {
  name: string;
  appId: string;
  appSecret: string;
  ownerOpenId?: string;
  agent: AgentProvider;
  projects: Project[];
  defaultProject: string;
}

export type IMPlatform = 'feishu' | 'wecom';

export interface Config {
  imPlatforms: IMPlatform[];

  agent: {
    provider: AgentProvider;
  };

  feishu: {
    appId: string;
    appSecret: string;
    ownerOpenId: string;
  };

  feishuBots: FeishuBotConfig[];

  wecom: {
    corpId: string;
    corpSecret: string;
    agentId: number;
    token: string;
    encodingAesKey: string;
    callbackPort: number;
  };

  claude: {
    defaultProject: string;
    projects: Project[];
    permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions';
    maxBudgetUsd: number;
    sessionTimeoutMinutes: number;
  };

  codex: {
    command: string;
    model?: string;
    sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
    approvalPolicy: 'untrusted' | 'on-failure' | 'on-request' | 'never';
    fullAuto: boolean;
    dangerouslyBypassApprovalsAndSandbox: boolean;
    extraArgs: string[];
  };

  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

interface RawConfig {
  imPlatforms?: IMPlatform[];
  agent?: {
    provider?: AgentProvider;
  };
  projects?: Array<{ name: string; path: string }>;
  feishuBots?: Array<{
    name: string;
    appId: string;
    appSecret: string;
    ownerOpenId?: string;
    agent?: AgentProvider;
    projects: string[];
    defaultProject?: string;
  }>;
  wecom?: Partial<Config['wecom']>;
  claude?: Partial<Omit<Config['claude'], 'projects' | 'defaultProject'>> & {
    defaultProject?: string;
  };
  codex?: Partial<Config['codex']>;
  logLevel?: Config['logLevel'];
}

export function loadConfig(): Config {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const configJsonPath = path.resolve(__dirname, '..', 'config.json');

  if (!existsSync(configJsonPath)) {
    throw new Error('缺少 config.json，请复制 config.json.example 并填入配置');
  }

  let fileConfig: RawConfig;
  try {
    const raw = readFileSync(configJsonPath, 'utf-8');
    fileConfig = JSON.parse(raw) as RawConfig;
  } catch (err) {
    throw new Error(`config.json 解析失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  const parseProjects = (): Project[] => {
    if (!fileConfig.projects || fileConfig.projects.length === 0) {
      throw new Error('config.json 缺少 projects 配置');
    }

    return fileConfig.projects.map((item) => {
      if (!item.name || !item.path) {
        throw new Error(`config.json 中项目配置无效: ${JSON.stringify(item)}`);
      }
      return { name: item.name.trim(), path: item.path.trim() };
    });
  };

  const imPlatforms = fileConfig.imPlatforms || (fileConfig.feishuBots ? ['feishu'] : []);

  if (imPlatforms.length === 0) {
    throw new Error('config.json 中 imPlatforms 不能为空');
  }
  for (const p of imPlatforms) {
    if (p !== 'feishu' && p !== 'wecom') {
      throw new Error(`不支持的 IM 平台: ${p}`);
    }
  }

  const projects = parseProjects();
  const defaultProject = fileConfig.claude?.defaultProject || projects[0]?.name || 'default';
  const agentProvider = parseAgentProvider(fileConfig.agent?.provider || 'claude');

  const wecom = buildWecomConfig(fileConfig, imPlatforms);

  // 构建 feishuBots
  let feishuBots: FeishuBotConfig[];

  if (imPlatforms.includes('feishu')) {
    if (!fileConfig.feishuBots || fileConfig.feishuBots.length === 0) {
      throw new Error('config.json 启用了 feishu，但缺少 feishuBots 配置');
    }
    const names = new Set<string>();
    const appIds = new Set<string>();

    feishuBots = fileConfig.feishuBots.map((bot) => {
      if (!bot.appId || !bot.appSecret) {
        throw new Error(`飞书机器人 "${bot.name}" 缺少 appId 或 appSecret`);
      }
      if (!bot.name) {
        throw new Error(`飞书机器人配置缺少 name 字段`);
      }
      if (names.has(bot.name)) {
        throw new Error(`飞书机器人名称重复: "${bot.name}"`);
      }
      if (appIds.has(bot.appId)) {
        throw new Error(`飞书机器人 appId 重复: "${bot.appId}"`);
      }
      names.add(bot.name);
      appIds.add(bot.appId);

      const resolvedProjects = bot.projects.map((pName) => {
        const found = projects.find((p) => p.name === pName);
        if (!found) {
          throw new Error(`飞书机器人 "${bot.name}" 引用了不存在的项目: "${pName}"`);
        }
        return found;
      });

      if (resolvedProjects.length === 0) {
        throw new Error(`飞书机器人 "${bot.name}" 没有配置任何项目`);
      }

      const dp = bot.defaultProject || resolvedProjects[0].name;
      if (!resolvedProjects.some((p) => p.name === dp)) {
        throw new Error(`飞书机器人 "${bot.name}" 的 defaultProject "${dp}" 不在其项目列表中`);
      }

      return {
        name: bot.name,
        appId: bot.appId,
        appSecret: bot.appSecret,
        ownerOpenId: bot.ownerOpenId,
        agent: bot.agent ? parseAgentProvider(bot.agent) : agentProvider,
        projects: resolvedProjects,
        defaultProject: dp,
      };
    });
  } else {
    feishuBots = [];
  }

  return {
    imPlatforms,
    agent: {
      provider: agentProvider,
    },
    feishu: { appId: '', appSecret: '', ownerOpenId: '' },
    feishuBots,
    wecom,
    claude: {
      defaultProject,
      projects,
      permissionMode: fileConfig.claude?.permissionMode || 'bypassPermissions',
      maxBudgetUsd: fileConfig.claude?.maxBudgetUsd ?? 5,
      sessionTimeoutMinutes: fileConfig.claude?.sessionTimeoutMinutes ?? 30,
    },
    codex: {
      command: fileConfig.codex?.command || 'codex',
      model: fileConfig.codex?.model || undefined,
      sandbox: parseCodexSandbox(fileConfig.codex?.sandbox || 'workspace-write'),
      approvalPolicy: parseCodexApprovalPolicy(fileConfig.codex?.approvalPolicy || 'never'),
      fullAuto: fileConfig.codex?.fullAuto ?? false,
      dangerouslyBypassApprovalsAndSandbox: fileConfig.codex?.dangerouslyBypassApprovalsAndSandbox ?? false,
      extraArgs: fileConfig.codex?.extraArgs || [],
    },
    logLevel: fileConfig.logLevel || 'info',
  };
}

function buildWecomConfig(fileConfig: RawConfig, imPlatforms: IMPlatform[]): Config['wecom'] {
  if (!imPlatforms.includes('wecom')) {
    return { corpId: '', corpSecret: '', agentId: 0, token: '', encodingAesKey: '', callbackPort: 3001 };
  }
  const wecom = fileConfig.wecom;
  if (!wecom) {
    throw new Error('config.json 启用了 wecom，但缺少 wecom 配置');
  }
  const requiredKeys: Array<keyof Config['wecom']> = ['corpId', 'corpSecret', 'agentId', 'token', 'encodingAesKey'];
  for (const key of requiredKeys) {
    if (wecom[key] === undefined || wecom[key] === '') {
      throw new Error(`config.json 中 wecom.${key} 不能为空`);
    }
  }
  return {
    corpId: wecom.corpId!,
    corpSecret: wecom.corpSecret!,
    agentId: wecom.agentId!,
    token: wecom.token!,
    encodingAesKey: wecom.encodingAesKey!,
    callbackPort: wecom.callbackPort ?? 3001,
  };
}

function parseAgentProvider(value: string): AgentProvider {
  if (value === 'claude' || value === 'codex') return value;
  throw new Error(`不支持的 Agent: ${value}，可选值: claude / codex`);
}

function parseCodexSandbox(value: string): Config['codex']['sandbox'] {
  if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') {
    return value;
  }
  throw new Error(`不支持的 codex.sandbox: ${value}`);
}

function parseCodexApprovalPolicy(value: string): Config['codex']['approvalPolicy'] {
  if (value === 'untrusted' || value === 'on-failure' || value === 'on-request' || value === 'never') {
    return value;
  }
  throw new Error(`不支持的 codex.approvalPolicy: ${value}`);
}

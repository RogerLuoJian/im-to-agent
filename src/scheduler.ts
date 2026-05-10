import cron from 'node-cron';
import { readFileSync, watch, existsSync } from 'fs';
import { join } from 'path';
import type { IMAdapter } from './im/types.js';
import { log } from './logger.js';

interface ReminderRule {
  id: string;
  cron: string;
  label: string;
  message: string;
  action: 'remind_only' | 'query_todos';
  enabled: boolean;
}

export class Scheduler {
  private tasks = new Map<string, cron.ScheduledTask>();
  private remindersPath: string;
  private todosPath: string;
  private watcher: ReturnType<typeof watch> | null = null;

  constructor(
    private readonly adapter: IMAdapter,
    private readonly ownerOpenId: string,
    private readonly myUniversePath: string,
  ) {
    this.remindersPath = join(myUniversePath, '备忘', 'reminders.json');
    this.todosPath = join(myUniversePath, '待办', 'TODO.md');
  }

  start(): void {
    if (!this.ownerOpenId) {
      log.warn('ownerOpenId 未配置，定时提醒将不会推送');
      return;
    }
    this.load();
    if (existsSync(this.remindersPath)) {
      try {
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        this.watcher = watch(this.remindersPath, () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            debounceTimer = null;
            log.info('reminders.json 已变更，重新加载定时任务');
            this.reload();
          }, 300);
        });
      } catch (err) {
        log.warn('无法监听 reminders.json 变更', err);
      }
    }
    log.info('Scheduler 已启动', { remindersPath: this.remindersPath });
  }

  private load(): void {
    if (!existsSync(this.remindersPath)) {
      log.info('reminders.json 不存在，跳过定时提醒加载');
      return;
    }
    try {
      const raw = readFileSync(this.remindersPath, 'utf-8');
      const rules: ReminderRule[] = JSON.parse(raw) as ReminderRule[];
      let loaded = 0;
      for (const rule of rules) {
        if (!rule.enabled) continue;
        if (!cron.validate(rule.cron)) {
          log.warn(`无效的 cron 表达式，跳过: ${rule.id} - "${rule.cron}"`);
          continue;
        }
        const task = cron.schedule(rule.cron, () => void this.fire(rule));
        this.tasks.set(rule.id, task);
        loaded++;
        log.info(`已注册定时提醒: ${rule.id} (${rule.label})`);
      }
      log.info(`共加载 ${loaded} 条定时提醒`);
    } catch (err) {
      log.error('加载 reminders.json 失败', err);
    }
  }

  private reload(): void {
    for (const task of this.tasks.values()) {
      task.stop();
    }
    this.tasks.clear();
    this.load();
  }

  private async fire(rule: ReminderRule): Promise<void> {
    log.info(`触发定时提醒: ${rule.id} (${rule.label})`);
    try {
      let content = rule.message;
      if (rule.action === 'query_todos') {
        try {
          const todos = readFileSync(this.todosPath, 'utf-8');
          content = `${rule.message}\n\n${todos}`;
        } catch {
          content = `${rule.message}\n\n（待办清单暂时无法读取）`;
        }
      }
      await this.adapter.sendProactive(this.ownerOpenId, content);
    } catch (err) {
      log.error(`推送提醒失败: ${rule.id}`, err);
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const task of this.tasks.values()) {
      task.stop();
    }
    this.tasks.clear();
    log.info('Scheduler 已停止');
  }
}

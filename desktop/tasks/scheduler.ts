/* ============================================================================
 * desktop/tasks/scheduler.ts —— 定时任务调度
 *   · 一次性 / 每天 / 每周指定星期 / 每月指定日 / 5 段 cron
 *   · 触发时走完整 Agent 工具链（复用 runner.sendMessage）
 *   · 完成发系统通知；执行历史写进 task.history
 *   · 应用关闭期间错过的任务不下发，启动时标 missedPending 交给用户决定
 * ==========================================================================*/

import type { ScheduledTask, TaskRunRecord } from '@shared/types';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from '../store/json';
import { tasksFile } from '../store/paths';
import { createChat, getChat, updateChat } from '../store/chats';
import { sendMessage } from '../agent/runner';

type Notify = (task: ScheduledTask, record: TaskRunRecord) => void;

let notify: Notify = () => {};
let timer: NodeJS.Timeout | null = null;
/** 同一次启动内只补跑一次，避免重复触发 */
const running = new Set<string>();

export function bindTaskNotifier(fn: Notify): void {
  notify = fn;
}

/* ------------------------------------------------------------------ 存储 */

export function listTasks(): ScheduledTask[] {
  const list = readJson<ScheduledTask[]>(tasksFile(), []);
  return Array.isArray(list) ? list : [];
}

function persist(list: ScheduledTask[]): void {
  writeJson(tasksFile(), list);
}

export function saveTask(input: Partial<ScheduledTask> & { name: string; prompt: string }): ScheduledTask {
  const list = listTasks();
  const existing = input.id ? list.find(t => t.id === input.id) : undefined;
  const base: ScheduledTask = existing ?? {
    id: randomUUID(),
    name: input.name,
    type: input.type ?? 'once',
    prompt: input.prompt,
    model: null,
    thinking: 'high',
    workspaceId: null,
    chatId: null,
    personaId: null,
    enabled: true,
    nextRun: null,
    createdAt: Date.now(),
    history: [],
  };
  Object.assign(base, input, { id: base.id });
  base.nextRun = computeNextRun(base);
  if (existing) {
    const idx = list.findIndex(t => t.id === base.id);
    list[idx] = base;
  } else {
    list.push(base);
  }
  persist(list);
  reschedule();
  return base;
}

export function deleteTask(id: string): void {
  persist(listTasks().filter(t => t.id !== id));
  reschedule();
}

export function toggleTask(id: string, enabled: boolean): ScheduledTask {
  const list = listTasks();
  const idx = list.findIndex(t => t.id === id);
  if (idx < 0) throw new Error('任务不存在');
  list[idx] = { ...list[idx], enabled, nextRun: enabled ? computeNextRun({ ...list[idx], enabled }) : null };
  persist(list);
  reschedule();
  return list[idx];
}

function pushHistory(taskId: string, record: TaskRunRecord): void {
  const list = listTasks();
  const idx = list.findIndex(t => t.id === taskId);
  if (idx < 0) return;
  const task = list[idx];
  task.history = [record, ...task.history].slice(0, 50);
  task.lastRun = record.at;
  if (task.type === 'once') {
    task.enabled = false;
    task.nextRun = null;
  } else {
    task.nextRun = computeNextRun(task);
  }
  persist(list);
}

/* -------------------------------------------------------------- 时间计算 */

/** 5 段 cron：分 时 日 月 周 */
function parseCron(expr: string): ((d: Date) => boolean) | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  function field(spec: string, min: number, max: number): Set<number> | null {
    const out = new Set<number>();
    for (const chunk of spec.split(',')) {
      const [rangePart, stepPart] = chunk.split('/');
      const step = stepPart ? Number(stepPart) : 1;
      if (!Number.isFinite(step) || step <= 0) return null;
      if (rangePart === '*') {
        for (let v = min; v <= max; v += step) out.add(v);
        continue;
      }
      const [a, b] = rangePart.split('-').map(Number);
      if (!Number.isFinite(a)) return null;
      const end = Number.isFinite(b) ? b : a;
      for (let v = Math.max(min, a); v <= Math.min(max, end); v += step) out.add(v);
    }
    return out;
  }

  const minutes = field(parts[0], 0, 59);
  const hours = field(parts[1], 0, 23);
  const days = field(parts[2], 1, 31);
  const months = field(parts[3], 1, 12);
  const weekdays = field(parts[4], 0, 6);
  if (!minutes || !hours || !days || !months || !weekdays) return null;

  return (d: Date) =>
    minutes.has(d.getMinutes()) &&
    hours.has(d.getHours()) &&
    days.has(d.getDate()) &&
    months.has(d.getMonth() + 1) &&
    weekdays.has(d.getDay());
}

function atTime(date: Date, timeOfDay: string | undefined): Date {
  const [h, m] = (timeOfDay ?? '09:00').split(':').map(Number);
  const out = new Date(date);
  out.setHours(Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0, 0, 0);
  return out;
}

export function computeNextRun(task: ScheduledTask, from = Date.now()): number | null {
  if (!task.enabled) return null;

  if (task.type === 'once') {
    if (task.runAt && task.runAt > from) return task.runAt;
    return null;
  }

  if (task.repeat === 'cron' && task.cron) {
    const match = parseCron(task.cron);
    if (!match) return null;
    const cursor = new Date(from + 60_000);
    cursor.setSeconds(0, 0);
    for (let i = 0; i < 60 * 24 * 366; i += 1) {
      if (match(cursor)) return cursor.getTime();
      cursor.setMinutes(cursor.getMinutes() + 1);
    }
    return null;
  }

  if (task.repeat === 'daily') {
    let candidate = atTime(new Date(from), task.timeOfDay);
    if (candidate.getTime() <= from) {
      candidate = atTime(new Date(from + 86_400_000), task.timeOfDay);
    }
    return candidate.getTime();
  }

  if (task.repeat === 'weekly') {
    const days = (task.weekdays?.length ? task.weekdays : [1]).slice().sort((a, b) => a - b);
    for (let offset = 0; offset <= 8; offset += 1) {
      const day = new Date(from + offset * 86_400_000);
      const candidate = atTime(day, task.timeOfDay);
      if (days.includes(candidate.getDay()) && candidate.getTime() > from) return candidate.getTime();
    }
    return null;
  }

  if (task.repeat === 'monthly') {
    const target = Math.min(31, Math.max(1, task.monthDay ?? 1));
    for (let offset = 0; offset <= 62; offset += 1) {
      const day = new Date(from + offset * 86_400_000);
      if (day.getDate() !== target) continue;
      const candidate = atTime(day, task.timeOfDay);
      if (candidate.getTime() > from) return candidate.getTime();
    }
    return null;
  }

  return null;
}

/* -------------------------------------------------------------- 执行 */

export async function runTaskNow(id: string): Promise<TaskRunRecord> {
  const task = listTasks().find(t => t.id === id);
  if (!task) throw new Error('任务不存在');
  if (running.has(id)) throw new Error('该任务正在执行中');
  running.add(id);
  const started = Date.now();
  let record: TaskRunRecord;

  try {
    // 绑定一个固定会话：已有就复用，否则新建
    let chatId = task.chatId;
    if (!chatId || !getChat(chatId)) {
      const chat = createChat(task.workspaceId ?? null, task.personaId ?? undefined, task.model ?? null);
      updateChat(chat.id, { title: `定时任务 · ${task.name}` });
      chatId = chat.id;
      const list = listTasks();
      const idx = list.findIndex(t => t.id === id);
      list[idx] = { ...list[idx], chatId };
      persist(list);
    }

    const result = await sendMessage({
      chatId,
      text: task.prompt,
      attachmentPaths: [],
      model: task.model ? { providerId: task.model.providerId, modelId: task.model.modelId } : null,
      thinking: task.thinking,
      personaId: task.personaId,
    });

    const chat = getChat(chatId);
    const last = [...(chat?.messages ?? [])].reverse().find(m => m.role === 'assistant');
    record = {
      id: randomUUID(),
      at: started,
      durationMs: Date.now() - started,
      status: result.ok ? 'success' : 'error',
      summary: (last?.content ?? '').replace(/\s+/g, ' ').slice(0, 200) || (result.ok ? '执行完成' : '执行失败'),
      artifactPaths: (last?.toolCalls ?? []).map(t => t.filePath).filter((p): p is string => Boolean(p)),
      error: result.ok ? undefined : result.error?.message,
    };
  } catch (err) {
    record = {
      id: randomUUID(),
      at: started,
      durationMs: Date.now() - started,
      status: 'error',
      summary: '执行失败',
      error: (err as Error).message,
    };
  } finally {
    running.delete(id);
  }

  pushHistory(id, record);
  const after = listTasks().find(t => t.id === id);
  if (after) notify(after, record);
  return record;
}

/* -------------------------------------------------------------- 调度循环 */

function tick(): void {
  const now = Date.now();
  for (const task of listTasks()) {
    if (!task.enabled || !task.nextRun) continue;
    if (task.nextRun > now) continue;
    void runTaskNow(task.id);
  }
}

export function reschedule(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // 每 20 秒扫一次；任务量小，成本可忽略
  timer = setInterval(tick, 20_000);
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * 启动时检查错过的任务：把 nextRun 已过期的周期性任务标 missedPending，
 * 由用户在面板上选择「补跑」或「跳过」（PRD 4.15）。
 */
export function detectMissed(): ScheduledTask[] {
  const now = Date.now();
  const list = listTasks();
  const missed: ScheduledTask[] = [];
  let changed = false;
  for (const task of list) {
    if (!task.enabled || !task.nextRun || task.nextRun > now) continue;
    if (task.type === 'once') {
      task.missedPending = true;
      missed.push(task);
      changed = true;
      continue;
    }
    task.missedPending = true;
    missed.push(task);
    changed = true;
  }
  if (changed) persist(list);
  return missed;
}

export function resolveMissed(id: string, shouldRun: boolean): void {
  const list = listTasks();
  const idx = list.findIndex(t => t.id === id);
  if (idx < 0) return;
  const task = list[idx];
  task.missedPending = false;
  task.nextRun = computeNextRun(task);
  persist(list);
  if (shouldRun) void runTaskNow(id);
}

export function startScheduler(): void {
  const missed = detectMissed();
  if (missed.length) {
    for (const task of missed) {
      // 先把 nextRun 推后，避免调度器立即重复触发
      const list = listTasks();
      const idx = list.findIndex(t => t.id === task.id);
      if (idx >= 0) {
        list[idx] = { ...list[idx], nextRun: computeNextRun({ ...list[idx], nextRun: null }) };
        persist(list);
      }
    }
  }
  reschedule();
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function runningTasks(): string[] {
  return [...running];
}

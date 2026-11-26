/* ============================================================================
 * src/components/settings/TasksSection.tsx —— 定时任务
 *   到点自动把一段提示词发给模型，结果落在一个专门的会话里。
 * ==========================================================================*/

import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { invoke } from '@/lib/bridge';
import { useApp } from '@/store/useApp';
import { useT } from '@/lib/i18n';
import { formatDuration, relativeFuture, relativeTime } from '@/lib/format';
import { Card, Empty, Group } from './ui';
import type { ScheduledTask, TaskRepeat, TaskType, ThinkingLevel } from '@shared/types';

const WEEK_LABEL = ['日', '一', '二', '三', '四', '五', '六'];

const REPEAT_LABEL: Record<TaskRepeat, string> = {
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  cron: 'cron 表达式',
};

interface Draft {
  id?: string;
  name: string;
  type: TaskType;
  prompt: string;
  repeat: TaskRepeat;
  timeOfDay: string;
  weekdays: number[];
  monthDay: number;
  cron: string;
  runAtLocal: string;
  thinking: ThinkingLevel;
  workspaceId: string;
  personaId: string;
  enabled: boolean;
}

function localInput(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function emptyDraft(): Draft {
  const soon = new Date(Date.now() + 3600_000);
  soon.setSeconds(0, 0);
  return {
    name: '',
    type: 'recurring',
    prompt: '',
    repeat: 'daily',
    timeOfDay: '09:00',
    weekdays: [1],
    monthDay: 1,
    cron: '0 9 * * *',
    runAtLocal: localInput(soon.getTime()),
    thinking: 'high',
    workspaceId: '',
    personaId: '',
    enabled: true,
  };
}

export function TasksSection() {
  const t = useT();
  const locale = useApp(s => s.settings?.locale);
  const tasks = useApp(s => s.tasks);
  const reloadTasks = useApp(s => s.reloadTasks);
  const workspaces = useApp(s => s.workspaces);
  const personas = useApp(s => s.personas);
  const toast = useApp(s => s.toast);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    void reloadTasks();
  }, [reloadTasks]);

  const beginNew = () => setDraft(emptyDraft());

  const beginEdit = (task: ScheduledTask) =>
    setDraft({
      id: task.id,
      name: task.name,
      type: task.type,
      prompt: task.prompt,
      repeat: task.repeat ?? 'daily',
      timeOfDay: task.timeOfDay ?? '09:00',
      weekdays: task.weekdays ?? [1],
      monthDay: task.monthDay ?? 1,
      cron: task.cron ?? '0 9 * * *',
      runAtLocal: task.runAt ? localInput(task.runAt) : localInput(Date.now() + 3600_000),
      thinking: task.thinking,
      workspaceId: task.workspaceId ?? '',
      personaId: task.personaId ?? '',
      enabled: task.enabled,
    });

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.prompt.trim()) {
      toast(t('名称和提示词都要填'), 'warn');
      return;
    }
    try {
      await invoke('task:save', {
        id: draft.id,
        name: draft.name.trim(),
        prompt: draft.prompt,
        type: draft.type,
        enabled: draft.enabled,
        thinking: draft.thinking,
        workspaceId: draft.workspaceId || null,
        personaId: draft.personaId || null,
        ...(draft.type === 'once'
          ? { runAt: new Date(draft.runAtLocal).getTime() }
          : draft.repeat === 'cron'
            ? { repeat: 'cron' as const, cron: draft.cron.trim() }
            : draft.repeat === 'weekly'
              ? { repeat: 'weekly' as const, timeOfDay: draft.timeOfDay, weekdays: draft.weekdays }
              : draft.repeat === 'monthly'
                ? { repeat: 'monthly' as const, timeOfDay: draft.timeOfDay, monthDay: draft.monthDay }
                : { repeat: 'daily' as const, timeOfDay: draft.timeOfDay }),
      });
      await reloadTasks();
      setDraft(null);
      toast(t('已保存'), 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const toggle = async (task: ScheduledTask) => {
    await invoke('task:toggle', { id: task.id, enabled: !task.enabled });
    await reloadTasks();
  };

  const runNow = async (task: ScheduledTask) => {
    setRunning(task.id);
    try {
      const rec = await invoke('task:run-now', { id: task.id });
      await reloadTasks();
      toast(
        rec.status === 'success' ? t('跑完了') : rec.error ?? t('执行失败'),
        rec.status === 'success' ? 'ok' : 'error',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setRunning(null);
    }
  };

  const remove = async (task: ScheduledTask) => {
    await invoke('task:delete', { id: task.id });
    await reloadTasks();
    toast(t('已删除'), 'ok');
  };

  const resolveMissed = async (task: ScheduledTask, run: boolean) => {
    await invoke('task:resolve-missed', { id: task.id, run });
    await reloadTasks();
  };

  /* ------------------------------------------------------------------ 编辑 */

  if (draft) {
    return (
      <Group
        title={draft.id ? t('编辑任务') : t('新建任务')}
        desc={t('到点后会新建一个「定时任务 · 名称」会话并把提示词发出去，产出留在那个会话里。')}
      >
        <div className="form-grid">
          <div className="field">
            <label className="field-label">{t('名称')}</label>
            <input
              className="input"
              autoFocus
              value={draft.name}
              placeholder={t('例如：每天早上整理行业新闻')}
              onChange={e => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label">{t('类型')}</label>
            <select
              className="select"
              style={{ width: '100%' }}
              value={draft.type}
              onChange={e => setDraft({ ...draft, type: e.target.value as TaskType })}
            >
              <option value="recurring">{t('重复')}</option>
              <option value="once">{t('一次性')}</option>
            </select>
          </div>

          {draft.type === 'once' ? (
            <div className="field full">
              <label className="field-label">{t('执行时间')}</label>
              <input
                className="input"
                type="datetime-local"
                value={draft.runAtLocal}
                onChange={e => setDraft({ ...draft, runAtLocal: e.target.value })}
              />
            </div>
          ) : (
            <>
              <div className="field">
                <label className="field-label">{t('重复方式')}</label>
                <select
                  className="select"
                  style={{ width: '100%' }}
                  value={draft.repeat}
                  onChange={e => setDraft({ ...draft, repeat: e.target.value as TaskRepeat })}
                >
                  {(Object.keys(REPEAT_LABEL) as TaskRepeat[]).map(r => (
                    <option key={r} value={r}>
                      {t(REPEAT_LABEL[r])}
                    </option>
                  ))}
                </select>
              </div>

              {draft.repeat !== 'cron' ? (
                <div className="field">
                  <label className="field-label">{t('时间')}</label>
                  <input
                    className="input"
                    type="time"
                    value={draft.timeOfDay}
                    onChange={e => setDraft({ ...draft, timeOfDay: e.target.value })}
                  />
                </div>
              ) : (
                <div className="field">
                  <label className="field-label">cron</label>
                  <input
                    className="input mono"
                    value={draft.cron}
                    placeholder="0 9 * * *"
                    onChange={e => setDraft({ ...draft, cron: e.target.value })}
                  />
                </div>
              )}

              {draft.repeat === 'weekly' && (
                <div className="field full">
                  <label className="field-label">{t('星期')}</label>
                  <div className="row gap-4" style={{ flexWrap: 'wrap' }}>
                    {WEEK_LABEL.map((label, idx) => {
                      const on = draft.weekdays.includes(idx);
                      return (
                        <button
                          key={idx}
                          type="button"
                          className="btn"
                          data-size="sm"
                          data-variant={on ? 'primary' : undefined}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              weekdays: on ? draft.weekdays.filter(d => d !== idx) : [...draft.weekdays, idx].sort(),
                            })
                          }
                        >
                          {t(label)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {draft.repeat === 'monthly' && (
                <div className="field">
                  <label className="field-label">{t('每月几号')}</label>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={31}
                    value={draft.monthDay}
                    onChange={e =>
                      setDraft({ ...draft, monthDay: Math.min(31, Math.max(1, Number(e.target.value) || 1)) })
                    }
                  />
                </div>
              )}
            </>
          )}

          <div className="field">
            <label className="field-label">{t('思考强度')}</label>
            <select
              className="select"
              style={{ width: '100%' }}
              value={draft.thinking}
              onChange={e => setDraft({ ...draft, thinking: e.target.value as ThinkingLevel })}
            >
              <option value="low">Low</option>
              <option value="high">High</option>
              <option value="max">Max</option>
            </select>
          </div>

          <div className="field">
            <label className="field-label">{t('工作区')}</label>
            <select
              className="select"
              style={{ width: '100%' }}
              value={draft.workspaceId}
              onChange={e => setDraft({ ...draft, workspaceId: e.target.value })}
            >
              <option value="">{t('不关联')}</option>
              {workspaces.map(w => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field-label">{t('人格')}</label>
            <select
              className="select"
              style={{ width: '100%' }}
              value={draft.personaId}
              onChange={e => setDraft({ ...draft, personaId: e.target.value })}
            >
              <option value="">{t('默认')}</option>
              {personas.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field full">
            <label className="field-label">{t('提示词')}</label>
            <textarea
              className="textarea"
              rows={7}
              placeholder={t('整理今天与「多模态大模型」相关的三条进展，每条一句话总结并附来源。')}
              value={draft.prompt}
              onChange={e => setDraft({ ...draft, prompt: e.target.value })}
            />
          </div>
        </div>

        <div className="row gap-8" style={{ marginTop: 14 }}>
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={draft.enabled}
            data-on={draft.enabled ? 'true' : 'false'}
            onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
          />
          <span className="dim" style={{ fontSize: 11.8 }}>
            {t('启用')}
          </span>
          <div className="grow" />
          <button type="button" className="btn" onClick={() => setDraft(null)}>
            {t('取消')}
          </button>
          <button type="button" className="btn" data-variant="primary" onClick={() => void save()}>
            {t('保存')}
          </button>
        </div>
      </Group>
    );
  }

  /* ------------------------------------------------------------------ 列表 */

  return (
    <>
      <Group
        title={t('任务列表')}
        desc={t('应用需要保持运行才会到点触发；关掉以后错过的任务下次启动会问你要不要补跑。')}
      >
        {tasks.length === 0 ? (
          <Card title={t('还没有定时任务')}>
            <Empty
              icon="clock"
              title={t('建一个任务')}
              desc={t('比如每天九点整理一次行业新闻，或者每周一汇总上周的代码改动。')}
            />
          </Card>
        ) : (
          tasks.map(task => (
            <Card
              key={task.id}
              title={
                <span className="row gap-6">
                  {task.name}
                  {task.missedPending && (
                    <span className="badge" data-tone="warn">
                      {t('有错过')}
                    </span>
                  )}
                  {!task.enabled && <span className="badge">{t('已停用')}</span>}
                </span>
              }
              sub={
                task.type === 'once'
                  ? `${t('一次性')} · ${task.runAt ? new Date(task.runAt).toLocaleString(locale ?? 'zh-CN') : '—'}`
                  : `${t(REPEAT_LABEL[task.repeat ?? 'daily'])}${
                      task.repeat === 'cron' ? ` ${task.cron}` : ` ${task.timeOfDay ?? ''}`
                    }${
                      task.repeat === 'weekly'
                        ? ` · ${t('周')}${task.weekdays?.map(d => t(WEEK_LABEL[d])).join('、') ?? ''}`
                        : ''
                    }${task.repeat === 'monthly' ? ` · ${task.monthDay} ${t('号')}` : ''}`
              }
              actions={
                <>
                  <button
                    type="button"
                    className="btn"
                    data-size="sm"
                    onClick={() => void runNow(task)}
                    disabled={running === task.id}
                  >
                    {running === task.id ? t('执行中…') : t('立即执行')}
                  </button>
                  <button type="button" className="btn" data-size="sm" onClick={() => void toggle(task)}>
                    {task.enabled ? t('停用') : t('启用')}
                  </button>
                  <button type="button" className="btn" data-size="sm" onClick={() => beginEdit(task)}>
                    <Icon name="edit" size={12} />
                  </button>
                  <button
                    type="button"
                    className="btn"
                    data-size="sm"
                    data-variant="danger"
                    onClick={() => void remove(task)}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </>
              }
            >
              <div
                className="dim"
                style={{ fontSize: 11.8, lineHeight: 1.7, whiteSpace: 'pre-wrap', maxHeight: 62, overflow: 'hidden' }}
              >
                {task.prompt.slice(0, 200)}
                {task.prompt.length > 200 ? '…' : ''}
              </div>
              <div className="row gap-8" style={{ marginTop: 9, fontSize: 11.5 }}>
                <span className="dim">
                  {t('下次')} {task.nextRun ? relativeFuture(task.nextRun) : '—'}
                </span>
                {task.lastRun && (
                  <span className="dim">
                    · {t('上次')} {relativeTime(task.lastRun)}
                  </span>
                )}
                <div className="grow" />
                {task.history.length > 0 && (
                  <button
                    type="button"
                    className="btn"
                    data-size="sm"
                    onClick={() => setExpanded(expanded === task.id ? null : task.id)}
                  >
                    <Icon name={expanded === task.id ? 'chevron-down' : 'chevron-right'} size={12} />
                    {t('历史')} {task.history.length}
                  </button>
                )}
              </div>

              {task.missedPending && (
                <div className="row gap-6" style={{ marginTop: 9 }}>
                  <span className="dim" style={{ fontSize: 11.5 }}>
                    {t('应用关闭期间错过了这次执行。')}
                  </span>
                  <button
                    type="button"
                    className="btn"
                    data-size="sm"
                    data-variant="primary"
                    onClick={() => void resolveMissed(task, true)}
                  >
                    {t('现在补跑')}
                  </button>
                  <button type="button" className="btn" data-size="sm" onClick={() => void resolveMissed(task, false)}>
                    {t('跳过')}
                  </button>
                </div>
              )}

              {expanded === task.id && (
                <div style={{ marginTop: 9 }}>
                  {task.history.slice(0, 8).map(rec => (
                    <div key={rec.id} className="list-item">
                      <div className="list-item-main">
                        <div className="list-item-text">{rec.summary || rec.error || t('（无摘要）')}</div>
                        <div className="list-item-meta">
                          <span className="dim">{new Date(rec.at).toLocaleString(locale ?? 'zh-CN')}</span>
                          <span className="dim">· {formatDuration(rec.durationMs)}</span>
                          <span
                            className="badge"
                            data-tone={
                              rec.status === 'success' ? 'ok' : rec.status === 'error' ? 'danger' : undefined
                            }
                          >
                            {rec.status === 'success' ? t('成功') : rec.status === 'error' ? t('失败') : t('跳过')}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          ))
        )}

        <div className="row gap-8" style={{ marginTop: 12 }}>
          <button type="button" className="btn" data-variant="primary" onClick={beginNew}>
            <Icon name="plus" size={13} />
            {t('新建任务')}
          </button>
        </div>
      </Group>
    </>
  );
}

/* ============================================================================
 * src/components/settings/PersonasSection.tsx —— 人格（系统提示词预设）
 *   内置人格改动会另存为一个副本，原版始终保持可用。
 * ==========================================================================*/

import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { invoke } from '@/lib/bridge';
import { useApp } from '@/store/useApp';
import { useT } from '@/lib/i18n';
import { Card, Empty, Group } from './ui';
import type { Persona } from '@shared/types';

interface Draft {
  id?: string;
  name: string;
  icon: string;
  systemPrompt: string;
}

const ICON_CHOICES = ['spark', 'persona', 'brain', 'wrench', 'globe', 'chart', 'shield', 'tool'];

export function PersonasSection() {
  const t = useT();
  const personas = useApp(s => s.personas);
  const reloadPersonas = useApp(s => s.reloadPersonas);
  const toast = useApp(s => s.toast);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const beginNew = () => setDraft({ name: '', icon: 'spark', systemPrompt: '' });
  const beginEdit = (p: Persona) =>
    setDraft({
      id: p.builtin ? undefined : p.id,
      name: p.builtin ? `${p.name}${t('（副本）')}` : p.name,
      icon: p.icon,
      systemPrompt: p.systemPrompt,
    });

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.systemPrompt.trim()) {
      toast(t('名称与系统提示词都要填'), 'warn');
      return;
    }
    setSaving(true);
    try {
      await invoke('persona:save', {
        id: draft.id,
        name: draft.name.trim(),
        icon: draft.icon,
        systemPrompt: draft.systemPrompt,
      });
      await reloadPersonas();
      setDraft(null);
      toast(t('已保存'), 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (p: Persona) => {
    if (p.builtin) {
      toast(t('内置人格不能删除，可以改成副本再调整'), 'warn');
      return;
    }
    await invoke('persona:delete', { id: p.id });
    await reloadPersonas();
    toast(t('已删除'), 'ok');
  };

  if (draft) {
    return (
      <Group
        title={draft.id ? t('编辑人格') : t('新建人格')}
        desc={t('系统提示词会放在整个 prompt 的最前面，写清楚角色、语气、边界。')}
      >
        <div className="form-grid">
          <div className="field">
            <label className="field-label">{t('名称')}</label>
            <input
              className="input"
              autoFocus
              value={draft.name}
              placeholder={t('例如：严谨的代码审查员')}
              onChange={e => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label">{t('图标')}</label>
            <div className="row gap-4" style={{ flexWrap: 'wrap' }}>
              {ICON_CHOICES.map(name => (
                <button
                  key={name}
                  type="button"
                  className="icon-btn"
                  data-tone={draft.icon === name ? 'accent' : undefined}
                  onClick={() => setDraft({ ...draft, icon: name })}
                  title={name}
                >
                  <Icon name={name as never} size={15} />
                </button>
              ))}
            </div>
          </div>
          <div className="field full">
            <label className="field-label">{t('系统提示词')}</label>
            <textarea
              className="textarea"
              data-mono
              rows={12}
              value={draft.systemPrompt}
              placeholder={'你是一位……\n\n工作方式：\n1. ……\n2. ……'}
              onChange={e => setDraft({ ...draft, systemPrompt: e.target.value })}
            />
            <span className="field-hint">
              {t('支持')} {'{{date}}'} {'{{workspace}}'} {'{{model}}'} {t('这类变量，会在运行时替换。')}
            </span>
          </div>
        </div>
        <div className="row gap-8" style={{ marginTop: 14 }}>
          <div className="grow" />
          <button type="button" className="btn" onClick={() => setDraft(null)}>
            {t('取消')}
          </button>
          <button type="button" className="btn" data-variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? t('保存中…') : t('保存')}
          </button>
        </div>
      </Group>
    );
  }

  return (
    <>
      <Group title={t('人格列表')} desc={t('新建会话时会带上默认人格，输入区里也能随时切换。')}>
        {personas.length === 0 ? (
          <Card title={t('还没有人格')}>
            <Empty
              icon="persona"
              title={t('建一个人格')}
              desc={t('把常用的工作方式写成系统提示词，以后不用每次重复。')}
            />
          </Card>
        ) : (
          personas.map(p => (
            <Card
              key={p.id}
              title={
                <span className="row gap-6">
                  <Icon name={p.icon as never} size={13} />
                  {t(p.name)}
                  {p.builtin && <span className="badge">{t('内置')}</span>}
                </span>
              }
              sub={`${p.systemPrompt.length} ${t('字')}`}
              actions={
                <>
                  <button type="button" className="btn" data-size="sm" onClick={() => beginEdit(p)}>
                    <Icon name="edit" size={12} />
                    {p.builtin ? t('改副本') : t('编辑')}
                  </button>
                  {!p.builtin && (
                    <button
                      type="button"
                      className="btn"
                      data-size="sm"
                      data-variant="danger"
                      onClick={() => void remove(p)}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  )}
                </>
              }
            >
              <div
                className="dim"
                style={{
                  fontSize: 11.8,
                  lineHeight: 1.7,
                  whiteSpace: 'pre-wrap',
                  maxHeight: 78,
                  overflow: 'hidden',
                }}
              >
                {p.systemPrompt.slice(0, 220)}
                {p.systemPrompt.length > 220 ? '…' : ''}
              </div>
            </Card>
          ))
        )}
        <div className="row gap-8" style={{ marginTop: 12 }}>
          <button type="button" className="btn" data-variant="primary" onClick={beginNew}>
            <Icon name="plus" size={13} />
            {t('新建人格')}
          </button>
        </div>
      </Group>
    </>
  );
}

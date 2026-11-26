/* ============================================================================
 * src/components/settings/MemorySection.tsx —— 记忆
 *   三层：全局 / 工作区 / 会话。写进这里的内容拼进系统提示词。
 * ==========================================================================*/

import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { invoke } from '@/lib/bridge';
import { useApp } from '@/store/useApp';
import { useT } from '@/lib/i18n';
import { Card, Empty, Group } from './ui';
import type { MemoryEntry, MemoryLayer } from '@shared/types';

const LAYER_LABEL: Record<MemoryLayer, string> = {
  global: '全局',
  workspace: '工作区',
  session: '会话',
};

const LAYER_DESC: Record<MemoryLayer, string> = {
  global: '所有会话都能读到。适合放长期偏好，比如「回答尽量短」。',
  workspace: '只在绑定该工作区的会话里生效。',
  session: '只属于当前会话，换会话就不带过去。',
};

export function MemorySection() {
  const t = useT();
  const workspaces = useApp(s => s.workspaces);
  // 性能：只订阅会话 id
  const chatId = useApp(s => s.chat?.id);
  const toast = useApp(s => s.toast);
  const locale = useApp(s => s.settings?.locale);

  const [layer, setLayer] = useState<MemoryLayer>('global');
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const [items, setItems] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');

  const scope = () => {
    if (layer === 'global') return { layer };
    if (layer === 'workspace') return { layer, workspaceId: workspaceId || workspaces[0]?.id };
    return { layer, chatId };
  };

  const load = async () => {
    setLoading(true);
    try {
      const s = scope();
      if (layer === 'workspace' && !s.workspaceId) {
        setItems([]);
        return;
      }
      if (layer === 'session' && !s.chatId) {
        setItems([]);
        return;
      }
      setItems(await invoke('memory:list', s));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer, workspaceId, chatId]);

  const add = async () => {
    const content = draft.trim();
    if (!content) return;
    try {
      const s = scope();
      await invoke('memory:add', { ...s, content });
      setDraft('');
      await load();
      toast(t('已记住'), 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const saveEdit = async (id: string) => {
    const content = editingText.trim();
    if (!content) return;
    await invoke('memory:update', { id, content });
    setEditingId(null);
    await load();
    toast(t('已更新'), 'ok');
  };

  const remove = async (id: string) => {
    await invoke('memory:delete', { id });
    await load();
    toast(t('已删除'), 'ok');
  };

  const disabledHint =
    (layer === 'workspace' && workspaces.length === 0 && t('还没有工作区，先到「工作区」分区建一个。')) ||
    (layer === 'session' && !chatId && t('当前没有打开的会话。')) ||
    null;

  return (
    <>
      <Group
        title={t('写一条记忆')}
        desc={t('一句一条，写清楚「是什么」，别写太长的段落，检索时命中率更高。')}
      >
        <div className="row gap-6" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
          {(Object.keys(LAYER_LABEL) as MemoryLayer[]).map(l => (
            <button
              key={l}
              type="button"
              className="btn"
              data-size="sm"
              data-variant={l === layer ? 'primary' : undefined}
              onClick={() => setLayer(l)}
            >
              {t(LAYER_LABEL[l])}
            </button>
          ))}
          {layer === 'workspace' && workspaces.length > 0 && (
            <select
              className="select"
              data-w="md"
              value={workspaceId || workspaces[0].id}
              onChange={e => setWorkspaceId(e.target.value)}
            >
              {workspaces.map(w => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="setting-group-desc" style={{ marginBottom: 8 }}>
          {t(LAYER_DESC[layer])}
        </div>

        {disabledHint ? (
          <div className="dim" style={{ fontSize: 12 }}>
            {disabledHint}
          </div>
        ) : (
          <div className="row gap-8" style={{ alignItems: 'flex-start' }}>
            <textarea
              className="textarea"
              rows={2}
              placeholder={t('例如：我习惯用简体中文回答，代码注释也用中文。')}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void add();
              }}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="btn"
              data-variant="primary"
              onClick={() => void add()}
              disabled={!draft.trim()}
            >
              <Icon name="plus" size={13} />
              {t('记住')}
            </button>
          </div>
        )}
      </Group>

      <Group
        title={`${t('已有记忆')} · ${items.length} ${t('条')}`}
        desc={t('每次对话会按相关度挑几条拼进系统提示词，不是全部塞进去。')}
      >
        {loading ? (
          <div className="dim" style={{ fontSize: 12 }}>
            {t('读取中…')}
          </div>
        ) : items.length === 0 ? (
          <Card title={t('这一层还是空的')}>
            <Empty
              icon="brain"
              title={t('还没有记忆')}
              desc={t('Agent 在对话里学到的偏好，也可以让它自己写进来。')}
            />
          </Card>
        ) : (
          items.map(item => (
            <div key={item.id} className="list-item">
              <div className="list-item-main">
                {editingId === item.id ? (
                  <textarea
                    className="textarea"
                    rows={2}
                    autoFocus
                    value={editingText}
                    onChange={e => setEditingText(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void saveEdit(item.id);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                  />
                ) : (
                  <div className="list-item-text">{item.content}</div>
                )}
                <div className="list-item-meta">
                  {item.tags.map(tag => (
                    <span key={tag} className="tag">
                      {tag}
                    </span>
                  ))}
                  <span className="dim">
                    {new Date(item.updatedAt).toLocaleDateString(locale ?? 'zh-CN')}
                  </span>
                  {item.source === 'agent' && <span className="dim">· {t('由 Agent 写入')}</span>}
                </div>
              </div>
              <div className="list-item-actions">
                {editingId === item.id ? (
                  <>
                    <button type="button" className="btn" data-size="sm" onClick={() => void saveEdit(item.id)}>
                      <Icon name="check" size={12} />
                    </button>
                    <button type="button" className="btn" data-size="sm" onClick={() => setEditingId(null)}>
                      <Icon name="x" size={12} />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn"
                      data-size="sm"
                      onClick={() => {
                        setEditingId(item.id);
                        setEditingText(item.content);
                      }}
                    >
                      <Icon name="edit" size={12} />
                    </button>
                    <button
                      type="button"
                      className="btn"
                      data-size="sm"
                      data-variant="danger"
                      onClick={() => void remove(item.id)}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </Group>
    </>
  );
}

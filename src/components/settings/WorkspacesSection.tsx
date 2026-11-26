/* ============================================================================
 * src/components/settings/WorkspacesSection.tsx —— 工作区
 *   一个工作区 = 磁盘上一个目录，会话可以绑定它，Agent 就能读写里面的文件
 * ==========================================================================*/

import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { invoke } from '@/lib/bridge';
import { useApp } from '@/store/useApp';
import { useT } from '@/lib/i18n';
import { Card, Empty, Group } from './ui';
import type { Workspace } from '@shared/types';

export function WorkspacesSection() {
  const t = useT();
  const workspaces = useApp(s => s.workspaces);
  const reloadWorkspaces = useApp(s => s.reloadWorkspaces);
  const reloadChats = useApp(s => s.reloadChats);
  const toast = useApp(s => s.toast);

  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const add = async () => {
    setBusy(true);
    try {
      const picked = await invoke('workspace:pick-folder', undefined);
      if (!picked) return;
      const name = picked.path.split(/[\\/]/).filter(Boolean).pop() ?? t('工作区');
      await invoke('workspace:create', { name, path: picked.path });
      await reloadWorkspaces();
      await reloadChats();
      toast(t('工作区已创建'), 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) return;
    await invoke('workspace:update', { id: editing.id, patch: { name } });
    setEditing(null);
    await reloadWorkspaces();
    toast(t('已重命名'), 'ok');
  };

  const remove = async (ws: Workspace, deleteFolder: boolean) => {
    const tip = deleteFolder ? `${t('同时删除磁盘目录')} ${ws.path}？` : t('只从列表里移除，磁盘文件保留。');
    const ok = await useApp.getState().askConfirm({
      title: `${t('移除工作区')}「${ws.name}」`,
      body: tip,
      confirmText: deleteFolder ? t('连目录一起删除') : t('移除工作区'),
      danger: deleteFolder,
    });
    if (!ok) return;
    try {
      await invoke('workspace:delete', { id: ws.id, deleteFolder });
      await reloadWorkspaces();
      await reloadChats();
      toast(t('已移除'), 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  return (
    <>
      <Group
        title={t('工作区')}
        desc={t(
          '绑定目录后，Agent 才能读文件、写文件、跑脚本；未绑定时会落到临时沙箱里，会话结束不保留。',
        )}
      >
        {workspaces.length === 0 ? (
          <Card title={t('还没有工作区')}>
            <Empty
              icon="folder"
              title={t('选一个目录当工作区')}
              desc={t('建议单独建一个空目录，别直接指向系统盘根目录。')}
            />
          </Card>
        ) : (
          workspaces.map(ws => (
            <Card
              key={ws.id}
              title={
                editing?.id === ws.id ? (
                  <input
                    className="input"
                    data-w="md"
                    autoFocus
                    value={editing.name}
                    onChange={e => setEditing({ id: ws.id, name: e.target.value })}
                    onKeyDown={e => {
                      if (e.key === 'Enter') void rename();
                      if (e.key === 'Escape') setEditing(null);
                    }}
                    onBlur={() => void rename()}
                  />
                ) : (
                  ws.name
                )
              }
              sub={ws.chatCount ? `${ws.chatCount} ${t('个会话')}` : undefined}
              actions={
                <>
                  <button
                    type="button"
                    className="btn"
                    data-size="sm"
                    onClick={() => void invoke('workspace:open-folder', { id: ws.id })}
                  >
                    <Icon name="external" size={12} />
                    {t('打开')}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    data-size="sm"
                    onClick={() => setEditing({ id: ws.id, name: ws.name })}
                  >
                    <Icon name="edit" size={12} />
                  </button>
                  <button
                    type="button"
                    className="btn"
                    data-size="sm"
                    data-variant="danger"
                    onClick={() => void remove(ws, false)}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </>
              }
            >
              <div className="mono dim" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>
                {ws.path}
              </div>
              <div className="row gap-8" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="btn"
                  data-size="sm"
                  data-variant="danger"
                  onClick={() => void remove(ws, true)}
                >
                  <Icon name="trash" size={12} />
                  {t('连目录一起删除')}
                </button>
              </div>
            </Card>
          ))
        )}

        <div className="row gap-8" style={{ marginTop: 12 }}>
          <button type="button" className="btn" data-variant="primary" onClick={() => void add()} disabled={busy}>
            <Icon name="plus" size={13} />
            {busy ? t('选择中…') : t('新建工作区')}
          </button>
        </div>
      </Group>

      <Group title={t('目录结构')} desc={t('新建工作区时会自动准备这些子目录。')}>
        <div className="mono" style={{ fontSize: 11.8, lineHeight: 1.9, color: 'var(--ink-3)' }}>
          <div>memory/MEMORY.md　—— {t('工作区长期记忆，Agent 能读到')}</div>
          <div>attachments/　—— {t('拖进来的图片与文件')}</div>
          <div>artifacts/　—— {t('工具产出（大结果、代码、图表）')}</div>
          <div>exports/　—— {t('导出的会话 Markdown / HTML')}</div>
          <div>.sandbox/　—— {t('run_code 的临时脚本与产物')}</div>
        </div>
      </Group>
    </>
  );
}

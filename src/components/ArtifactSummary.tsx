/* ============================================================================
 * src/components/ArtifactSummary.tsx —— 会话结束后的产物汇总
 *
 *   问题：产物原本只挂在各自那条工具卡上，一段长对话跑完，用户还得往上翻才
 *         找得到这次到底生成了什么。
 *   做法：消息列最末尾挂一块汇总，**按轮次分组**：
 *           · 只把「本轮」的产物铺开（缩略图 / 文件行）
 *           · 更早轮次的产物默认收起，点一下才展开，避免越聊越长
 *   只在「没有在流式输出」且确实有产物时出现，空会话不占位置。
 * ==========================================================================*/

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { invoke } from '@/lib/bridge';
import { useApp } from '@/store/useApp';
import { useT } from '@/lib/i18n';
import type { WorkspaceFile } from '@shared/types';

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i;
/** 文件写入与消息时间戳之间容差，避免边界上的产物被分到上一轮 */
const TURN_SLACK_MS = 2000;

function toFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const withScheme = /^[a-zA-Z]:/.test(normalized) ? `/${normalized}` : normalized;
  return `file://${encodeURI(withScheme).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isImage(file: WorkspaceFile): boolean {
  return file.kind === 'image' || IMAGE_EXT.test(file.name);
}

export function ArtifactSummary({ streaming }: { streaming: boolean }) {
  const t = useT();
  const chatId = useApp(s => s.chat?.id);
  const messages = useApp(s => s.chat?.messages);
  const artifactsVersion = useApp(s => s.artifactsVersion);
  const previewFile = useApp(s => s.previewFile);
  const [items, setItems] = useState<WorkspaceFile[]>([]);
  const [collapsedAll, setCollapsedAll] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);

  const load = useCallback(async () => {
    if (!chatId) {
      setItems([]);
      return;
    }
    try {
      const res = await invoke('chat:artifacts', { id: chatId });
      setItems(res.items);
    } catch {
      setItems([]);
    }
  }, [chatId]);

  useEffect(() => {
    void load();
  }, [load, artifactsVersion]);

  // 流式期间不刷这块，结束（streaming 变 false）时再拉一次最终结果
  useEffect(() => {
    if (!streaming) void load();
  }, [streaming, load]);

  // 本轮起点 = 最后一条用户消息的时间
  const turnStart = useMemo(() => {
    const list = messages ?? [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].role === 'user') return list[i].ts;
    }
    return 0;
  }, [messages]);

  const { currentItems, earlierItems, split } = useMemo(() => {
    if (!turnStart) return { currentItems: items, earlierItems: [] as WorkspaceFile[], split: false };
    const cur = items.filter(i => i.mtime >= turnStart - TURN_SLACK_MS);
    const old = items.filter(i => i.mtime < turnStart - TURN_SLACK_MS);
    // 本轮没产物时不分段，整块直接铺开（否则用户会看到一个空汇总）
    return { currentItems: cur.length ? cur : items, earlierItems: cur.length ? old : [], split: cur.length > 0 && old.length > 0 };
  }, [items, turnStart]);

  if (streaming || items.length === 0) return null;

  const openExternal = (filePath: string) => {
    void invoke('workspace:open-path', { path: filePath });
  };

  const renderGroup = (list: WorkspaceFile[]) => {
    const images = list.filter(isImage);
    const others = list.filter(f => !isImage(f));
    return (
      <>
        {images.length > 0 && (
          <div className="artifacts-gallery">
            {images.map(img => (
              <button
                key={img.path}
                type="button"
                className="artifacts-shot"
                title={`${img.relPath}\n${t('点击在系统里打开')}`}
                onClick={() => openExternal(img.path)}
              >
                <img src={toFileUrl(img.path)} alt={baseName(img.path)} loading="lazy" />
              </button>
            ))}
          </div>
        )}

        {others.length > 0 && (
          <div className="artifacts-list">
            {others.map(item => (
              <span key={item.path} className="artifacts-file-item">
                <button
                  type="button"
                  className="artifacts-file"
                  title={`${item.path}\n${t('点击在右侧阅读')}`}
                  onClick={() => previewFile(item.path, baseName(item.path))}
                >
                  <Icon name={item.kind === 'code' ? 'tool' : 'file'} size={11} />
                  <span className="ellipsis">{item.relPath}</span>
                  <span className="dim artifacts-size">{formatSize(item.size)}</span>
                </button>
                <button
                  type="button"
                  className="artifacts-locate"
                  title={t('打开存放位置')}
                  onClick={() => openExternal(item.path)}
                >
                  <Icon name="external" size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
      </>
    );
  };

  return (
    <div className="artifacts-summary">
      <div className="artifacts-head">
        <Icon name="folder" size={13} />
        <span className="artifacts-title">{t('本次会话的产物')}</span>
        <span className="artifacts-count">{items.length}</span>
        <div className="grow" />
        <button
          type="button"
          className="artifacts-toggle"
          onClick={() => setCollapsedAll(v => !v)}
          title={collapsedAll ? t('展开') : t('收起')}
        >
          <Icon name={collapsedAll ? 'chevron-down' : 'chevron-up'} size={12} />
          {collapsedAll ? t('展开') : t('收起')}
        </button>
      </div>

      {!collapsedAll && (
        <>
          {split ? (
            <>
              <div className="artifacts-subhead">
                {t('本轮产物')}
                <span className="artifacts-count">{currentItems.length}</span>
              </div>
              {renderGroup(currentItems)}

              <button
                type="button"
                className="artifacts-more"
                onClick={() => setShowEarlier(v => !v)}
                aria-expanded={showEarlier}
              >
                <Icon name={showEarlier ? 'chevron-up' : 'chevron-down'} size={12} />
                <span>{t('更早的产物')}</span>
                <span className="artifacts-count">{earlierItems.length}</span>
                <div className="grow" />
                <span className="dim">{showEarlier ? t('收起') : t('展开')}</span>
              </button>
              {showEarlier && renderGroup(earlierItems)}
            </>
          ) : (
            renderGroup(items)
          )}
        </>
      )}
    </div>
  );
}

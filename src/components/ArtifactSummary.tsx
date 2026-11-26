/* ============================================================================
 * src/components/ArtifactSummary.tsx —— 会话结束后的产物汇总
 *
 *   问题：产物原本只挂在各自那条工具卡上，一段长对话跑完，用户还得往上翻才
 *         找得到这次到底生成了什么。
 *   做法：消息列最末尾（虚拟列表之后）挂一块汇总，把当前会话的
 *         artifacts / files / exports 全列出来：
 *           · 图片直接给缩略图，点一下用系统看图器打开
 *           · 文本点一下在右栏读，独立按钮跳到存放位置
 *   只在「没有在流式输出」且确实有产物时出现，空会话不占位置。
 * ==========================================================================*/

import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { invoke } from '@/lib/bridge';
import { useApp } from '@/store/useApp';
import { useT } from '@/lib/i18n';
import type { WorkspaceFile } from '@shared/types';

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i;

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

export function ArtifactSummary({ streaming }: { streaming: boolean }) {
  const t = useT();
  const chatId = useApp(s => s.chat?.id);
  const artifactsVersion = useApp(s => s.artifactsVersion);
  const previewFile = useApp(s => s.previewFile);
  const [items, setItems] = useState<WorkspaceFile[]>([]);
  const [collapsedAll, setCollapsedAll] = useState(false);

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

  if (streaming || items.length === 0) return null;

  const images = items.filter(f => f.kind === 'image' || IMAGE_EXT.test(f.name));
  const others = items.filter(f => !(f.kind === 'image' || IMAGE_EXT.test(f.name)));

  const openExternal = (filePath: string) => {
    void invoke('workspace:open-path', { path: filePath });
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
      )}
    </div>
  );
}

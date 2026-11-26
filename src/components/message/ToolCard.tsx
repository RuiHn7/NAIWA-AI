/* ============================================================================
 * src/components/message/ToolCard.tsx —— 工具调用卡片
 * 头部一行：图标 + 展示名 + 来源 + 参数摘要 + 状态/耗时；点开看完整结果。
 * 有产物文件时：图片直接内联成缩略图，其它类型列成可点击的文件条目。
 * ==========================================================================*/

import { useState } from 'react';
import type { ToolCallRecord } from '@shared/types';
import { Icon, type IconName } from '@/components/Icon';
import { argSummary, formatDuration } from '@/lib/format';
import { invoke } from '@/lib/bridge';
import { useT } from '@/lib/i18n';
import { useApp } from '@/store/useApp';

const TOOL_ICON: Record<string, IconName> = {
  // 软件工程工具（当前工具集）
  ls: 'folder',
  grep: 'search',
  read_file: 'file',
  write_file: 'file',
  edit_patch: 'edit',
  shell: 'wrench',
  git_diff: 'file',
  finish: 'check',
  // 旧名兼容
  list_files: 'folder',
  delete_file: 'trash',
  run_command: 'wrench',
  run_code: 'wrench',
  // 其它
  web_search: 'globe',
  read_web_page: 'globe',
  generate_image: 'image',
};

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i;

/** 反斜杠转正斜杠 + 编码，Chromium 才能正常加载 file:// 本地图片 */
function toFileUrl(filePath: string): string {
  const forward = filePath.replace(/\\/g, '/');
  return `file://${encodeURI(forward).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

/** 取文件所在目录（用于「打开存放位置」的提示文案） */
function dirName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  parts.pop();
  return parts.join('\\') || filePath;
}

function roleOf(filePath: string): 'image' | 'file' {
  return IMAGE_EXT.test(filePath) ? 'image' : 'file';
}

/** 「打开存放位置」：workspace:open-path 对文件走 showItemInFolder，正好是所在目录 */
function revealFile(filePath: string) {
  void invoke('workspace:open-path', { path: filePath });
}

/** 图片用系统看图器打开 */
function openFile(filePath: string) {
  void invoke('workspace:open-path', { path: filePath });
}

/** 文本类产物点一下直接进右栏读，图片走系统看图器 */
function previewInPanel(filePath: string, name: string) {
  useApp.getState().previewFile(filePath, name);
}

/** 产物列表：图片出缩略图，其它出文件行 */
function ArtifactList({ files }: { files: string[] }) {
  const t = useT();
  const unique = Array.from(new Set(files.filter(Boolean)));
  if (!unique.length) return null;
  const images = unique.filter(f => roleOf(f) === 'image');
  const others = unique.filter(f => roleOf(f) !== 'image');

  return (
    <div className="tool-files">
      {images.length > 0 && (
        <div className="tool-gallery">
          {images.map(file => (
            <div key={file} className="tool-shot-wrap">
              <button
                type="button"
                className="tool-shot"
                title={`${baseName(file)}\n${t('点击在系统里打开')}`}
                onClick={() => openFile(file)}
              >
                <img src={toFileUrl(file)} alt={baseName(file)} loading="lazy" />
              </button>
              <button
                type="button"
                className="tool-shot-locate"
                title={t('打开存放位置')}
                aria-label={t('打开存放位置')}
                onClick={() => revealFile(file)}
              >
                <Icon name="external" size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="tool-file-list">
          {others.map(file => (
            <span key={file} className="tool-file-item">
              <button
                type="button"
                className="tool-file"
                title={`${file}\n${t('点击在右侧阅读')}`}
                onClick={() => previewInPanel(file, baseName(file))}
              >
                <Icon name="file" size={12} />
                <span className="ellipsis">{baseName(file)}</span>
              </button>
              <button
                type="button"
                className="tool-file-locate"
                title={t('打开存放位置')}
                aria-label={t('打开存放位置')}
                onClick={() => revealFile(file)}
              >
                <Icon name="external" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function ToolCard({ call }: { call: ToolCallRecord }) {
  const t = useT();
  const [open, setOpen] = useState(call.status === 'error' || call.status === 'denied');
  const duration = call.endedAt ? call.endedAt - call.startedAt : null;
  const isMcp = call.source.startsWith('mcp:');
  // 产物永远露在外面（不折叠），这样生成的图不用点开就能看见
  const files = call.files?.length ? call.files : call.filePath ? [call.filePath] : [];

  return (
    <div className="tool-card" data-status={call.status} data-open={open}>
      <button type="button" className="tool-head" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        <span className="tool-icon">
          <Icon name={TOOL_ICON[call.name] ?? 'tool'} size={13} />
        </span>
        <span className="tool-label">{t(call.label || call.name)}</span>
        {isMcp && <span className="tool-source">MCP</span>}
        <span className="tool-args">{argSummary(call.args)}</span>
        <span className="tool-meta">
          {call.status === 'running' && <span className="tool-spinner" />}
          {call.status === 'success' && <Icon name="check" size={12} />}
          {(call.status === 'error' || call.status === 'denied') && <Icon name="alert" size={12} />}
          {files.length > 0 && (
            <span className="tool-count" title={t('产物')}>
              <Icon name="image" size={11} />
              {files.length}
            </span>
          )}
          {duration !== null && <span className="mono">{formatDuration(duration)}</span>}
          <span className="tool-caret">
            <Icon name="chevron-right" size={12} />
          </span>
        </span>
      </button>

      {/* 产物永远露在外面（不折叠）：图片直接是缩略图，其它是可点开阅读的文件条目 */}
      {call.status !== 'running' && files.length > 0 && <ArtifactList files={files} />}

      {open && (
        <div className="tool-body">
          {call.status === 'running' && t('正在执行…')}
          {call.status === 'denied' && t('操作未获授权，已跳过。')}
          {call.status === 'error' && (call.error || t('执行失败'))}
          {call.status === 'success' && (call.result || t('（无输出）'))}
          {files.length > 0 && (
            <div className="tool-locate-row">
              <button
                type="button"
                className="tool-file"
                title={dirName(files[0])}
                onClick={() => revealFile(files[0])}
              >
                <Icon name="folder" size={12} />
                {t('打开存放位置')}
              </button>
              {roleOf(files[0]) !== 'image' && (
                <button
                  type="button"
                  className="tool-file"
                  onClick={() => previewInPanel(files[0], baseName(files[0]))}
                >
                  <Icon name="external" size={12} />
                  {t('在右侧阅读')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

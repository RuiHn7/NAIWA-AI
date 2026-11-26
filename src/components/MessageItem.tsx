/* ============================================================================
 * src/components/MessageItem.tsx —— 单条消息
 *   user：右对齐气泡 + 图片 + 复制/编辑/删除
 *   assistant：头像行 + 思考块 + 计划 + 工具卡 + Markdown + 操作条
 * 用 React.memo 包住，避免流式时整列重渲染。
 * ==========================================================================*/

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage } from '@shared/types';
import { Icon } from '@/components/Icon';
import { AiAvatar } from '@/components/Brand';
import { ThinkBlock } from '@/components/message/ThinkBlock';
import { PlanCard } from '@/components/message/PlanCard';
import { ToolCard } from '@/components/message/ToolCard';
import { renderMarkdown } from '@/lib/markdown';
import { formatTokens, usageLevel } from '@/lib/format';
import { useApp } from '@/store/useApp';
import { invoke } from '@/lib/bridge';
import { useT, translate, currentLocale } from '@/lib/i18n';

interface MessageItemProps {
  message: ChatMessage;
  streaming: boolean;
  isLast: boolean;
}

function copyToClipboard(text: string) {
  const write = async () => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  };
  void write().then(ok => {
    if (ok) return;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      /* 忽略 */
    }
    document.body.removeChild(ta);
  });
}

export const MessageItem = memo(function MessageItem({ message, streaming, isLast }: MessageItemProps) {
  const toast = useApp(s => s.toast);
  const regenerate = useApp(s => s.regenerate);
  const editMessage = useApp(s => s.editMessage);
  const deleteMessage = useApp(s => s.deleteMessage);
  const continueReply = useApp(s => s.continueReply);
  const personas = useApp(s => s.personas);
  const t = useT();

  const [editing, setEditing] = useState<string | null>(null);
  const [vote, setVote] = useState<'up' | 'down' | null>(null);
  const editRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing !== null) {
      editRef.current?.focus();
      editRef.current?.setSelectionRange(editing.length, editing.length);
    }
  }, [editing]);

  const html = useMemo(
    () => (message.role === 'assistant' ? renderMarkdown(message.content, streaming) : ''),
    [message.role, message.content, streaming],
  );

  /* 压缩摘要单独呈现 */
  if (message.summary) {
    return (
      <div className="compress-note">
        <span>{t('已压缩更早的对话')} · {message.content.slice(0, 80)}</span>
      </div>
    );
  }

  /* ------------------------------------------------------------- 用户消息 */
  if (message.role === 'user') {
    const images = (message.attachments ?? []).filter(a => a.kind === 'image');
    const files = (message.attachments ?? []).filter(a => a.kind !== 'image');

    if (editing !== null) {
      return (
        <div className="msg" data-role="user">
          <div className="msg-edit">
            <textarea
              ref={editRef}
              value={editing}
              onChange={e => setEditing(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') setEditing(null);
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  void editMessage(message.id, editing).then(() => setEditing(null));
                }
              }}
            />
            <div className="msg-edit-actions">
              <button type="button" className="btn" data-size="sm" onClick={() => setEditing(null)}>
                {t('取消')}
              </button>
              <button
                type="button"
                className="btn"
                data-variant="primary"
                data-size="sm"
                onClick={() => {
                  const next = editing.trim();
                  if (next) void editMessage(message.id, next);
                  setEditing(null);
                }}
              >
                {t('保存')}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="msg" data-role="user">
        <div className="msg-user">
          {images.length > 0 && (
            <div className="msg-user-imgs">
              {images.map(img => (
                <img key={img.id} src={img.preview || `file://${img.path}`} alt={img.name} />
              ))}
            </div>
          )}
          {message.content}
        </div>

        {files.length > 0 && (
          <div className="msg-attach">
            {files.map(f => (
              <span key={f.id} className="msg-attach-item">
                <Icon name="file" size={11} />
                {f.name}
              </span>
            ))}
          </div>
        )}

        <div className="msg-actions">
          <button
            type="button"
            className="msg-act"
            title={t('复制')}
            aria-label={t('复制')}
            onClick={() => {
              copyToClipboard(message.content);
              toast(t('已复制'), 'ok');
            }}
          >
            <Icon name="copy" size={13} />
          </button>
          <button
            type="button"
            className="msg-act"
            title={t('编辑并重新发送')}
            aria-label={t('编辑')}
            onClick={() => setEditing(message.content)}
          >
            <Icon name="edit" size={13} />
          </button>
          <button
            type="button"
            className="msg-act"
            data-tone="danger"
            title={t('删除这条消息')}
            aria-label={t('删除')}
            onClick={() => void deleteMessage(message.id)}
          >
            <Icon name="trash" size={13} />
          </button>
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------------- AI 消息 */
  const persona = personas.find(p => p.id === message.personaId);
  const level = message.usage ? usageLevel(message.usage.totalTokens, 128000) : 'safe';

  return (
    <div className="msg" data-role="assistant">
      <div className="ai-head">
        <AiAvatar size={26} />
        <span className="ai-name">NAI WA</span>
        {persona && persona.id !== 'persona-general' && <span className="ai-think-tag">{t(persona.name)}</span>}
        {message.model && <span className="ai-model">{message.model.label}</span>}
        {message.thinking && message.thinking !== 'high' && (
          <span className="ai-think-tag">
            <Icon name="brain" size={10} />
            {message.thinking === 'low' ? 'Low' : 'Max'}
          </span>
        )}
      </div>

      {message.reasoning && <ThinkBlock text={message.reasoning} streaming={streaming && !message.content} />}
      {message.plan && <PlanCard plan={message.plan} />}
      {message.toolCalls?.map(call => <ToolCard key={call.id} call={call} />)}

      {message.content ? (
        <div className="bubble">
          <div dangerouslySetInnerHTML={{ __html: html }} />
          {streaming && <span className="caret" />}
        </div>
      ) : (
        streaming && !message.reasoning && !message.toolCalls?.length && (
          <div className="bubble">
            <span className="caret" />
          </div>
        )
      )}

      {message.status === 'error' && (
        <div className="msg-error">
          <span className="msg-error-icon">
            <Icon name="alert" size={14} />
          </span>
          <span>{message.error || t('请求失败')}</span>
        </div>
      )}

      {message.status === 'stopped' && (
        // PRD 七.2：停止后可以一键接着写
        <div className="msg-stopped">
          <span>{t('已停止生成')}</span>
          {isLast && (
            <button type="button" className="msg-resume" onClick={() => void continueReply()}>
              <Icon name="arrow-up" size={12} />
              {t('继续')}
            </button>
          )}
        </div>
      )}

      {!streaming && (
        <div className="msg-actions">
          <button
            type="button"
            className="msg-act"
            title={t('复制')}
            aria-label={t('复制')}
            onClick={() => {
              copyToClipboard(message.content);
              toast(t('已复制'), 'ok');
            }}
          >
            <Icon name="copy" size={13} />
          </button>
          {isLast && (
            <button
              type="button"
              className="msg-act"
              title={t('重新生成')}
              aria-label={t('重新生成')}
              onClick={() => void regenerate(message.id)}
            >
              <Icon name="retry" size={13} />
            </button>
          )}
          <button
            type="button"
            className="msg-act"
            data-on={vote === 'up'}
            title={t('有帮助')}
            aria-label={t('有帮助')}
            onClick={() => setVote(vote === 'up' ? null : 'up')}
          >
            <Icon name="thumbs-up" size={13} />
          </button>
          <button
            type="button"
            className="msg-act"
            data-on={vote === 'down'}
            title={t('没帮助')}
            aria-label={t('没帮助')}
            onClick={() => setVote(vote === 'down' ? null : 'down')}
          >
            <Icon name="thumbs-down" size={13} />
          </button>
          <button
            type="button"
            className="msg-act"
            data-tone="danger"
            title={t('删除这条消息')}
            aria-label={t('删除')}
            onClick={() => void deleteMessage(message.id)}
          >
            <Icon name="trash" size={13} />
          </button>
          {message.usage && (
            <span className="msg-usage" data-level={level} title={t('本次用量')}>
              ↑{formatTokens(message.usage.promptTokens)} ↓{formatTokens(message.usage.completionTokens)}
            </span>
          )}
        </div>
      )}
    </div>
  );
});

/* ------------------------------------------------------------------ 代码复制
 * Markdown 渲染出的代码块带 data-copy-code 按钮，这里统一在消息列上做事件委托。
 * ------------------------------------------------------------------------ */

export function useCodeCopyDelegation(ref: React.RefObject<HTMLElement | null>) {
  const toast = useApp(s => s.toast);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement | null)?.closest('[data-copy-code]') as HTMLElement | null;
      if (!btn) return;
      const block = btn.closest('.code-block');
      const code = block?.querySelector('code')?.textContent ?? '';
      copyToClipboard(code);
      btn.dataset.done = 'true';
      const label = btn.querySelector('span');
      const prev = label?.textContent;
      if (label) label.textContent = translate('已复制', currentLocale());
      window.setTimeout(() => {
        btn.dataset.done = 'false';
        if (label && prev) label.textContent = prev;
      }, 1400);
      toast(translate('代码已复制', currentLocale()), 'ok');
    };
    const onClickExternal = (e: MouseEvent) => {
      const link = (e.target as HTMLElement | null)?.closest('a[data-external]') as HTMLAnchorElement | null;
      if (!link) return;
      e.preventDefault();
      void invoke('shell:open-external', { url: link.href });
    };
    root.addEventListener('click', onClick);
    root.addEventListener('click', onClickExternal);
    return () => {
      root.removeEventListener('click', onClick);
      root.removeEventListener('click', onClickExternal);
    };
  }, [ref, toast]);
}

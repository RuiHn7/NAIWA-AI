/* ============================================================================
 * src/components/MessageList.tsx —— 消息列
 *   · react-virtual 虚拟滚动（超长会话不掉帧）
 *   · 贴底自动跟随；离底时通过 onAtBottomChange 通知外层（「回到最新」按钮
 *     已经挪到输入框上方，不能再挂在滚动容器里 —— 挂在里面会跟着内容滚走）
 *   · 每个动态度量值走 ref 读，避免 scroll 事件触发重渲染
 * ==========================================================================*/

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { MessageItem, useCodeCopyDelegation } from '@/components/MessageItem';
import { ArtifactSummary } from '@/components/ArtifactSummary';
import { useApp } from '@/store/useApp';
import type { ChatMessage } from '@shared/types';

/** 稳定的空数组引用：zustand 选择器返回新数组会触发 React #185 */
const EMPTY_MESSAGES: ChatMessage[] = [];

/** 滚到消息列底部（导出给外层「回到最新」按钮用） */
export function scrollThreadToBottom(smooth = true): void {
  const el = document.getElementById('thread-scroll');
  if (!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

export function MessageList({ onAtBottomChange }: { onAtBottomChange?: (atBottom: boolean) => void }) {
  // 性能：只订阅 messages 与 id —— 改标题 / 换模型不会让整列重渲染
  const messages = useApp(s => s.chat?.messages) ?? EMPTY_MESSAGES;
  const chatId = useApp(s => s.chat?.id);
  const streamingChatId = useApp(s => s.streamingChatId);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const stickRef = useRef(true);

  useCodeCopyDelegation(scrollRef);

  const streaming = !!chatId && streamingChatId === chatId;

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 180,
    overscan: 6,
    getItemKey: index => messages[index]?.id ?? index,
    measureElement:
      typeof window !== 'undefined' && 'ResizeObserver' in window
        ? element => element.getBoundingClientRect().height
        : undefined,
  });

  /* --------------------------------------------------------------- 滚动跟随 */

  const scrollToBottom = useCallback((smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // 离底状态同步给外层（「回到最新」按钮在输入框上方）
  useEffect(() => {
    onAtBottomChange?.(atBottom);
  }, [atBottom, onAtBottomChange]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickRef.current = gap < 60;
      setAtBottom(gap < 60);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // 切换会话：直接贴底，不做动画
  useLayoutEffect(() => {
    stickRef.current = true;
    setAtBottom(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatId]);

  // 新消息 / 流式增量：仅在贴底时跟随
  const lastLen = messages[messages.length - 1]?.content.length ?? 0;
  useEffect(() => {
    if (!stickRef.current) return;
    scrollToBottom(false);
  }, [messages.length, lastLen, scrollToBottom]);

  // 会话从磁盘载入后（首帧 count 还是 0）再贴一次底
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || messages.length === 0) return;
    const id = requestAnimationFrame(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [chatId, messages.length]);

  // 注意：不能 useMemo 缓存 getVirtualItems()——虚拟器内部测量变化不会改变
  // 依赖项，缓存会停在「首帧还是空列表」的旧值上，导致整列消息不渲染。
  const items = virtualizer.getVirtualItems();

  return (
    <div className="thread-scroll" id="thread-scroll" ref={scrollRef}>
      <div className="thread" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {items.map(item => {
          const message = messages[item.index];
          if (!message) return null;
          const isLast = item.index === messages.length - 1;
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${item.start}px)`,
                paddingBottom: 20,
              }}
            >
              <MessageItem
                message={message}
                streaming={streaming && isLast}
                isLast={isLast && !streaming}
              />
            </div>
          );
        })}
      </div>

      {/* 会话跑完把这次的全部产物汇总在末尾，不用再往上翻 */}
      <div className="thread-tail">
        <ArtifactSummary streaming={streaming} />
      </div>
    </div>
  );
}

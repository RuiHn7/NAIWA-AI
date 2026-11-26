/* ============================================================================
 * src/components/Composer.tsx —— 输入区（PRD 三 重组后的版本）
 *   · 底部一行顺序固定：＋ / 权限 / 模型+思考强度 / 麦克风 / 发送
 *   · 权限徽标：审批（默认）/ 完全访问；切到「完全访问」先弹独立风险告知窗
 *   · 模型与思考强度合并成同一个面板：上半模型列表，下半 Low/High/Max，
 *     按钮上紧凑显示「模型名 · High」，hover 显示完整信息
 *   · textarea 自动长高（最高 42vh），草稿按会话保留
 * ==========================================================================*/

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { Menu, MenuItem, MenuLabel, MenuSep, useMenu, anchorOf, type MenuAnchor } from '@/components/Menu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useApp, selectActiveModel, selectThinking } from '@/store/useApp';
import { formatTokens, usageLevel } from '@/lib/format';
import { useT } from '@/lib/i18n';
import type { PermissionMode, ThinkingLevel } from '@shared/types';

type MenuKind = 'model' | 'attach' | 'permission' | 'vision';

/** 会话级上下文长度档位（PRD：300K / 600K / 1M / 自动） */
const CONTEXT_STEPS: { value: number | 'auto'; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 300_000, label: '300K' },
  { value: 600_000, label: '600K' },
  { value: 1_000_000, label: '1M' },
];

/* Web Speech API 的最小类型（避免引 @types/dom-speech-recognition） */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
}

const THINKING_OPTIONS: [ThinkingLevel, string, string][] = [
  ['low', 'Low', '响应快，适合日常问答'],
  ['high', 'High', '默认档，质量和速度平衡'],
  ['max', 'Max', '深度推理，较慢'],
];

const THINKING_LABEL: Record<ThinkingLevel, string> = { low: 'Low', high: 'High', max: 'Max' };

export function Composer() {
  const t = useT();
  // 性能：拆成窄选择器，避免流式期间（45ms 一次 flush）输入区跟着整条 chat 重渲染
  const activeChatId = useApp(s => s.chat?.id);
  const contextLimit = useApp(s => s.chat?.contextLimit);
  const personaId = useApp(s => s.chat?.personaId);
  const chatModel = useApp(s => s.chat?.model);
  const streamingChatId = useApp(s => s.streamingChatId);
  const attachments = useApp(s => s.attachments);
  const usage = useApp(s => s.usage);
  const balance = useApp(s => s.balance);
  const reloadBalance = useApp(s => s.reloadBalance);
  const providers = useApp(s => s.providers);
  const personas = useApp(s => s.personas);
  const settings = useApp(s => s.settings);
  const model = useApp(selectActiveModel);
  const thinking = useApp(selectThinking);
  const drafts = useApp(s => s.drafts);

  const send = useApp(s => s.send);
  const stop = useApp(s => s.stop);
  const patchChat = useApp(s => s.patchChat);
  const compress = useApp(s => s.compress);
  const addAttachments = useApp(s => s.addAttachments);
  const addAttachmentFiles = useApp(s => s.addAttachmentFiles);
  const removeAttachment = useApp(s => s.removeAttachment);
  const clearAttachments = useApp(s => s.clearAttachments);
  const openSettings = useApp(s => s.openSettings);
  const saveSettings = useApp(s => s.saveSettings);
  const setDraft = useApp(s => s.setDraft);
  const toast = useApp(s => s.toast);

  const chatId = activeChatId ?? '';
  const text = drafts[chatId] ?? '';

  const [kind, setKind] = useState<MenuKind | null>(null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [dragging, setDragging] = useState(false);
  const [riskOpen, setRiskOpen] = useState(false);
  /** 「上下文长度」子菜单的锚点：取整个模型列表的矩形，贴它的右边缘开 */
  const [subAnchor, setSubAnchor] = useState<MenuAnchor | null>(null);
  /** 当前正展开子菜单的那一行（只影响视觉） */
  const [subKey, setSubKey] = useState<string | null>(null);

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  /** 模型列表滚动区，用来量出模型列表的右边缘 */
  const modelListRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  /** 拖拽高亮的真值镜像：dragover 里读 ref 不会读到旧闭包 */
  const draggingRef = useRef(false);
  const { menu, open, close } = useMenu();

  const streaming = !!activeChatId && streamingChatId === activeChatId;
  const disabled = !activeChatId;
  const permission: PermissionMode = settings?.permission ?? 'approval';
  const fullAccess = permission === 'full';

  const setText = useCallback(
    (value: string) => {
      if (chatId) setDraft(chatId, value);
    },
    [chatId, setDraft],
  );

  /* ---------------------------------------------------------------- 自动高度 */

  const autosize = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.42)}px`;
  }, []);

  useEffect(() => {
    autosize();
  }, [text, autosize]);

  useEffect(() => {
    if (activeChatId) taRef.current?.focus();
  }, [activeChatId]);

  /* ---------------------------------------------------------------- 发送 */

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !streaming && !disabled;

  const doSend = () => {
    if (!canSend) return;
    const value = text;
    setText('');
    requestAnimationFrame(autosize);
    void send(value);
  };

  /* ---------------------------------------------------------------- 语音 */

  const startVoice = () => {
    const Ctor = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null;
    if (!Ctor) {
      toast('当前环境不支持语音识别，可用系统听写输入', 'warn');
      return;
    }
    const rec: SpeechRecognitionLike = new Ctor();
    rec.lang = 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;
    const base = text;
    let finalText = '';
    rec.onresult = (event: any) => {
      let live = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const res = event.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else live += res[0].transcript;
      }
      setInterim(live || finalText);
      if (finalText) {
        const glue = base && !base.endsWith(' ') ? `${base} ` : base;
        setText(glue + finalText);
      }
    };
    rec.onerror = (event: any) => {
      if (event?.error === 'not-allowed' || event?.error === 'service-not-allowed') {
        toast('麦克风权限被拒绝，请在系统设置里允许', 'error');
      }
      setListening(false);
      setInterim('');
    };
    rec.onend = () => {
      setListening(false);
      setInterim('');
      requestAnimationFrame(autosize);
    };
    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      toast('无法启动语音识别', 'error');
    }
  };

  const stopVoice = () => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
    setInterim('');
  };

  useEffect(() => () => recognitionRef.current?.abort(), []);

  /* ---------------------------------------------------------------- 拖拽 */

  // 拖拽与「点击选择文件」是两条独立入口：
  //   · 点击 → addAttachments(kind) → IPC dialog:pick-files → 系统选择框
  //   · 拖拽/粘贴 → addAttachmentFiles(files) → preload 换路径 → IPC dialog:describe-files
  // 两者最后都落到同一个 attachments 状态与同一套附件渲染，不会再弹选择框。
  useEffect(() => {
    // 计数解决「拖过子元素时 enter/leave 成对触发」的问题：归零才算真正离开
    let depth = 0;

    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      // 不 preventDefault 的话，Electron 会用默认行为接管这次拖放（打开文件/跳转）
      e.preventDefault();
      e.stopPropagation();
      depth += 1;
      setDragging(true);
    };

    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      if (!draggingRef.current) {
        draggingRef.current = true;
        setDragging(true);
      }
    };

    const onDragLeave = (e: DragEvent) => {
      // 拖到窗口外 / 松开在外部时 dataTransfer.types 可能已经空了，
      // 所以先按「是否离开窗口」硬收一次，再走正常的计数逻辑。
      if (e.relatedTarget === null) {
        depth = 0;
        draggingRef.current = false;
        setDragging(false);
        return;
      }
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        draggingRef.current = false;
        setDragging(false);
      }
    };

    // 拖拽被系统打断（按 Esc、拖出到别的应用）时也要把高亮擦掉
    const onDragEnd = () => {
      depth = 0;
      draggingRef.current = false;
      setDragging(false);
    };

    const onDrop = (e: DragEvent) => {
      depth = 0;
      draggingRef.current = false;
      setDragging(false);
      // 这两句是关键：没有它们浏览器会拿文件去导航（把当前页面替换成文件本身）
      e.preventDefault();
      e.stopPropagation();
      const dropped = e.dataTransfer?.files;
      if (!dropped || !dropped.length) return;
      void addAttachmentFiles(dropped);
    };

    // 兜底：拖到窗口任意位置都不许触发「用文件替换页面」的默认行为
    const blockDefault = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', onDragEnd);
    // 捕获阶段再兜一层，防止某个子组件的 stopPropagation 把 window 监听吃掉
    window.addEventListener('dragover', blockDefault, true);
    window.addEventListener('drop', blockDefault, true);
    document.addEventListener('drop', blockDefault, true);
    document.addEventListener('dragover', blockDefault, true);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', onDragEnd);
      window.removeEventListener('dragover', blockDefault, true);
      window.removeEventListener('drop', blockDefault, true);
      document.removeEventListener('drop', blockDefault, true);
      document.removeEventListener('dragover', blockDefault, true);
    };
  }, [addAttachmentFiles]);

  /* ---------------------------------------------------------------- 派生 */

  const level = usage ? usageLevel(usage.tokens, usage.limit) : 'safe';
  const percent = usage && usage.limit > 0 ? Math.min(100, (usage.tokens / usage.limit) * 100) : 0;

  /* 底部统计：轮 · 步 · tok/s · 用了多少 tok · 缓存命中率 · 圆环 */
  const statItems: { key: string; label: string; value: string; title?: string }[] = usage
    ? [
        { key: 'rounds', label: t('轮'), value: String(usage.rounds), title: t('用户发起的对话轮次') },
        { key: 'steps', label: t('步'), value: String(usage.steps), title: t('模型回复与工具调用的总步数') },
        {
          key: 'tps',
          label: 'tok/s',
          value: usage.tokPerSec > 0 ? usage.tokPerSec.toFixed(1) : '—',
          title: t('最近一条回复的生成速度'),
        },
        {
          key: 'tokens',
          label: 'tok',
          value: formatTokens(usage.totalTokens),
          title: `${t('输入')} ${formatTokens(usage.promptTokens)} · ${t('输出')} ${formatTokens(usage.completionTokens)}`,
        },
        {
          key: 'cache',
          label: t('缓存命中'),
          value: usage.promptTokens > 0 ? `${Math.round(usage.cacheHitRate * 100)}%` : '—',
          title: `${formatTokens(usage.cachedTokens)} / ${formatTokens(usage.promptTokens)}`,
        },
      ]
    : [];

  const contextStep = contextLimit ?? 'auto';
  const ringR = 9;
  const ringC = 2 * Math.PI * ringR;
  // 子列表标题带上当前悬停的模型名：换一行就跟着变，用户能确认「刷的是我指的这一个」
  const subModelLabel = (() => {
    if (!subKey) return '';
    const [pid, mid] = subKey.split(':');
    const p = providers.find(x => x.id === pid);
    const m = p?.models.find(x => x.id === mid);
    return m?.label || mid || '';
  })();

  /* 不用 useMemo：t 每次渲染都是新函数，memo 反而失去意义 */
  const modelName = !providers.length ? t('未接入') : model ? model.label || model.modelId : t('选择模型');
  const providerName = model ? providers.find(p => p.id === model.providerId)?.label ?? '' : '';
  const thinkingLabel = THINKING_LABEL[thinking];

  const persona = personas.find(p => p.id === personaId);

  const openAttach = (el: HTMLElement) => {
    setKind('attach');
    open(el, 'left');
  };

  /* 识图（视觉）模型：设置里显式指定优先，否则自动挑第一个带视觉标记的模型 */
  const visionTarget = (() => {
    const wantedProvider = (settings?.visionProviderId ?? '').trim();
    const wantedModel = (settings?.visionModelId ?? '').trim();
    if (wantedProvider) {
      const p = providers.find(x => x.id === wantedProvider);
      if (p) {
        const m = (wantedModel ? p.models.find(x => x.id === wantedModel) : undefined) ?? p.models.find(x => x.vision) ?? p.models[0];
        if (m) return { providerId: p.id, providerLabel: p.label, modelId: m.id, modelLabel: m.label || m.id, manual: true };
      }
    }
    for (const p of providers) {
      if (!p.enabled || !p.models.length) continue;
      const m = p.models.find(x => x.vision);
      if (!m) continue;
      return { providerId: p.id, providerLabel: p.label, modelId: m.id, modelLabel: m.label || m.id, manual: false };
    }
    return null;
  })();

  /** 识图面板：本机识图始终可用，所以不再因为没有接入项就把人赶去设置页 */
  const openVision = (el: HTMLElement) => {
    setKind('vision');
    open(el, 'right');
  };

  /** 给某个模型打上「用来识图」的标记；传 null 表示回到自动 */
  const pickVision = (picked: { providerId: string; modelId: string } | null) => {
    if (!picked) {
      void saveSettings({ visionProviderId: '', visionModelId: '' });
      toast(t('已回到本机识图（默认）'), 'ok');
      return;
    }
    void saveSettings({ visionProviderId: picked.providerId, visionModelId: picked.modelId });
    toast(t('已启用多模态精度增强'), 'ok');
  };

  const openModel = (el: HTMLElement) => {
    if (!providers.some(p => p.enabled && p.models.length > 0)) {
      toast(t('还没有可用模型，先去接入一个'), 'warn');
      openSettings('providers');
      return;
    }
    setSubAnchor(null);
    setSubKey(null);
    setKind('model');
    open(el, 'left');
  };

  // 主菜单收起 / 切到别的面板时，二级菜单必须一起收起
  useEffect(() => {
    if (!menu || kind !== 'model') {
      setSubAnchor(null);
      setSubKey(null);
    }
  }, [menu, kind]);

  /* ---------------------------------------------------------------- 渲染 */

  return (
    <div className="composer-zone" data-dragging={dragging ? 'true' : undefined}>
      {attachments.length > 0 && (
        <div className="composer-wrap">
          <div className="attach-tray">
            {attachments.map(a => (
              <span key={a.id} className="attach-chip">
                {a.kind === 'image' && a.preview ? (
                  <img src={a.preview} alt={a.name} />
                ) : (
                  <Icon name={a.kind === 'image' ? 'image' : 'file'} size={14} />
                )}
                <span className="attach-name">{a.name}</span>
                <span className="attach-size">{Math.max(1, Math.round(a.size / 1024))}K</span>
                <button
                  type="button"
                  className="attach-remove"
                  aria-label={`${t('移除')} ${a.name}`}
                  onClick={() => void removeAttachment(a.id)}
                >
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="composer-wrap">
        <div className="composer" data-disabled={disabled ? 'true' : undefined}>
          {listening && (
            <div className="voice-strip">
              <span className="voice-wave">
                {Array.from({ length: 14 }).map((_, i) => (
                  <i key={i} />
                ))}
              </span>
              <span className="voice-text">{interim || t('正在聆听…')}</span>
              <button type="button" className="voice-stop" onClick={stopVoice}>
                {t('结束')}
              </button>
            </div>
          )}

          <textarea
            ref={taRef}
            value={text}
            rows={1}
            placeholder={
              disabled ? t('先新建一个会话') : `${t('给 NAI WA 发消息…')}  ${t('⏎ 发送 · ⇧⏎ 换行')}`
            }
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                doSend();
              }
            }}
            onPaste={e => {
              // 粘贴图片 / 文件：和拖拽同一条链路，直接读文件本体，不弹选择框
              const files = Array.from(e.clipboardData?.files ?? []);
              if (!files.length) return;
              e.preventDefault();
              void addAttachmentFiles(files);
            }}
          />

          {/* 顺序：＋ / 权限 /（弹性空隙）/ 人格 / 模型+思考强度 / 麦克风 / 发送（PRD 三） */}
          <div className="composer-row">
            <button
              type="button"
              className="icon-btn"
              title={t('添加附件')}
              aria-label={t('添加附件')}
              onClick={e => openAttach(e.currentTarget)}
            >
              <Icon name="plus" size={17} />
            </button>

            <button
              type="button"
              className="pill pill-perm"
              data-tone={fullAccess ? 'danger' : 'normal'}
              title={
                fullAccess
                  ? t('完全访问：工具无需审批直接执行，点击切回审批模式')
                  : t('审批模式：写入/命令/外部工具执行前都会先问你')
              }
              aria-label={fullAccess ? t('完全访问') : t('审批')}
              onClick={e => {
                if (fullAccess) {
                  void saveSettings({ permission: 'approval' });
                  toast(t('已切回审批模式'), 'ok');
                  return;
                }
                setKind('permission');
                open(e.currentTarget, 'right');
              }}
            >
              <Icon name={fullAccess ? 'alert' : 'shield'} size={12} />
              <span className="pill-label">{fullAccess ? t('完全访问') : t('审批')}</span>
            </button>

            <div className="grow" />

            {persona && persona.id !== 'persona-general' && (
              <span className="pill" data-static="true">
                <Icon name="persona" size={12} />
                <span className="pill-label">{t(persona.name)}</span>
              </span>
            )}

            {/* 识图：软件内置本机识图；下面那个多模态模型只是可选的精度增强 */}
            <button
              type="button"
              className="pill pill-vision"
              data-tone={visionTarget ? (visionTarget.manual ? 'manual' : 'auto') : 'local'}
              title={
                visionTarget
                  ? `${t('本机识图已就绪')} + ${visionTarget.providerLabel} · ${visionTarget.modelLabel}（${visionTarget.manual ? t('已手动指定') : t('自动挑选')}）\n${t('点一下可以换一个多模态模型（可选）')}`
                  : `${t('本机识图已就绪')}：${t('软件内置解码、像素分析、离线 OCR 与生成历史反查，不需要任何配置')}\n${t('点这里可选接入一个多模态模型，提升照片里具体物体的识别精度')}`
              }
              aria-label={t('识图')}
              onClick={e => openVision(e.currentTarget)}
            >
              <Icon name="image" size={12} />
              <span className="pill-label">{visionTarget ? visionTarget.modelLabel : t('本机识图')}</span>
            </button>

            {/* 余额：贴右、在模型按钮左边 */}
            {balance?.ok && balance.display && (
              <span className="pill-balance" title={`${t('账户余额')} · ${balance.display}${balance.endpoint ? `\n${balance.endpoint}` : ''}`}>
                <Icon name="chart" size={11} />
                <span>{balance.display}</span>
              </span>
            )}

            <button
              type="button"
              className="pill pill-model"
              title={
                model
                  ? `${providerName ? `${providerName} · ` : ''}${model.modelId}\n${t('思考强度')}：${thinkingLabel}`
                  : t('切换模型')
              }
              onClick={e => openModel(e.currentTarget)}
            >
              <span className="pill-dot" data-tone={model ? 'accent' : 'off'} />
              <span className="pill-label pill-model-name">{modelName}</span>
              <span className="pill-strength">{thinkingLabel}</span>
              <Icon name="chevron-down" size={11} />
            </button>

            <button
              type="button"
              className="icon-btn"
              title={listening ? t('结束语音输入') : t('语音输入')}
              aria-label={t('语音输入')}
              data-tone={listening ? 'accent' : undefined}
              onClick={() => (listening ? stopVoice() : startVoice())}
            >
              <Icon name="mic" size={16} />
            </button>

            <button
              type="button"
              className="send-btn"
              data-mode={streaming ? 'stop' : 'send'}
              disabled={!streaming && !canSend}
              title={streaming ? t('停止生成 (Esc)') : t('发送 (⏎)')}
              aria-label={streaming ? t('停止生成') : t('发送')}
              onClick={() => (streaming ? void stop() : doSend())}
            >
              <Icon name={streaming ? 'stop' : 'arrow-up'} size={16} />
            </button>
          </div>
        </div>

        {/* 底部统计行（PRD：输入框与底边之间显示轮/步/tok/s/tok/缓存命中/圆环） */}
        {usage && (
          <div className="stat-line" data-level={level}>
            <span className="stat-items">
              {statItems.map(item => (
                <span key={item.key} className="stat-cell" title={item.title ?? item.label}>
                  <span className="stat-value">{item.value}</span>
                  <span className="stat-label">{item.label}</span>
                </span>
              ))}
            </span>

            <span className="stat-right">
              <button
                type="button"
                className="usage-compress"
                title={t('把更早的消息压成摘要，释放上下文')}
                onClick={() => void compress(true)}
              >
                {t('压缩上下文')}
              </button>

              <span
                className="ctx-ring"
                data-level={level}
                data-nonzero={percent > 0 ? 'true' : undefined}
                title={`${formatTokens(usage.tokens)} / ${formatTokens(usage.limit)} tokens`}
              >
                <svg viewBox="0 0 22 22" width="22" height="22" aria-hidden="true">
                  <circle className="ctx-ring-bg" cx="11" cy="11" r={ringR} fill="none" strokeWidth="2" />
                  <circle
                    className="ctx-ring-fg"
                    cx="11"
                    cy="11"
                    r={ringR}
                    fill="none"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeDasharray={ringC}
                    /* 占比很小时给一段最小可见弧（6%），否则圆环看着像空的 */
                    strokeDashoffset={ringC * (1 - (percent > 0 ? Math.max(percent, 6) : 0) / 100)}
                    transform="rotate(-90 11 11)"
                  />
                </svg>
                <span className="ctx-percent">{Math.round(percent)}%</span>
              </span>
            </span>
          </div>
        )}
      </div>

      {menu && kind && (
        <Menu
          anchor={menu.anchor}
          align={menu.align}
          onClose={close}
          stayOpenWhen={target => !!document.querySelector('.menu-sub')?.contains(target)}
        >
          {kind === 'attach' && (
            <>
              <MenuLabel>{t('添加')}</MenuLabel>
              <MenuItem
                icon={<Icon name="file" size={14} />}
                hint={t('任意类型')}
                onClick={() => {
                  close();
                  void addAttachments('any');
                }}
              >
                {t('选择文件')}
              </MenuItem>
              <MenuItem
                icon={<Icon name="image" size={14} />}
                hint="png / jpg"
                onClick={() => {
                  close();
                  void addAttachments('image');
                }}
              >
                {t('选择图片')}
              </MenuItem>
              <MenuSep />
              <MenuItem
                icon={<Icon name="spark" size={14} />}
                onClick={() => {
                  close();
                  openSettings('images');
                }}
              >
                {t('图片生成')}
              </MenuItem>
              {attachments.length > 0 && (
                <MenuItem
                  icon={<Icon name="x" size={14} />}
                  tone="danger"
                  onClick={() => {
                    close();
                    clearAttachments();
                  }}
                >
                  {t('清空附件')}
                </MenuItem>
              )}
            </>
          )}

          {/* 权限面板：两档说明 + 切到完全访问的入口 */}
          {kind === 'permission' && (
            <>
              <MenuLabel>{t('权限')}</MenuLabel>
              <MenuItem
                icon={<Icon name="shield" size={14} />}
                picked={!fullAccess}
                hint={t('默认')}
                onClick={() => {
                  close();
                  void saveSettings({ permission: 'approval' });
                }}
              >
                {t('审批')}
              </MenuItem>
              <MenuItem
                icon={<Icon name="alert" size={14} />}
                tone="danger"
                picked={fullAccess}
                onClick={() => {
                  close();
                  setRiskOpen(true);
                }}
              >
                {t('完全访问')}
              </MenuItem>
              <MenuSep />
              <MenuItem
                icon={<Icon name="settings" size={14} />}
                onClick={() => {
                  close();
                  openSettings('approval');
                }}
              >
                {t('权限与审计')}
              </MenuItem>
            </>
          )}

          {/* 识图面板：本机识图是默认能力；下面列出的多模态模型只是可选精度增强 */}
          {kind === 'vision' && (
            <>
              <MenuLabel>{t('识图')}</MenuLabel>
              <div className="menu-note">
                {t('软件内置本机识图已就绪：解码、像素分析、Windows 离线 OCR、生成历史反查，不需要任何配置。下面列出的多模态模型只是可选的精度增强 —— 指定后会在识图结果上再叠加一段画面描述。')}
              </div>
              <MenuItem
                icon={<Icon name="spark" size={14} />}
                picked={!visionTarget?.manual}
                hint={t('默认')}
                onClick={() => {
                  close();
                  pickVision(null);
                }}
              >
                {t('本机识图（默认，无需配置）')}
              </MenuItem>
              <MenuSep />
              <div className="menu-scroll">
                {providers
                  .filter(p => p.enabled && p.models.length > 0)
                  .flatMap(p =>
                    p.models.map(m => {
                      const picked = visionTarget?.manual && visionTarget.providerId === p.id && visionTarget.modelId === m.id;
                      return (
                        <MenuItem
                          key={`${p.id}:${m.id}`}
                          icon={<Icon name="image" size={14} />}
                          picked={picked}
                          hint={m.vision ? t('支持图片') : p.label}
                          onClick={() => {
                            close();
                            pickVision({ providerId: p.id, modelId: m.id });
                          }}
                        >
                          {m.label || m.id}
                        </MenuItem>
                      );
                    }),
                  )}
              </div>
              <MenuSep />
              <MenuItem
                icon={<Icon name="settings" size={14} />}
                onClick={() => {
                  close();
                  openSettings('providers');
                }}
              >
                {t('管理接入项')}
              </MenuItem>
            </>
          )}

          {/* 模型 + 思考强度合并面板（PRD 三） */}
          {kind === 'model' && (
            <>
              <MenuLabel>{t('模型')}</MenuLabel>
              <div className="menu-scroll" ref={modelListRef}>
                {providers
                  .filter(p => p.enabled)
                  .flatMap(p =>
                    p.models.map(m => {
                      const key = `${p.id}:${m.id}`;
                      return (
                        <MenuItem
                          key={key}
                          picked={chatModel?.providerId === p.id && chatModel?.modelId === m.id}
                          hint={p.label}
                          chevron
                          expanded={subKey === key}
                          onClick={() => {
                            // 选完模型面板不关，接着选强度，收起即生效
                            void patchChat({ model: { providerId: p.id, modelId: m.id, label: m.label } });
                          }}
                          onHover={() => {
                            // 锚定整个模型列表（落到列表所在的 .menu 上），让子列表紧贴它的右边缘，
                            // 而不是贴着当前这一行
                            const list = modelListRef.current;
                            const panel = (list?.closest('.menu') as HTMLElement | null) ?? list;
                            setSubAnchor(anchorOf(panel));
                            setSubKey(key);
                          }}
                        >
                          {m.label || m.id}
                        </MenuItem>
                      );
                    }),
                  )}
              </div>
              <MenuSep />
              <MenuLabel>{t('思考强度')}</MenuLabel>
              {THINKING_OPTIONS.map(([value, label, hint]) => (
                <MenuItem
                  key={value}
                  picked={thinking === value}
                  hint={t(hint)}
                  onHover={() => {
                    setSubAnchor(null);
                    setSubKey(null);
                  }}
                  onClick={() => {
                    void patchChat({ thinking: value });
                  }}
                >
                  {label}
                </MenuItem>
              ))}
              <MenuSep />
              <MenuItem
                icon={<Icon name="settings" size={14} />}
                onHover={() => {
                  setSubAnchor(null);
                  setSubKey(null);
                }}
                onClick={() => {
                  close();
                  openSettings('providers');
                }}
              >
                {t('管理接入项')}
              </MenuItem>
            </>
          )}
        </Menu>
      )}

      {/*
        悬停到模型行时，在「整个模型列表」的右侧紧贴着开一个子列表改该会话的上下文长度。
        两个列表同时存在（父列表不再因为子列表而隐藏），子列表是独立 portal，
        父菜单通过 stayOpenWhen 放行对它的点击，避免点一下就把两个都关掉。
      */}
      {menu && kind === 'model' && subAnchor && (
        <Menu
          // key 用当前悬停的模型，换一行就重挂载一次 —— 入场动画重放，
          // 用户能一眼看出「子列表确实跟着我指到的那一行刷新了」。
          key={subKey ?? 'sub'}
          anchor={subAnchor}
          side="right"
          gap={4}
          minWidth={168}
          className="menu-sub"
          onClose={() => {
            setSubAnchor(null);
            setSubKey(null);
          }}
          stayOpenWhen={target => !!document.querySelector('.menu-sub')?.contains(target)}
        >
          <MenuLabel>
            {subModelLabel ? `${t('上下文长度')} · ${subModelLabel}` : t('上下文长度')}
          </MenuLabel>
          {CONTEXT_STEPS.map(step => (
            <MenuItem
              key={String(step.value)}
              picked={contextStep === step.value}
              hint={step.value === 'auto' ? t('跟随模型') : undefined}
              onClick={() => {
                void patchChat({ contextLimit: step.value });
              }}
            >
              {step.label}
            </MenuItem>
          ))}
          <MenuSep />
          <div className="menu-note">
            {t('只影响这个会话的上下文窗口，压缩阈值与进度圆环会跟着变。')}
          </div>
        </Menu>
      )}

      {/* 完全访问的独立风险告知窗（PRD 三） */}
      {riskOpen && (
        <ConfirmDialog
          title={t('开启完全访问？')}
          confirmText={t('我已了解，开启完全访问')}
          cancelText={t('取消')}
          danger
          onCancel={() => setRiskOpen(false)}
          onConfirm={() => {
            setRiskOpen(false);
            void saveSettings({ permission: 'full' });
            toast(t('已开启完全访问'), 'warn');
          }}
        >
          <p className="confirm-para">{t('开启后，NAI WA 可以不经确认直接执行下面这些动作：')}</p>
          <ul className="confirm-list">
            <li>{t('在你选定的工作区内外执行任意终端命令')}</li>
            <li>{t('读写、覆盖、删除磁盘上的任意文件')}</li>
            <li>{t('调用外部 MCP 工具并把结果带回来')}</li>
          </ul>
          <p className="confirm-para dim">{t('所有动作仍会记进「权限与审计」日志，但不再逐条询问。可以随时点输入框里的徽标切回审批模式。')}</p>
        </ConfirmDialog>
      )}

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-box">
            <Icon name="image" size={30} />
            {t('松开即可添加文件')}
            <span className="drop-box-hint">{t('支持一次拖入多个文件')}</span>
          </div>
        </div>
      )}
    </div>
  );
}

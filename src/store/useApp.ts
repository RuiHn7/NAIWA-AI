/* ============================================================================
 * src/store/useApp.ts —— 全局状态（zustand）
 *   · 会话/消息的单一真源，主进程事件在这里合并
 *   · 流式增量按 ~45ms 合并后再 set，避免每个 token 触发一次渲染
 * ==========================================================================*/

import { create } from 'zustand';
import type {
  AgentEvent,
  AppSettings,
  ApprovalRequest,
  Chat,
  ChatMessage,
  ChatSummary,
  ContextUsage,
  McpServerConfig,
  McpServerState,
  ModelRef,
  Persona,
  ProviderConfig,
  ScheduledTask,
  TaskRunRecord,
  ThinkingLevel,
  Workspace,
} from '@shared/types';
import { invoke, on } from '@/lib/bridge';
import { translate } from '@/lib/i18n';
import type { BalanceResult } from '@shared/ipc';

/* ------------------------------------------------------------------ 类型 */

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'ok' | 'warn' | 'error';
}

export interface PendingAttachment {
  id: string;
  name: string;
  path: string;
  mime: string;
  size: number;
  kind: 'image' | 'file';
  preview?: string;
}

export type RightTab = 'files' | 'browser' | null;

/** 请求右栏打开某个文件预览（工具卡里的文本产物点一下就走到这里） */
export interface PreviewRequest {
  path: string;
  name: string;
  /** 同一个文件连点两次也要能重新触发，所以带个自增序号 */
  nonce: number;
}

/** 版本检查结果：侧栏「新版本」胶囊与设置页共用 */
export interface UpdateState {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  url: string | null;
  notes: string | null;
  publishedAt: string | null;
  error: string | null;
  checkedAt: number;
}

/** 应用内确认框请求（替代会阻塞渲染进程的 window.confirm） */
export interface ConfirmRequest {
  id: number;
  title: string;
  body?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  resolve(ok: boolean): void;
}

interface AppState {
  ready: boolean;
  bootError: string | null;

  settings: AppSettings | null;
  providers: ProviderConfig[];
  personas: Persona[];
  workspaces: Workspace[];
  chats: ChatSummary[];
  chat: Chat | null;
  usage: ContextUsage | null;
  /** 当前模型的账户余额（探不到就是 null，界面不显示） */
  balance: BalanceResult | null;

  streamingChatId: string | null;
  pendingApprovals: ApprovalRequest[];
  mcpConfigs: McpServerConfig[];
  mcpStates: McpServerState[];
  tasks: ScheduledTask[];

  attachments: PendingAttachment[];
  toasts: Toast[];
  confirm: ConfirmRequest | null;

  /** 每个会话未发送的草稿（PRD 七.1）：切换会话不丢字 */
  drafts: Record<string, string>;

  rightTab: RightTab;
  /** 右栏待预览的文件（来自工具卡的「在右侧打开」） */
  previewRequest: PreviewRequest | null;
  /** 产物目录的版本号：有新产物落盘就 +1，右栏据此重新扫目录 */
  artifactsVersion: number;
  /** 版本检查结果（启动时自动查一次，设置页/侧栏胶囊共用） */
  update: UpdateState | null;
  settingsOpen: boolean;
  settingsSection: string;
  paletteOpen: boolean;
  searchQuery: string;

  /* actions */
  bootstrap(): Promise<void>;
  reloadChats(): Promise<void>;
  reloadProviders(): Promise<void>;
  reloadPersonas(): Promise<void>;
  reloadWorkspaces(): Promise<void>;
  reloadUsage(chatId?: string): Promise<void>;
  reloadBalance(): Promise<void>;
  reloadApprovals(): Promise<void>;
  reloadMcp(): Promise<void>;
  reloadTasks(): Promise<void>;

  openChat(id: string): Promise<void>;
  newChat(workspaceId?: string | null): Promise<void>;
  deleteChat(id: string): Promise<void>;
  renameChat(id: string, title: string): Promise<void>;
  togglePin(id: string): Promise<void>;
  patchChat(
    patch: Partial<Pick<Chat, 'workspaceId' | 'personaId' | 'model' | 'thinking' | 'contextLimit'>>,
  ): Promise<void>;

  send(text: string): Promise<void>;
  stop(): Promise<void>;
  regenerate(messageId: string): Promise<void>;
  editMessage(messageId: string, content: string): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
  approve(requestId: string, approved: boolean, remember?: boolean): Promise<void>;
  compress(force?: boolean): Promise<void>;

  saveSettings(patch: Partial<AppSettings>): Promise<void>;
  addAttachments(kind: 'any' | 'image'): Promise<void>;
  removeAttachment(id: string): Promise<void>;
  clearAttachments(): void;

  toast(text: string, tone?: Toast['tone']): void;
  dismissToast(id: number): void;

  /** 应用内确认框：返回 Promise<boolean>，不会阻塞渲染进程 */
  askConfirm(input: Omit<ConfirmRequest, 'id' | 'resolve'>): Promise<boolean>;
  settleConfirm(ok: boolean): void;

  setDraft(chatId: string, text: string): void;
  /** 「继续」：把停止时的半截回复续上（PRD 七.2） */
  continueReply(): Promise<void>;

  setRightTab(tab: RightTab): void;
  /** 打开右栏并预览指定文件（文本类产物一键直达） */
  previewFile(path: string, name?: string): void;
  /** 检查新版本；silent = true 时不弹 toast（启动自动检查用） */
  checkUpdate(input?: { silent?: boolean }): Promise<UpdateState | null>;
  dismissUpdate(): void;
  openSettings(section?: string): void;
  closeSettings(): void;
  setPalette(open: boolean): void;
  setSearchQuery(q: string): void;
}

/* ------------------------------------------------------------------ 工具 */

let toastSeq = 0;
/** 右栏预览请求的自增序号：同一个文件连点两次也要能重新触发 */
let previewSeq = 0;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** 把主题档位落到 <html data-theme>。system 时探系统偏好。 */
function applyThemeToDom(mode: AppSettings['theme'] | undefined): void {
  const pref = mode ?? 'system';
  const dark =
    pref === 'dark' ||
    (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

function sortChats(list: ChatSummary[]): ChatSummary[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

/** "1.2.3" / "v1.2.3-beta.1" → [1,2,3]；与主进程 update.ts 的 isNewer 同一套规则 */
function parseVersion(version: string): number[] {
  return version
    .replace(/^v/i, '')
    .split(/[-+]/)[0]
    .split('.')
    .map(n => Number.parseInt(n, 10) || 0);
}

/** a 是否比 b 新 */
function isNewerVersion(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/* ------------------------------------------------------------------ store */

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  bootError: null,

  settings: null,
  providers: [],
  personas: [],
  workspaces: [],
  chats: [],
  chat: null,
  usage: null,
  balance: null,

  streamingChatId: null,
  pendingApprovals: [],
  mcpConfigs: [],
  mcpStates: [],
  tasks: [],

  attachments: [],
  toasts: [],
  confirm: null,

  drafts: {},

  rightTab: null,
  previewRequest: null,
  artifactsVersion: 0,
  update: null,
  settingsOpen: false,
  settingsSection: 'general',
  paletteOpen: false,
  searchQuery: '',

  /* ---------------------------------------------------------------- 启动 */

  async bootstrap() {
    try {
      const [settings, providers, personas, workspaces, chats, approvals] = await Promise.all([
        invoke('settings:get', undefined),
        invoke('provider:list', undefined),
        invoke('persona:list', undefined),
        invoke('workspace:list', undefined),
        invoke('chat:list', undefined),
        invoke('approval:pending', undefined),
      ]);

      set({
        settings,
        providers,
        personas,
        workspaces,
        chats: sortChats(chats),
        pendingApprovals: approvals,
        ready: true,
      });

      // 首帧是 theme-boot.js 按 localStorage 猜的；磁盘上的设置才是真源，
      // 这里对齐一次（设置被外部改过时也不会停在错误主题上）。
      localStorage.setItem('naiwa.theme', settings.theme);
      applyThemeToDom(settings.theme);

      // 恢复上次打开的会话，否则取最近一条，再否则新建
      const remembered = localStorage.getItem('naiwa.lastChat');
      const target = chats.find(c => c.id === remembered) ?? chats[0];
      if (target) {
        await get().openChat(target.id);
      } else {
        await get().newChat(null);
      }

      await get().reloadUsage();
      void get().reloadBalance();
      // 启动自动检查新版本（设置里可关）；失败不打扰，只记录在 update 里
      if (settings.autoUpdate !== false) void get().checkUpdate({ silent: true });
    } catch (err) {
      set({ ready: true, bootError: err instanceof Error ? err.message : String(err) });
    }

    wireEvents();
  },

  /* ---------------------------------------------------------------- 拉取 */

  async reloadChats() {
    const chats = await invoke('chat:list', undefined);
    set({ chats: sortChats(chats) });
  },

  async reloadProviders() {
    const providers = await invoke('provider:list', undefined);
    set({ providers });
  },

  async reloadPersonas() {
    const personas = await invoke('persona:list', undefined);
    set({ personas });
  },

  async reloadWorkspaces() {
    const workspaces = await invoke('workspace:list', undefined);
    set({ workspaces });
  },

  async reloadUsage(chatId) {
    const id = chatId ?? get().chat?.id;
    if (!id) {
      set({ usage: null });
      return;
    }
    try {
      const usage = await invoke('chat:usage', { id });
      set({ usage });
    } catch {
      set({ usage: null });
    }
  },

  async reloadBalance() {
    // 余额探测失败是常态（很多厂商没有公开接口），失败就静默清空
    const model = get().chat?.model;
    const provider = model ? get().providers.find(p => p.id === model.providerId) : get().providers.find(p => p.enabled);
    if (!provider) {
      set({ balance: null });
      return;
    }
    try {
      const res = await invoke('provider:balance', { providerId: provider.id });
      set({ balance: res.ok ? res : null });
    } catch {
      set({ balance: null });
    }
  },

  async reloadApprovals() {    const pendingApprovals = await invoke('approval:pending', undefined);
    set({ pendingApprovals });
  },

  async reloadMcp() {
    const { configs, states } = await invoke('mcp:list', undefined);
    set({ mcpConfigs: configs, mcpStates: states });
  },

  async reloadTasks() {
    const tasks = await invoke('task:list', undefined);
    set({ tasks });
  },

  /* ---------------------------------------------------------------- 会话 */

  async openChat(id) {
    if (get().streamingChatId) await get().stop();
    const chat = await invoke('chat:get', { id });
    if (!chat) return;
    localStorage.setItem('naiwa.lastChat', id);
    set({ chat, attachments: [], usage: null });
    await get().reloadUsage(id);
    void get().reloadBalance();
  },

  async newChat(workspaceId) {
    const current = get().chat;
    const targetWs = workspaceId ?? null;
    // 空白会话去重（PRD 4.2）：当前已经是没发过消息的会话，就复用它，不再另开一个空壳。
    // 但「复用」前必须真的确认它还在磁盘上 —— 只信内存里的 chats 列表会踩到
    // 「会话被删了但列表没刷新 → 点新对话什么都不发生」的死角。
    const stillThere = current ? await invoke('chat:get', { id: current.id }) : null;
    const reusable =
      !!current &&
      !!stillThere &&
      current.messages.length === 0 &&
      (current.workspaceId ?? null) === targetWs;
    if (reusable && current) {
      localStorage.setItem('naiwa.lastChat', current.id);
      // 顺便把列表刷一遍：若它是刚从别处删完残留的空壳，这里能立刻补进侧栏
      if (!get().chats.some(c => c.id === current.id)) await get().reloadChats();
      return;
    }
    if (get().streamingChatId) await get().stop();
    // 从工作区入口建会话时要求立刻落进 `<workspace>/chats/`，而不是等第一条消息才建目录。
    const chat = await invoke('chat:create', {
      workspaceId: workspaceId ?? null,
      ensureFolder: Boolean(workspaceId),
    });
    set({ chat, attachments: [], usage: null });
    localStorage.setItem('naiwa.lastChat', chat.id);
    await get().reloadChats();
    await get().reloadUsage(chat.id);
    void get().reloadBalance();
  },

  async deleteChat(id) {
    const target = get().chats.find(c => c.id === id);
    await invoke('chat:delete', { id, withFolder: Boolean(target?.folder) });
    const chats = sortChats(await invoke('chat:list', undefined));
    set({ chats });
    if (get().chat?.id === id) {
      const next = chats[0];
      if (next) await get().openChat(next.id);
      else await get().newChat(null);
    }
  },

  async renameChat(id, title) {
    const trimmed = title.trim();
    if (!trimmed) return;
    await invoke('chat:update', { id, patch: { title: trimmed, renamed: true } });
    const chat = get().chat;
    if (chat && chat.id === id) set({ chat: { ...chat, title: trimmed, renamed: true } });
    await get().reloadChats();
  },

  async togglePin(id) {
    const summary = get().chats.find(c => c.id === id);
    const pinned = !(summary?.pinned ?? false);
    await invoke('chat:update', { id, patch: { pinned } });
    const chat = get().chat;
    if (chat && chat.id === id) set({ chat: { ...chat, pinned } });
    await get().reloadChats();
  },

  async patchChat(patch) {
    const chat = get().chat;
    if (!chat) return;
    const next = await invoke('chat:update', { id: chat.id, patch });
    set({ chat: next });
    await get().reloadChats();
    // 改上下文长度 / 模型会直接影响进度圆环的分母
    if ('contextLimit' in patch || 'model' in patch || 'thinking' in patch) void get().reloadUsage(chat.id);
    // 换模型等于换账号，余额要跟着重新探一次
    if ('model' in patch) void get().reloadBalance();
  },

  /* ---------------------------------------------------------------- 发送 */

  async send(text) {
    const chat = get().chat;
    if (!chat) return;
    const trimmed = text.trim();
    if (!trimmed && get().attachments.length === 0) return;

    const paths = get().attachments.map(a => a.path);
    set({ attachments: [] });
    // 发出去就清掉这个会话的草稿（PRD 七.1）
    const drafts = { ...get().drafts };
    delete drafts[chat.id];
    set({ drafts });

    const result = await invoke('agent:send', {
      chatId: chat.id,
      text: trimmed,
      attachmentPaths: paths,
      thinking: chat.thinking,
      personaId: chat.personaId,
    });

    if (!result.ok && result.error) {
      get().toast(result.error.message, 'error');
    }
  },

  async continueReply() {
    const chat = get().chat;
    if (!chat || !chat.messages.length) return;
    // 把最后一条助手消息的已生成内容当作上下文，让它接着写。
    const last = [...chat.messages].reverse().find(m => m.role === 'assistant');
    const tail = last?.content?.slice(-600) ?? '';
    const locale = get().settings?.locale;
    await get().send(
      tail
        ? translate('继续。上一次回复停在下面这段，从断点往后接着写，不要重复已经写过的内容：', locale) +
            `\n\n${tail}`
        : translate('继续。', locale),
    );
  },

  async stop() {
    const id = get().streamingChatId ?? get().chat?.id;
    if (!id) return;
    await invoke('agent:stop', { chatId: id });
  },

  async regenerate(messageId) {
    const chat = get().chat;
    if (!chat) return;
    const result = await invoke('agent:regenerate', { chatId: chat.id, messageId });
    if (!result.ok && result.error) get().toast(result.error.message, 'error');
  },

  async editMessage(messageId, content) {
    const chat = get().chat;
    if (!chat) return;
    const next = await invoke('chat:message-edit', { chatId: chat.id, messageId, content });
    set({ chat: next });
    await get().reloadChats();
  },

  async deleteMessage(messageId) {
    const chat = get().chat;
    if (!chat) return;
    const next = await invoke('chat:message-delete', { chatId: chat.id, messageId });
    set({ chat: next });
    await get().reloadChats();
    await get().reloadUsage(chat.id);
  },

  async approve(requestId, approved, remember) {
    await invoke('agent:approve', { requestId, approved, remember });
    const pendingApprovals = get().pendingApprovals.filter(r => r.id !== requestId);
    set({ pendingApprovals });
  },

  async compress(force) {
    const chat = get().chat;
    if (!chat) return;
    const usage = await invoke('chat:compress', { id: chat.id, force: force ?? true });
    set({ usage });
    const next = await invoke('chat:get', { id: chat.id });
    if (next) set({ chat: next });
    if (usage.compressed > 0) get().toast(`已压缩前 ${usage.compressed} 条消息`, 'ok');
    else get().toast('消息还不够多，暂时不需要压缩', 'info');
  },

  /* ---------------------------------------------------------------- 设置 */

  async saveSettings(patch) {
    const settings = await invoke('settings:save', patch);
    set({ settings });
    if (patch.theme) {
      localStorage.setItem('naiwa.theme', patch.theme);
      applyThemeToDom(patch.theme);
    }
  },

  async addAttachments(kind) {
    const files = await invoke('dialog:pick-files', { kind });
    if (!files.length) return;
    const merged = [...get().attachments];
    for (const f of files) {
      if (merged.some(m => m.path === f.path)) continue;
      merged.push(f);
    }
    set({ attachments: merged });
  },

  async removeAttachment(id) {
    set({ attachments: get().attachments.filter(a => a.id !== id) });
  },

  clearAttachments() {
    set({ attachments: [] });
  },

  /* ---------------------------------------------------------------- 杂项 */

  toast(text, tone = 'info') {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, text, tone }] });
    setTimeout(() => get().dismissToast(id), 3200);
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter(t => t.id !== id) });
  },

  askConfirm(input) {
    // 正在显示上一个确认框时先按取消收尾，避免请求被吞掉
    get().confirm?.resolve(false);
    return new Promise<boolean>(resolve => {
      set({ confirm: { ...input, id: ++toastSeq, resolve } });
    });
  },

  settleConfirm(ok) {
    const cur = get().confirm;
    if (!cur) return;
    set({ confirm: null });
    cur.resolve(ok);
  },

  setDraft(chatId, text) {
    set({ drafts: { ...get().drafts, [chatId]: text } });
  },

  setRightTab(tab) {
    set({ rightTab: tab });
  },

  previewFile(filePath, name) {
    const label = name ?? filePath.split(/[\\/]/).pop() ?? filePath;
    previewSeq += 1;
    set({ rightTab: 'files', previewRequest: { path: filePath, name: label, nonce: previewSeq } });
  },

  async checkUpdate(input) {
    const silent = input?.silent ?? false;
    try {
      const res = await invoke('app:check-update', undefined);
      const current = res.current;
      const latest = res.latest ?? null;
      const hasUpdate = !!latest && isNewerVersion(latest, current);
      const state: UpdateState = {
        current,
        latest,
        hasUpdate,
        url: res.url ?? null,
        notes: res.notes ?? null,
        publishedAt: res.publishedAt ?? null,
        error: res.ok ? null : (res.reason ?? '检查失败'),
        checkedAt: Date.now(),
      };
      set({ update: state });
      if (!silent) {
        if (state.error) get().toast(state.error, 'error');
        else if (hasUpdate) get().toast(`${'发现新版本'} ${latest}`, 'ok');
        else get().toast('已经是最新版本', 'ok');
      }
      return state;
    } catch (err) {
      const state: UpdateState = {
        current: get().update?.current ?? '',
        latest: null,
        hasUpdate: false,
        url: null,
        notes: null,
        publishedAt: null,
        error: err instanceof Error ? err.message : String(err),
        checkedAt: Date.now(),
      };
      set({ update: state });
      if (!silent) get().toast(state.error ?? '检查更新失败', 'error');
      return state;
    }
  },

  dismissUpdate() {
    set(s => (s.update ? { update: { ...s.update, hasUpdate: false } } : {}));
  },

  openSettings(section) {
    set({ settingsOpen: true, settingsSection: section ?? 'general' });
  },

  closeSettings() {
    set({ settingsOpen: false });
  },

  setPalette(open) {
    set({ paletteOpen: open });
  },

  setSearchQuery(q) {
    set({ searchQuery: q });
  },
}));

/* ============================================================================
 * 事件接线 —— 与主进程的 AgentEvent 流对接
 * 为了满足「流式节流」要求，content/reasoning 增量先落缓冲，45ms 合并一次。
 * ==========================================================================*/

type SetPartial = (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void;

let wired = false;

function wireEvents() {
  if (wired) return;
  wired = true;

  const set = useApp.setState as unknown as SetPartial;
  const get = useApp.getState;

  /* ------------------------------------------------ 流式缓冲 */
  let bufContent = '';
  let bufReasoning = '';
  let bufChatId = '';
  let bufMsgId = '';
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    if (!bufChatId || !bufMsgId) return;
    const content = bufContent;
    const reasoning = bufReasoning;
    bufContent = '';
    bufReasoning = '';
    if (!content && !reasoning) return;

    set(s => {
      const chat = s.chat;
      if (!chat || chat.id !== bufChatId) return {};
      const idx = chat.messages.findIndex(m => m.id === bufMsgId);
      if (idx < 0) return {};
      const prev = chat.messages[idx];
      const next: ChatMessage = {
        ...prev,
        content: prev.content + content,
        reasoning: reasoning ? (prev.reasoning ?? '') + reasoning : prev.reasoning,
      };
      const messages = chat.messages.slice();
      messages[idx] = next;
      return { chat: { ...chat, messages } };
    });
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(flush, 45);
  };

  const patchMessage = (chatId: string, messageId: string, patch: (m: ChatMessage) => ChatMessage) => {
    set(s => {
      const chat = s.chat;
      if (!chat || chat.id !== chatId) return {};
      const idx = chat.messages.findIndex(m => m.id === messageId);
      if (idx < 0) return {};
      const messages = chat.messages.slice();
      messages[idx] = patch(chat.messages[idx]);
      return { chat: { ...chat, messages } };
    });
  };

  /* ------------------------------------------------ agent:event */
  on('agent:event', (event: AgentEvent) => {
    const state = get();
    const isActive = state.chat?.id === event.chatId;

    switch (event.type) {
      case 'chat-start': {
        if (!isActive) return;
        set({
          streamingChatId: event.chatId,
          pendingApprovals: [],
        });
        void (async () => {
          const fresh = await invoke('chat:get', { id: event.chatId });
          if (fresh && get().chat?.id === fresh.id) set({ chat: fresh });
        })();
        return;
      }

      case 'reasoning-delta': {
        if (!isActive) return;
        bufChatId = event.chatId;
        bufMsgId = event.messageId;
        bufReasoning += event.delta;
        schedule();
        return;
      }

      case 'content-delta': {
        if (!isActive) return;
        bufChatId = event.chatId;
        bufMsgId = event.messageId;
        bufContent += event.delta;
        schedule();
        return;
      }

      case 'plan': {
        if (!isActive) return;
        patchMessage(event.chatId, event.messageId, m => ({ ...m, plan: event.plan }));
        return;
      }

      case 'plan-step': {
        if (!isActive) return;
        patchMessage(event.chatId, event.messageId, m => {
          if (!m.plan) return m;
          return {
            ...m,
            plan: {
              ...m.plan,
              steps: m.plan.steps.map(s =>
                s.id === event.stepId ? { ...s, status: event.status, note: event.note ?? s.note } : s,
              ),
            },
          };
        });
        return;
      }

      case 'tool-call': {
        if (!isActive) return;
        patchMessage(event.chatId, event.messageId, m => ({
          ...m,
          toolCalls: [...(m.toolCalls ?? []), event.call],
        }));
        return;
      }

      case 'tool-update': {
        if (!isActive) return;
        patchMessage(event.chatId, event.messageId, m => ({
          ...m,
          toolCalls: (m.toolCalls ?? []).map(c => (c.id === event.call.id ? event.call : c)),
        }));
        return;
      }

      case 'approval': {
        set(s => ({ pendingApprovals: [...s.pendingApprovals.filter(r => r.id !== event.request.id), event.request] }));
        return;
      }

      case 'usage': {
        if (!isActive) return;
        patchMessage(event.chatId, event.messageId, m => ({ ...m, usage: event.usage }));
        void get().reloadUsage(event.chatId);
        return;
      }

      case 'title': {
        set(s => ({
          chats: sortChats(s.chats.map(c => (c.id === event.chatId ? { ...c, title: event.title } : c))),
          chat: s.chat && s.chat.id === event.chatId ? { ...s.chat, title: event.title } : s.chat,
        }));
        return;
      }

      case 'compressed': {
        get().toast(`已压缩前 ${event.dropped} 条消息为摘要`, 'ok');
        void get().reloadUsage(event.chatId);
        return;
      }

      case 'artifact': {
        if (!isActive) return;
        const name = event.path.split(/[\\/]/).pop() ?? event.path;
        // 图片已经在工具卡里内联显示了，再弹 toast 只是噪音
        if (!/\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i.test(event.path)) {
          get().toast(`已生成文件：${name}`, 'ok');
        }
        // 产物落盘了 → 让右栏「本会话产物」重新扫一次目录
        set(s => ({ artifactsVersion: s.artifactsVersion + 1 }));
        void (async () => {
          const fresh = await invoke('chat:get', { id: event.chatId });
          if (fresh && get().chat?.id === fresh.id) set({ chat: fresh });
        })();
        return;
      }

      case 'chat-end': {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        bufContent = '';
        bufReasoning = '';
        if (isActive) patchMessage(event.chatId, event.messageId, m => ({ ...m, status: event.status, error: event.error }));
        set(s => ({ streamingChatId: s.streamingChatId === event.chatId ? null : s.streamingChatId }));
        // 一轮结束：write_file / edit_patch 这类工具不一定会发 artifact 事件，
        // 但文件确实已经落盘了，所以这里也推进一次产物版本号让右栏重扫。
        set(s => ({ artifactsVersion: s.artifactsVersion + 1 }));
        void (async () => {
          const fresh = await invoke('chat:get', { id: event.chatId });
          if (fresh && get().chat?.id === fresh.id) set({ chat: fresh });
          await get().reloadChats();
          if (event.status === 'error' && event.error) get().toast(event.error, 'error');
        })();
        return;
      }

      default:
        return;
    }
  });

  /* ------------------------------------------------ 其它事件 */
  on('approval:request', (req: ApprovalRequest) => {
    set(s => ({ pendingApprovals: [...s.pendingApprovals.filter(r => r.id !== req.id), req] }));
  });

  on('approval:resolved', ({ id }) => {
    set(s => ({ pendingApprovals: s.pendingApprovals.filter(r => r.id !== id) }));
  });

  on('settings:changed', (settings: AppSettings) => {
    set({ settings });
    // 设置可能来自别的窗口或主进程自身（比如托盘菜单），这里必须重算 DOM 主题，
    // 否则 data-theme 会停在旧值 —— 打包版实测踩到过。
    applyThemeToDom(settings.theme);
  });

  on('theme:changed', ({ shouldUseDarkColors }) => {
    const mode = get().settings?.theme ?? 'system';
    if (mode !== 'system') return;
    document.documentElement.dataset.theme = shouldUseDarkColors ? 'dark' : 'light';
  });

  on('mcp:state', (state: McpServerState) => {
    set(s => ({
      mcpStates: s.mcpStates.some(x => x.id === state.id)
        ? s.mcpStates.map(x => (x.id === state.id ? state : x))
        : [...s.mcpStates, state],
    }));
  });

  on('task:completed', ({ task, record }: { task: ScheduledTask; record: TaskRunRecord }) => {
    get().toast(`定时任务「${task.name}」${record.status === 'success' ? '已完成' : '执行失败'}`, record.status === 'success' ? 'ok' : 'error');
    void get().reloadTasks();
  });

  on('nav:command', ({ command }) => {
    switch (command) {
      case 'new-chat':
        void get().newChat(null);
        return;
      case 'settings':
        get().openSettings('general');
        return;
      case 'command-palette':
        get().setPalette(true);
        return;
      case 'stop':
        void get().stop();
        return;
      case 'export':
        void (async () => {
          const chat = get().chat;
          if (!chat) return;
          const res = await invoke('chat:export', { id: chat.id, format: 'md' });
          if (res) get().toast(`已导出到 ${res.path}`, 'ok');
        })();
        return;
      default:
        return;
    }
  });

  // 兜底：主进程可能在窗口重载后已经进入流式状态
  void sleep(0).then(() => {
    void get().reloadApprovals();
  });
}

/* ------------------------------------------------------------------ 选择器 */

/**
 * 注意：这个选择器必须返回**引用稳定**的值。
 * zustand v5 用 useSyncExternalStore，选择器每次返回新对象会被判定为快照变化，
 * 触发无限重渲染（React error #185）。因此这里用一个按 key 复用的缓存。
 */
let pickedModelKey = '';
let pickedModel: ModelRef | null = null;

export const selectActiveModel = (s: AppState): ModelRef | null => {
  const chat = s.chat;
  if (chat?.model) return chat.model;

  const first = s.providers.find(p => p.enabled && p.models.length > 0);
  if (!first) {
    pickedModelKey = '';
    pickedModel = null;
    return null;
  }
  const model = first.models[0];
  const key = `${first.id}::${model.id}::${model.label}`;
  if (key !== pickedModelKey) {
    pickedModelKey = key;
    pickedModel = { providerId: first.id, modelId: model.id, label: model.label };
  }
  return pickedModel;
};

export const selectThinking = (s: AppState): ThinkingLevel => s.chat?.thinking ?? s.settings?.defaultThinking ?? 'high';

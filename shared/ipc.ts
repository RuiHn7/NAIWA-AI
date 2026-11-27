/* ============================================================================
 * shared/ipc.ts —— 类型安全的 IPC 契约
 *   · InvokeMap：渲染进程 request → 主进程 handle（有返回值）
 *   · EventMap ：主进程 → 渲染进程推送
 * 任何 IPC 通道都必须先在这里登记，preload 只按这张表暴露白名单。
 * ==========================================================================*/

import type {
  AgentEvent,
  AppSettings,
  ApprovalRequest,
  AuditEntry,
  Chat,
  ChatSummary,
  ContextUsage,
  GeneratedImage,
  ImageProviderConfig,
  McpServerConfig,
  McpServerState,
  MemoryEntry,
  Persona,
  ProviderConfig,
  ProviderKind,
  RemoteModel,
  ScheduledTask,
  TaskRunRecord,
  ThinkingLevel,
  UsageRecord,
  VlmProgress,
  VlmStatus,
  Workspace,
  WorkspaceFile,
} from './types';

export interface PullModelsInput {
  /** 已保存的接入项 id；未保存的草稿不传，仅靠 kind + baseUrl + apiKey 拉取 */
  providerId?: string;
  /** 草稿阶段也要能判断协议；已保存时省略则回落到 provider.kind */
  kind?: ProviderKind;
  baseUrl: string;
  /** 新填的 Key（未保存时用它试探） */
  apiKey?: string;
}

export type PullModelsResult =
  | { ok: true; models: RemoteModel[] }
  | { ok: false; kind: 'network' | 'auth' | 'endpoint' | 'parse' | 'unknown'; message: string };

export interface TestProviderInput {
  providerId?: string;
  kind?: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export type TestProviderResult =
  | { ok: true; ms: number; reply: string; usage?: { promptTokens: number; completionTokens: number } }
  | { ok: false; kind: 'network' | 'auth' | 'endpoint' | 'parse' | 'timeout' | 'unknown'; message: string; ms: number };

/** 账户余额探测：只有部分厂商提供公开接口，探测不到就返回 ok:false */
export interface BalanceInput {
  providerId?: string;
  kind?: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
}

export interface BalanceResult {
  ok: boolean;
  /** 展示用金额文本，如「¥ 12.34」 */
  display?: string;
  /** 原币种代码，如 CNY / USD */
  currency?: string;
  /** 余额数值 */
  total?: number;
  /** 赠金 / 充值余额（部分厂商提供） */
  granted?: number;
  toppedUp?: number;
  /** 探测到的接口路径，便于排查 */
  endpoint?: string;
  checkedAt: number;
  reason?: string;
}

export interface SendMessageInput {
  chatId: string;
  text: string;
  attachmentPaths: string[];
  /** 覆盖会话默认模型 */
  model?: { providerId: string; modelId: string } | null;
  thinking?: ThinkingLevel;
  personaId?: string | null;
}

export interface SendMessageResult {
  ok: boolean;
  error?: { kind: 'network' | 'auth' | 'rate-limit' | 'timeout' | 'no-provider' | 'unknown'; message: string };
}

export interface GenerateImageInput {
  prompt: string;
  negativePrompt?: string;
  size: string;
  count: number;
  style: string;
  providerId: string;
  workspaceId: string | null;
  /** 当前会话的磁盘文件夹：有值时产物落 `<会话目录>/artifacts/images` */
  chatFolder?: string | null;
  /** 发起生成的会话 id，记进历史，右栏可按会话过滤 */
  chatId?: string | null;
}

export interface SaveSettingsInput extends Partial<AppSettings> {}

/** 渲染进程可调用的全部通道 */
export interface InvokeMap {
  /* -------------------------------------------------- 应用与设置 */
  'app:info': {
    req: void;
    res: {
      version: string;
      platform: string;
      userData: string;
      runtime: { python: string | null; node: string | null };
      locale: string;
    };
  };
  'settings:get': { req: void; res: AppSettings };
  'settings:save': { req: SaveSettingsInput; res: AppSettings };
  /** 手动检查更新：默认读 GitHub RuiHn7/NAIWA-AI 的 release / tag / package.json */
  'app:check-update': {
    req: void;
    res: {
      ok: boolean;
      current: string;
      latest?: string;
      url?: string;
      reason?: string;
      publishedAt?: string;
      notes?: string;
      source?: 'release' | 'tag' | 'package' | 'manifest';
      installer?: { name: string; url: string; size: number; sha256?: string };
    };
  };
  /** 下载新版本安装包到临时目录（进度走 update:progress 事件） */
  'update:download': {
    req: { name: string; url: string; size?: number; sha256?: string };
    res: { ok: boolean; path?: string; error?: string; canceled?: boolean };
  };
  /** 停止正在进行的下载（已下载的分块保留，可继续） */
  'update:cancel': { req: void; res: { ok: boolean; canceled: boolean } };
  /** 删除该安装包的下载文件与分块进度（重新下载用） */
  'update:reset': { req: { name: string }; res: { ok: boolean; removed: number } };
  /** 启动安装程序并退出应用 */
  'update:install': { req: { path: string }; res: { ok: boolean; error?: string } };
  /** 选择新的会话默认存放位置（返回选中的绝对路径） */
  'settings:pick-chat-root': { req: void; res: { path: string } | null };
  /** 把已有会话文件夹迁移到新的根目录 */
  'settings:migrate-chat-root': {
    req: { from: string; to: string };
    res: { moved: number; failed: { id: string; error: string }[] };
  };

  /* -------------------------------------------------- 窗口控制 */
  'window:minimize': { req: void; res: void };
  'window:toggle-maximize': { req: void; res: { maximized: boolean } };
  'window:close': { req: void; res: void };
  'window:state': { req: void; res: { maximized: boolean; fullscreen: boolean } };

  /* -------------------------------------------------- 接入与模型 */
  'provider:list': { req: void; res: ProviderConfig[] };
  'provider:save': {
    req: {
      id?: string;
      kind: ProviderConfig['kind'];
      label: string;
      baseUrl: string;
      apiKey?: string;
      defaultThinking: ThinkingLevel;
      enabled: boolean;
      models?: RemoteModel[];
      thinkingBudget?: ProviderConfig['thinkingBudget'];
    };
    res: ProviderConfig;
  };
  'provider:delete': { req: { id: string }; res: void };
  'provider:pull-models': { req: PullModelsInput; res: PullModelsResult };
  /** 试跑一次最小请求，确认地址/Key/模型是否真的能用 */
  'provider:test': { req: TestProviderInput; res: TestProviderResult };
  /** 查一次账户余额（厂商没有公开接口时返回 ok:false + reason） */
  'provider:balance': { req: BalanceInput; res: BalanceResult };
  'provider:set-models': { req: { id: string; models: RemoteModel[] }; res: ProviderConfig };

  /* -------------------------------------------------- 会话 */
  'chat:list': { req: void; res: ChatSummary[] };
  'chat:get': { req: { id: string }; res: Chat | null };
  /**
   * 新建会话。ensureFolder = true 时立刻在目标工作区下建好 `<workspace>/chats/<时间戳>` 目录，
   * 用于「工作区右键 → 创建新对话」这种「一开始就必须落在工作区文件夹里」的入口。
   */
  'chat:create': { req: { workspaceId?: string | null; ensureFolder?: boolean }; res: Chat };
  'chat:update': {
    req: {
      id: string;
      patch: Partial<
        Pick<
          Chat,
          'title' | 'renamed' | 'workspaceId' | 'personaId' | 'model' | 'thinking' | 'pinned' | 'folder' | 'contextLimit'
        >
      >;
    };
    res: Chat;
  };
  'chat:delete': { req: { id: string; withFolder?: boolean }; res: { ok: boolean; folder: string | null } };
  /** 在资源管理器中查看会话文件夹（空白会话会先建目录） */
  'chat:reveal': { req: { id: string }; res: { folder: string | null; error?: string } };
  /** 列出本会话文件夹里的产物（artifacts / files / exports）；无 folder 时返回空列表 */
  'chat:artifacts': { req: { id: string }; res: { folder: string | null; items: WorkspaceFile[] } };
  /** 把磁盘文件夹名同步成当前会话标题（只在用户显式请求时调用） */
  'chat:rename-folder': { req: { id: string }; res: { folder: string | null; error: string | null } };
  /** 把会话移动到另一个工作区（null = 移出工作区回到默认根目录），磁盘文件夹一并迁移 */
  'chat:move-to-workspace': {
    req: { id: string; workspaceId: string | null };
    res: { chat: Chat; moved: boolean; from: string | null; to: string | null; error?: string };
  };
  'chat:search': { req: { query: string }; res: ChatSummary[] };
  'chat:usage': { req: { id: string }; res: ContextUsage };
  'chat:compress': { req: { id: string; force?: boolean }; res: ContextUsage };
  'chat:export': { req: { id: string; format: 'md' | 'json' | 'html' }; res: { path: string } | null };
  'chat:message-delete': { req: { chatId: string; messageId: string }; res: Chat };
  'chat:message-edit': { req: { chatId: string; messageId: string; content: string }; res: Chat };

  /* -------------------------------------------------- Agent */
  'agent:send': { req: SendMessageInput; res: SendMessageResult };
  'agent:stop': { req: { chatId: string }; res: void };
  'agent:regenerate': { req: { chatId: string; messageId: string }; res: SendMessageResult };
  'agent:approve': { req: { requestId: string; approved: boolean; remember?: boolean }; res: void };

  /* -------------------------------------------------- 工作区 */
  'workspace:list': { req: void; res: Workspace[] };
  'workspace:create': { req: { name: string; path: string }; res: Workspace };
  'workspace:update': { req: { id: string; patch: { name?: string } }; res: Workspace };
  'workspace:delete': { req: { id: string; deleteFolder: boolean }; res: void };
  'workspace:files': { req: { id: string }; res: WorkspaceFile[] };
  'workspace:open-folder': { req: { id: string }; res: void };
  'workspace:open-path': { req: { path: string }; res: void };
  'workspace:read-file': { req: { path: string }; res: { ok: boolean; text?: string; dataUrl?: string; error?: string } };
  'workspace:pick-folder': { req: void; res: { path: string } | null };
  'workspace:assign-chat': { req: { chatId: string; workspaceId: string | null }; res: Chat };

  /* -------------------------------------------------- 记忆 */
  'memory:list': { req: { layer?: string; workspaceId?: string; chatId?: string }; res: MemoryEntry[] };
  'memory:add': {
    req: { layer: MemoryEntry['layer']; content: string; workspaceId?: string; chatId?: string; tags?: string[] };
    res: MemoryEntry;
  };
  'memory:update': { req: { id: string; content: string; tags?: string[] }; res: MemoryEntry };
  'memory:delete': { req: { id: string }; res: void };

  /* -------------------------------------------------- 人格 */
  'persona:list': { req: void; res: Persona[] };
  'persona:save': { req: { id?: string; name: string; icon: string; systemPrompt: string }; res: Persona };
  'persona:delete': { req: { id: string }; res: void };

  /* -------------------------------------------------- 内置本地视觉模型 */
  /** 运行时 / 模型 / 服务当前状态 */
  'vlm:status': { req: void; res: VlmStatus };
  /** 下载模型（进度走 vlm:progress 事件，可取消，已下载部分保留） */
  'vlm:download': { req: void; res: { ok: boolean; canceled?: boolean; error?: string } };
  'vlm:cancel': { req: void; res: { ok: boolean; canceled: boolean } };
  /** 删除已下载的模型释放空间（不影响运行时） */
  'vlm:delete': { req: void; res: { ok: boolean; removed: number } };
  /** 预热：提前把模型加载到显存，第一张图不用等 */
  'vlm:warmup': { req: void; res: { ok: boolean; ms?: number; error?: string } };
  'vlm:stop': { req: void; res: void };

  /* -------------------------------------------------- 图片生成 */
  'image:providers': { req: void; res: ImageProviderConfig[] };
  'image:save-provider': {
    req: { id?: string; kind: ImageProviderConfig['kind']; label: string; baseUrl: string; apiKey?: string; enabled: boolean };
    res: ImageProviderConfig;
  };
  'image:delete-provider': { req: { id: string }; res: void };
  'image:generate': { req: GenerateImageInput; res: { ok: boolean; images?: GeneratedImage[]; error?: string } };
  'image:history': { req: { workspaceId?: string | null; chatId?: string | null }; res: GeneratedImage[] };

  /* -------------------------------------------------- 审批与审计 */
  'approval:pending': { req: void; res: ApprovalRequest[] };
  'audit:list': { req: { limit?: number }; res: AuditEntry[] };

  /* -------------------------------------------------- 用量 */
  'usage:list': { req: void; res: UsageRecord[] };
  'usage:clear': { req: void; res: void };

  /* -------------------------------------------------- MCP */
  'mcp:list': { req: void; res: { configs: McpServerConfig[]; states: McpServerState[] } };
  'mcp:save': {
    req: {
      id?: string;
      name: string;
      transport: 'stdio' | 'http';
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      enabled: boolean;
    };
    res: McpServerConfig;
  };
  'mcp:delete': { req: { id: string }; res: void };
  'mcp:connect': { req: { id: string }; res: McpServerState };
  'mcp:disconnect': { req: { id: string }; res: void };
  'mcp:import': { req: { json: string }; res: { imported: number; errors: string[] } };
  'mcp:set-tool': { req: { serverId: string; tool: string; enabled: boolean }; res: McpServerState };

  /* -------------------------------------------------- 定时任务 */
  'task:list': { req: void; res: ScheduledTask[] };
  'task:save': { req: Partial<ScheduledTask> & { name: string; prompt: string }; res: ScheduledTask };
  'task:delete': { req: { id: string }; res: void };
  'task:toggle': { req: { id: string; enabled: boolean }; res: ScheduledTask };
  'task:run-now': { req: { id: string }; res: TaskRunRecord };
  'task:resolve-missed': { req: { id: string; run: boolean }; res: void };

  /* -------------------------------------------------- 系统 */
  'shell:open-external': { req: { url: string }; res: void };
  'dialog:pick-files': { req: { kind: 'any' | 'image' }; res: { id: string; name: string; path: string; mime: string; size: number; kind: 'image' | 'file'; preview?: string }[] };
  /** 拖拽 / 粘贴进来的文件：渲染层只拿得到 File，先由 preload 换成绝对路径再交给这里 */
  'dialog:describe-files': { req: { paths: string[] }; res: { id: string; name: string; path: string; mime: string; size: number; kind: 'image' | 'file'; preview?: string }[] };
  /** 没有磁盘路径的文件（粘贴的截图、从浏览器拖进来的虚拟文件）：把字节交上来，落盘再当附件 */
  'dialog:import-files': { req: { files: { name: string; mime?: string; data: Uint8Array }[] }; res: { id: string; name: string; path: string; mime: string; size: number; kind: 'image' | 'file'; preview?: string }[] };
  'notification:show': { req: { title: string; body: string }; res: void };
}

/** 主进程推送给渲染进程的事件 */
export interface EventMap {
  'agent:event': AgentEvent;
  'approval:request': ApprovalRequest;
  'approval:resolved': { id: string; approved: boolean };
  'settings:changed': AppSettings;
  'update:progress': {
    phase: 'probing' | 'downloading' | 'verifying' | 'done';
    received: number;
    total: number;
    percent: number;
    speed?: number;
    source?: string;
    sources?: number;
  };
  'theme:changed': { shouldUseDarkColors: boolean };
  'vlm:progress': VlmProgress;
  'mcp:state': McpServerState;
  'task:completed': { task: ScheduledTask; record: TaskRunRecord };
  'nav:command': { command: 'new-chat' | 'export' | 'command-palette' | 'stop' | 'settings' };
  'window:state': { maximized: boolean; fullscreen: boolean };
}

export type InvokeChannel = keyof InvokeMap;
export type EventChannel = keyof EventMap;

/** preload 暴露到 window.naiwa 的 API 形状 */
export interface NaiwaApi {
  invoke<K extends InvokeChannel>(channel: K, payload: InvokeMap[K]['req']): Promise<InvokeMap[K]['res']>;
  on<K extends EventChannel>(channel: K, handler: (payload: EventMap[K]) => void): () => void;
  platform: string;
  /**
   * 把拖拽 / 粘贴进来的 File 换成磁盘绝对路径（Electron 32+ 移除了 File.path，
   * 只剩 webUtils.getPathForFile）。拿不到路径（例如纯内存文件）时返回空字符串。
   */
  pathForFile(file: unknown): string;
}

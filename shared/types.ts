/* ============================================================================
 * shared/types.ts —— 主进程与渲染进程共用的领域模型
 * 所有跨进程的数据结构都在这里定义，IPC 层只搬运这些类型。
 * ==========================================================================*/

export type ThinkingLevel = 'low' | 'high' | 'max';
export type PermissionMode = 'approval' | 'full';
export type ThemeMode = 'system' | 'dark' | 'light';
export type Locale = 'zh-CN' | 'en-US';

/* --------------------------------------------------------------- 接入与模型 */

export type ProviderKind = 'openai' | 'anthropic' | 'gemini';

export interface RemoteModel {
  id: string;
  label: string;
  /** 上下文窗口（tokens），未知时按 32k 估算 */
  contextWindow: number;
  /** 是否为视觉模型 */
  vision?: boolean;
  /** 是否为推理模型（支持 reasoning / thinking） */
  reasoning?: boolean;
}

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  /** 是否已保存 API Key（真实值只存在于主进程 safeStorage 加密文件里） */
  hasKey: boolean;
  /** 已拉取并勾选可用的模型 */
  models: RemoteModel[];
  /** 该接入项默认思考强度 */
  defaultThinking: ThinkingLevel;
  /** 思考强度映射（可选，覆盖默认推理预算） */
  thinkingBudget?: Partial<Record<ThinkingLevel, number>>;
  enabled: boolean;
  createdAt: number;
}

export interface ModelRef {
  providerId: string;
  modelId: string;
  /** 展示用，渲染进程直接读 */
  label: string;
}

/* --------------------------------------------------------------- 会话与消息 */

export type MessageRole = 'user' | 'assistant' | 'system';

export interface Attachment {
  id: string;
  name: string;
  /** 磁盘绝对路径（图片已在工作区 attachments/ 下） */
  path: string;
  mime: string;
  size: number;
  kind: 'image' | 'file';
  /** 图片的 data URL 预览，其它类型为空 */
  preview?: string;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  /** 展示名，如「联网搜索」 */
  label: string;
  /** 来源：builtin 或 mcp:<serverId> */
  source: string;
  args: Record<string, unknown>;
  status: 'pending' | 'running' | 'success' | 'error' | 'denied';
  result?: string;
  error?: string;
  /** 大结果落盘后的文件路径 */
  filePath?: string;
  /**
   * 这次调用产出的全部文件（生图、导出、脚本产物等）。
   * 图片会直接在对话里内联渲染缩略图，其余类型显示成可点击的文件条目。
   */
  files?: string[];
  startedAt: number;
  endedAt?: number;
}

export interface PlanStep {
  id: string;
  title: string;
  status: 'todo' | 'running' | 'done' | 'failed';
  note?: string;
}

export interface TaskPlan {
  goal: string;
  steps: PlanStep[];
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 命中前缀缓存的 token 数（服务端支持时才有） */
  cachedTokens?: number;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** 思考过程（reasoning / thinking） */
  reasoning?: string;
  toolCalls?: ToolCallRecord[];
  plan?: TaskPlan;
  attachments?: Attachment[];
  usage?: Usage;
  model?: ModelRef;
  thinking?: ThinkingLevel;
  personaId?: string;
  ts: number;
  /** 这条回复从开始到结束的耗时（毫秒），用于统计 tok/s */
  durationMs?: number;
  status?: 'streaming' | 'done' | 'stopped' | 'error';
  error?: string;
  /** 压缩摘要标记：true 表示这条是自动压缩产生的摘要 */
  summary?: boolean;
}

export interface Chat {
  id: string;
  title: string;
  /** 是否已被用户手动改名（自动命名不再覆盖） */
  renamed: boolean;
  workspaceId: string | null;
  personaId: string | null;
  model: ModelRef | null;
  thinking: ThinkingLevel;
  messages: ChatMessage[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  /**
   * 会话对应的磁盘文件夹（绝对路径）。
   * 空白会话为 null —— 发出第一条消息时才按创建时间建目录。
   */
  folder?: string | null;
  /**
   * 会话级上下文窗口覆盖（tokens）。'auto' / undefined 时用模型自身声明的上限。
   * 由输入区的模型面板里「上下文长度」子菜单设置。
   */
  contextLimit?: number | 'auto';
  /** 上下文压缩记录 */
  compressions?: { at: number; dropped: number; summary: string }[];
}

export interface ChatSummary {
  id: string;
  title: string;
  workspaceId: string | null;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview: string;
  folder?: string | null;
  /** 还没有任何消息的空白会话（同一时刻最多一个） */
  blank: boolean;
}

/* --------------------------------------------------------------- 工作区 */

export interface Workspace {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  updatedAt: number;
  chatCount?: number;
}

export interface WorkspaceFile {
  name: string;
  path: string;
  relPath: string;
  size: number;
  mtime: number;
  kind: 'image' | 'code' | 'html' | 'markdown' | 'json' | 'text' | 'binary';
}

/* --------------------------------------------------------------- 记忆 */

export type MemoryLayer = 'session' | 'workspace' | 'global';

export interface MemoryEntry {
  id: string;
  layer: MemoryLayer;
  content: string;
  tags: string[];
  source: 'user' | 'agent' | 'import';
  createdAt: number;
  updatedAt: number;
  workspaceId?: string;
  chatId?: string;
}

/* --------------------------------------------------------------- 人格 */

export interface Persona {
  id: string;
  name: string;
  icon: string;
  systemPrompt: string;
  builtin?: boolean;
}

/* --------------------------------------------------------------- 权限与审计 */

export interface ApprovalRequest {
  id: string;
  kind: 'fs-write' | 'fs-delete' | 'command' | 'dependency' | 'network' | 'mcp';
  title: string;
  detail: string;
  target: string;
  risk: 'low' | 'medium' | 'high';
  chatId?: string;
  createdAt: number;
}

export interface AuditEntry {
  id: string;
  at: number;
  kind: ApprovalRequest['kind'];
  target: string;
  detail: string;
  decision: 'approved' | 'denied' | 'auto';
  chatId?: string;
}

/* --------------------------------------------------------------- 用量 */

export interface UsageRecord {
  id: string;
  at: number;
  chatId: string;
  chatTitle: string;
  providerId: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}

/* --------------------------------------------------------------- 图片生成 */

/**
 * builtin 是内置的程序化出图：不联网、不要 Key、不要显卡，
 * 用 zlib 手写 PNG 在本地把画面算出来。只要进程活着就一定能出图，
 * 所以它是「没有任何图片后端时的保底」，也是用户点一下就能用的默认项。
 */
export type ImageProviderKind = 'builtin' | 'openai' | 'stability' | 'sdwebui' | 'comfyui';

export interface ImageProviderConfig {
  id: string;
  kind: ImageProviderKind;
  label: string;
  baseUrl: string;
  hasKey: boolean;
  enabled: boolean;
  createdAt: number;
}

export interface GeneratedImage {
  id: string;
  prompt: string;
  negativePrompt?: string;
  size: string;
  style: string;
  count: number;
  files: { path: string; url: string }[];
  providerId: string;
  createdAt: number;
  workspaceId: string | null;
  /** 发起这次生成的会话 id；右栏「产物」按它过滤 */
  chatId?: string | null;
}

/* --------------------------------------------------------------- MCP */

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
  enabled: boolean;
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled: boolean;
  createdAt: number;
}

export interface McpServerState {
  id: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error?: string;
  tools: McpToolInfo[];
  restarts: number;
}

/* --------------------------------------------------------------- 定时任务 */

export type TaskType = 'once' | 'recurring';
export type TaskRepeat = 'daily' | 'weekly' | 'monthly' | 'cron';

export interface ScheduledTask {
  id: string;
  name: string;
  type: TaskType;
  /** 一次性任务的绝对时间戳 */
  runAt?: number;
  repeat?: TaskRepeat;
  /** weekly: 0-6；monthly: 1-31 */
  weekdays?: number[];
  monthDay?: number;
  /** cron 表达式（5 段） */
  cron?: string;
  timeOfDay?: string;
  prompt: string;
  model: ModelRef | null;
  thinking: ThinkingLevel;
  workspaceId: string | null;
  chatId: string | null;
  personaId: string | null;
  enabled: boolean;
  nextRun: number | null;
  lastRun?: number;
  createdAt: number;
  history: TaskRunRecord[];
  missedPending?: boolean;
}

export interface TaskRunRecord {
  id: string;
  at: number;
  durationMs: number;
  status: 'success' | 'error' | 'skipped';
  summary: string;
  artifactPaths?: string[];
  error?: string;
}

/* --------------------------------------------------------------- 设置 */

export interface AppSettings {
  theme: ThemeMode;
  locale: Locale;
  permission: PermissionMode;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  rightPanelWidth: number;
  rightPanelOpen: boolean;
  defaultPersonaId: string;
  /** 全局默认思考强度 */
  defaultThinking: ThinkingLevel;
  /** 费率（每百万 token，美元） */
  rates: { input: number; output: number };
  sandboxTimeoutMs: number;
  sandboxMaxOutput: number;
  webSearchEndpoint: string;
  hasWebSearchKey: boolean;
  notifications: boolean;
  webviewAllowlist: string[];
  autoUpdate: boolean;
  /** 无工作区会话的默认根目录（绝对路径）；空串表示用自动探测值 */
  chatRoot: string;
  /** 关闭主窗口时的行为 */
  closeAction: CloseAction;
  /** 首次启动时探测默认根目录失败的原因（只在设置页提示用） */
  chatRootFallback?: string;
  /** 自动压缩上下文：用量超过 compressThreshold 时自动把旧消息折成摘要 */
  autoCompress: boolean;
  /** 自动压缩触发比例（0.5 ~ 0.95），默认 0.75 */
  compressThreshold: number;
  /** 识图（视觉）模型：指定用哪个接入项，空串表示自动挑第一个带视觉模型的接入项 */
  visionProviderId: string;
  /** 识图（视觉）模型：指定该接入项下的模型 id，空串表示用该接入项里第一个带视觉标记的模型 */
  visionModelId: string;
  /** 出图后是否自动让视觉模型核对画面（默认开；关掉就只在需要时手动调 image_understand） */
  visionAutoCheck: boolean;
  /** 是否启用内置本地视觉模型（离线识图，模型按需下载） */
  localVlm: boolean;
  /** 本地视觉模型的自定义存放目录；空串表示 <会话根目录>/models/vlm */
  vlmDir: string;
}

export type CloseAction = 'tray' | 'quit';

/* --------------------------------------------------------------- 内置视觉模型 */

export type VlmPhase = 'missing' | 'ready' | 'downloading' | 'verifying' | 'starting' | 'running' | 'error';

export interface VlmProgress {
  phase: VlmPhase;
  /** 当前文件 */
  file?: string;
  /** 展示用标签，例如「1/2 主模型」 */
  label?: string;
  received: number;
  total: number;
  percent: number;
  /** 下载速度（字节/秒） */
  speed?: number;
  source?: string;
  message?: string;
}

export interface VlmStatus {
  /** llama-server 运行时是否随安装包带到位 */
  runtime: boolean;
  /** 模型是否已下载完整 */
  model: boolean;
  /** 模型目录 */
  dir: string;
  /** 已占用字节数 */
  bytes: number;
  /** 模型已占用 / 完整后的字节数 */
  total: number;
  /** 完整模型的期望字节数（下载进度分母） */
  expected: number;
  phase: VlmPhase;
  /** 本地服务是否已加载，能立刻识图 */
  server: boolean;
  message?: string;
}

/* --------------------------------------------------------------- 上下文用量 */

export interface ContextUsage {
  chatId: string;
  tokens: number;
  limit: number;
  messageCount: number;
  compressed: number;
  /** 用户消息数（对话轮次） */
  rounds: number;
  /** 助手回复数 + 工具调用数（ReAct 步数） */
  steps: number;
  /** 本会话累计计费 token */
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  /** 命中前缀缓存的 token 数 */
  cachedTokens: number;
  /** 缓存命中率 0–1（无数据时为 0） */
  cacheHitRate: number;
  /** 最近一条回复的生成速度（tokens / 秒，无数据时为 0） */
  tokPerSec: number;
}

/* --------------------------------------------------------------- Agent 事件 */

export type AgentEvent =
  | { type: 'chat-start'; chatId: string; messageId: string }
  | { type: 'reasoning-delta'; chatId: string; messageId: string; delta: string }
  | { type: 'content-delta'; chatId: string; messageId: string; delta: string }
  | { type: 'plan'; chatId: string; messageId: string; plan: TaskPlan }
  | { type: 'plan-step'; chatId: string; messageId: string; stepId: string; status: PlanStep['status']; note?: string }
  | { type: 'tool-call'; chatId: string; messageId: string; call: ToolCallRecord }
  | { type: 'tool-update'; chatId: string; messageId: string; call: ToolCallRecord }
  | { type: 'approval'; chatId: string; messageId: string; request: ApprovalRequest }
  | { type: 'usage'; chatId: string; messageId: string; usage: Usage }
  | { type: 'title'; chatId: string; title: string }
  | { type: 'compressed'; chatId: string; dropped: number; summary: string }
  | { type: 'artifact'; chatId: string; path: string }
  | { type: 'chat-end'; chatId: string; messageId: string; status: 'done' | 'stopped' | 'error'; error?: string };

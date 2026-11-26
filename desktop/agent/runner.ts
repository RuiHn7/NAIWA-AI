/* ============================================================================
 * desktop/agent/runner.ts —— ReAct 主循环
 * 单次 sendMessage 的完整生命周期：
 *   组装 prompt → 检查上下文用量（超限压缩）→ 流式请求模型
 *   → 若有工具调用：审批 → 执行 → 结果回填 → 再请求（最多 MAX_TURNS 轮）
 *   → 落盘消息、记录用量、发事件给渲染层
 * ==========================================================================*/

import type {
  AgentEvent,
  Chat,
  ChatMessage,
  ModelRef,
  ThinkingLevel,
  ToolCallRecord,
  Usage,
} from '@shared/types';
import type { SendMessageInput, SendMessageResult } from '@shared/ipc';
import type { LlmMessage, LlmPart, LlmToolCall, LlmToolSchema } from '../llm/types';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getChat, saveChat, updateChat, autoTitle, appendMessage, updateMessage, ensureChatFolder } from '../store/chats';
import { getWorkspace } from '../store/workspaces';
import { getPersona } from '../store/personas';
import { getProvider, getProviderApiKey, listProviders } from '../store/providers';
import { recordUsage } from '../store/usage';
import { streamFor, budgetFor, describeError, inferModelInfo } from '../llm/registry';
import { LlmError } from '../llm/types';
import { buildSystemPrompt } from './prompt';
import { builtinSchemas, TOOL_MAP, toolCatalogText, type ToolContext } from './tools';
import { enabledMcpTools, clientsMap } from '../mcp/client';
import { maybeCompress, latestSummary, contextUsage } from './compress';
import { requestApproval } from './permissions';

/** 单条消息内允许的最多推理轮次 */
const MAX_TURNS = 24;
const FALLBACK_CONTEXT = 32_000;

/**
 * 会话实际生效的上下文窗口：
 *   会话级覆盖（Chat.contextLimit）优先，其次模型自身上限，最后兜底 32k。
 *   'auto' / undefined 都表示「跟着模型走」。
 */
export function effectiveLimit(chat: Chat, model?: { contextWindow?: number } | null): number {
  const own = chat.contextLimit;
  if (typeof own === 'number' && Number.isFinite(own) && own > 0) return own;
  return model?.contextWindow || FALLBACK_CONTEXT;
}

type Emit = (event: AgentEvent) => void;
type Broadcast = (chatId: string) => void;

let emitToRenderer: Emit = () => {};
let broadcastChat: Broadcast = () => {};

export function bindAgent(emit: Emit, broadcast: Broadcast): void {
  emitToRenderer = emit;
  broadcastChat = broadcast;
}

/** 每个会话一个中止控制器 */
const controllers = new Map<string, AbortController>();

export function stopChat(chatId: string): void {
  const controller = controllers.get(chatId);
  if (controller) controller.abort();
}

/* ------------------------------------------------------------ 附件与消息 */

function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif', '.pdf': 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
}

function toParts(text: string, attachmentPaths: string[]): LlmPart[] {
  const parts: LlmPart[] = [];
  for (const file of attachmentPaths) {
    const mime = mimeOf(file);
    if (mime.startsWith('image/')) {
      try {
        const b64 = fs.readFileSync(file).toString('base64');
        parts.push({ type: 'image', url: `data:${mime};base64,${b64}`, mime });
      } catch {
        /* 读不到就跳过 */
      }
    }
  }
  parts.push({ type: 'text', text });
  return parts;
}

/** 历史消息 → LLM 消息（跳过 system 摘要，摘要单另注入） */
function historyToLlm(chat: Chat): LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const m of chat.messages) {
    if (m.summary) continue;
    if (m.role === 'system') continue;
    // 正在流式的助手消息也要进历史：否则多轮工具调用时模型看不到上一轮的工具结果，
    // 会反复发出同一个 tool_call（ReAct 循环打转）。
    const inProgress = m.status === 'streaming';
    if (inProgress && !m.content && !m.reasoning && !(m.toolCalls && m.toolCalls.length)) continue;
    if (m.error && !m.content) continue;
    if (m.role === 'user') {
      const parts: LlmPart[] = [];
      for (const a of m.attachments ?? []) {
        if (a.kind === 'image' && a.path && fs.existsSync(a.path)) {
          try {
            const b64 = fs.readFileSync(a.path).toString('base64');
            parts.push({ type: 'image', url: `data:${a.mime};base64,${b64}`, mime: a.mime });
          } catch {
            /* 跳过 */
          }
        }
      }
      parts.push({ type: 'text', text: m.content });
      out.push({ role: 'user', content: parts });
      continue;
    }
    if (m.role === 'assistant') {
      const toolCalls = (m.toolCalls ?? [])
        .filter(t => t.status === 'success' || t.status === 'error' || t.status === 'denied')
        .map(t => ({ id: t.id, name: t.name, args: t.args }));
      out.push({
        role: 'assistant',
        content: m.content || '',
        toolCalls: toolCalls.length ? toolCalls : undefined,
        // 思考型模型要求把上一轮的推理内容一起带回去，否则带工具调用的多轮会 400
        reasoning: m.reasoning,
      });
      for (const t of m.toolCalls ?? []) {
        if (!t.result && !t.error) continue;
        out.push({ role: 'tool', content: t.error ? `错误：${t.error}` : t.result ?? '', toolCallId: t.id, toolName: t.name });
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------- 工具准备 */

interface PreparedTool {
  schemas: LlmToolSchema[];
  catalog: string;
}

function prepareTools(): PreparedTool {
  const schemas: LlmToolSchema[] = builtinSchemas();
  const extras: { source: string; name: string; description: string }[] = [];
  for (const entry of enabledMcpTools()) {
    schemas.push({
      name: entry.tool.name,
      description: `[MCP ${entry.serverName}] ${entry.tool.description}`,
      parameters: (entry.tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    });
    extras.push({ source: entry.serverName, name: entry.tool.name, description: entry.tool.description });
  }
  return { schemas, catalog: toolCatalogText(extras) };
}

/* ------------------------------------------------------------ 工具执行 */

async function runTool(
  call: LlmToolCall,
  chat: Chat,
  workspace: ReturnType<typeof getWorkspace>,
  controller: AbortController,
  onUpdate: (record: ToolCallRecord) => void,
): Promise<ToolCallRecord> {
  const builtin = TOOL_MAP.get(call.name);
  const record: ToolCallRecord = {
    id: call.id,
    name: call.name,
    label: builtin?.label ?? call.name,
    source: builtin ? 'builtin' : 'mcp',
    args: call.args,
    status: 'running',
    startedAt: Date.now(),
  };
  if (!builtin) {
    const mcpEntry = enabledMcpTools().find(e => e.tool.name === call.name);
    if (mcpEntry) record.source = `mcp:${mcpEntry.serverName}`;
  }
  onUpdate({ ...record });

  try {
    if (builtin) {
      const ctx: ToolContext = {
        chatId: chat.id,
        // 会话磁盘文件夹：产物优先落这里，用户点会话卡片的「打开产物文件夹」就能看到。
        // runTool 传进来的 chat 可能是发消息前的快照，folder 还没建，所以回读一次。
        chatFolder: chat.folder ?? getChat(chat.id)?.folder ?? null,
        workspace,
        signal: controller.signal,
        onProgress: text => {
          record.result = text;
          onUpdate({ ...record });
        },
      };
      const outcome = await builtin.run(call.args, ctx);
      record.status = outcome.denied ? 'denied' : 'success';
      record.result = outcome.text;
      record.filePath = outcome.filePath;
      record.files = outcome.files;
      if (outcome.files?.length) {
        // 全部产物都推给渲染层，图片可以直接内联显示
        for (const file of outcome.files) {
          emitToRenderer({ type: 'artifact', chatId: chat.id, path: file });
        }
      } else if (outcome.filePath) {
        emitToRenderer({ type: 'artifact', chatId: chat.id, path: outcome.filePath });
      }
    } else {
      const entry = enabledMcpTools().find(e => e.tool.name === call.name);
      const client = entry ? clientsMap().get(entry.serverId) : null;
      if (!client) throw new Error(`找不到提供 ${call.name} 的 MCP 服务器（可能已断开）`);
      // MCP 首次调用需要单独授权（PRD 4.13）
      const approved = await requestApproval({
        kind: 'mcp',
        title: `调用外部工具 ${call.name}`,
        detail: `来自外部服务器「${entry!.serverName}」`,
        target: entry!.serverName,
        risk: 'medium',
        chatId: chat.id,
      });
      if (!approved) {
        record.status = 'denied';
        record.result = `用户拒绝了来自 ${entry!.serverName} 的工具调用。`;
        record.endedAt = Date.now();
        onUpdate({ ...record });
        return record;
      }
      record.result = await client.callTool(call.name, call.args);
      record.status = 'success';
    }
  } catch (err) {
    record.status = 'error';
    record.error = (err as Error).message;
    record.result = `错误：${(err as Error).message}`;
  }
  record.endedAt = Date.now();
  onUpdate({ ...record });
  return record;
}

/* ------------------------------------------------------------ 主流程 */

export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  const chat = getChat(input.chatId);
  if (!chat) return { ok: false, error: { kind: 'unknown', message: '会话不存在' } };

  const workspace = chat.workspaceId ? getWorkspace(chat.workspaceId) : null;

  // 模型解析：入参覆盖 → 会话默认 → 第一个可用模型
  const modelRef: ModelRef | null = (() => {
    if (input.model) {
      const provider = getProvider(input.model.providerId);
      const info = provider?.models.find(m => m.id === input.model!.modelId);
      return { providerId: input.model.providerId, modelId: input.model.modelId, label: info?.label ?? input.model.modelId };
    }
    if (chat.model) return chat.model;
    for (const p of listProviders()) {
      if (!p.enabled || !p.models.length) continue;
      return { providerId: p.id, modelId: p.models[0].id, label: p.models[0].label };
    }
    return null;
  })();

  if (!modelRef) {
    return {
      ok: false,
      error: { kind: 'no-provider', message: '还没有接入任何可用模型。请到「设置 → 接入模型」添加接入项并拉取模型列表。' },
    };
  }

  const provider = getProvider(modelRef.providerId);
  const apiKey = provider ? getProviderApiKey(provider.id) : null;
  if (!provider || !apiKey) {
    return { ok: false, error: { kind: 'auth', message: '该接入项缺少 API Key，请重新填写后保存。' } };
  }
  const apiModel = provider.models.find(m => m.id === modelRef.modelId) ?? inferModelInfo(modelRef.modelId);
  const thinking: ThinkingLevel = input.thinking ?? chat.thinking ?? provider.defaultThinking;
  const reasoningBudget = apiModel.reasoning !== false ? budgetFor(thinking, provider.thinkingBudget) : 0;

  const persona = input.personaId !== undefined ? getPersona(input.personaId) : getPersona(chat.personaId);
  if (chat.model?.modelId !== modelRef.modelId || chat.model?.providerId !== modelRef.providerId) {
    updateChat(chat.id, { model: modelRef });
  }

  // 1. 落用户消息
  const attachments = input.attachmentPaths.map(p => ({
    id: randomUUID(),
    name: path.basename(p),
    path: p,
    mime: mimeOf(p),
    size: (() => {
      try {
        return fs.statSync(p).size;
      } catch {
        return 0;
      }
    })(),
    kind: (mimeOf(p).startsWith('image/') ? 'image' : 'file') as 'image' | 'file',
    preview: mimeOf(p).startsWith('image/') && fs.existsSync(p) ? `data:${mimeOf(p)};base64,${fs.readFileSync(p).toString('base64')}` : undefined,
  }));

  appendMessage(chat.id, {
    id: randomUUID(),
    role: 'user',
    content: input.text,
    attachments: attachments.length ? attachments : undefined,
    ts: Date.now(),
    status: 'done',
    thinking,
  });

  // 1.5 首条消息才建会话文件夹（PRD 四.2：点「新对话」时不动磁盘）
  if (!chat.folder) {
    try {
      ensureChatFolder(chat.id, workspace ? path.join(workspace.path, 'chats') : undefined);
    } catch (err) {
      emitToRenderer({ type: 'artifact', chatId: chat.id, path: (err as Error).message });
    }
  }

  // 2. 上下文压缩（超阈值时）
  const limit = effectiveLimit(chat, apiModel);
  let fresh = getChat(chat.id)!;
  const compression = maybeCompress(fresh, limit);
  if (compression.changed) {
    saveChat(fresh);
    emitToRenderer({ type: 'compressed', chatId: fresh.id, dropped: compression.dropped, summary: compression.summary });
    broadcastChat(fresh.id);
  }

  // 3. 首条消息自动命名
  if (!fresh.renamed && fresh.messages.filter(m => m.role === 'user').length === 1) {
    const title = autoTitle(input.text);
    updateChat(fresh.id, { title });
    emitToRenderer({ type: 'title', chatId: fresh.id, title });
  }

  // 4. 建助手消息占位
  const assistant: ChatMessage = {
    id: randomUUID(),
    role: 'assistant',
    content: '',
    reasoning: '',
    toolCalls: [],
    model: modelRef,
    thinking,
    personaId: persona?.id,
    ts: Date.now(),
    status: 'streaming',
  };
  appendMessage(fresh.id, assistant);
  emitToRenderer({ type: 'chat-start', chatId: fresh.id, messageId: assistant.id });

  const controller = new AbortController();
  controllers.set(fresh.id, controller);

  const { schemas, catalog } = prepareTools();
  const systemPrompt = buildSystemPrompt({
    chat: fresh,
    workspace,
    persona,
    userQuery: input.text,
    hasTools: schemas.length > 0,
    toolCatalog: catalog,
    compressedSummary: latestSummary(fresh),
    vision: apiModel.vision !== false,
  });

  let content = '';
  let reasoning = '';
  let usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const toolRecords: ToolCallRecord[] = [];
  let status: 'done' | 'stopped' | 'error' = 'done';
  let errorText: string | undefined;
  /** finish 工具提交的交付摘要，附在最终消息里 */
  let finished: string | null = null;
  /** 同一工具 + 同一参数的重复调用计数：用于打断原地打转的 ReAct 循环 */
  const callSignatures = new Map<string, number>();
  let loopGuard: string | null = null;
  const startedAt = Date.now();

  try {
    let turns = 0;
    let pendingToolCalls: LlmToolCall[] = [];

    while (turns < MAX_TURNS) {
      turns += 1;
      pendingToolCalls = [];

      const history = historyToLlm(getChat(fresh.id)!);
      const messages: LlmMessage[] = [{ role: 'system', content: systemPrompt.system }, ...history];

      const stream = streamFor(provider.kind, {
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        apiKey,
        model: modelRef.modelId,
        messages,
        tools: schemas.length ? schemas : undefined,
        reasoningBudget,
        maxTokens: 8192,
        signal: controller.signal,
      });

      let turnContent = '';
      let turnHadReply = false;

      for await (const event of stream) {
        if (controller.signal.aborted) break;
        if (event.type === 'reasoning') {
          reasoning += event.delta;
          emitToRenderer({ type: 'reasoning-delta', chatId: fresh.id, messageId: assistant.id, delta: event.delta });
        } else if (event.type === 'text') {
          turnContent += event.delta;
          content += event.delta;
          turnHadReply = true;
          emitToRenderer({ type: 'content-delta', chatId: fresh.id, messageId: assistant.id, delta: event.delta });
        } else if (event.type === 'tool-call') {
          pendingToolCalls.push(event.call);
        } else if (event.type === 'usage') {
          usage = {
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
            totalTokens: event.promptTokens + event.completionTokens,
            cachedTokens: event.cachedTokens,
          };
        } else if (event.type === 'error') {
          throw new LlmError(event.kind, event.message);
        }
      }

      if (controller.signal.aborted) break;
      if (!pendingToolCalls.length) break;

      // 有工具调用：先落当前文本，再逐个执行
      updateMessage(fresh.id, assistant.id, {
        content,
        reasoning,
        toolCalls: [...toolRecords],
        status: 'streaming',
      });

      for (const call of pendingToolCalls) {
        if (controller.signal.aborted) break;
        // 同参数同工具重复调用超过 3 次 → 判定打转，直接收尾而不是烧完剩余轮次
        const signature = `${call.name}:${JSON.stringify(call.args ?? {})}`;
        const seen = (callSignatures.get(signature) ?? 0) + 1;
        callSignatures.set(signature, seen);
        if (seen > 3) {
          loopGuard = `检测到重复调用 ${call.name}（同样的参数已执行 ${seen - 1} 次），已中止继续重试。请检查工具返回的结果，换一种做法或直接向用户说明卡在哪里。`;
          break;
        }
        emitToRenderer({
          type: 'tool-call',
          chatId: fresh.id,
          messageId: assistant.id,
          call: { id: call.id, name: call.name, label: TOOL_MAP.get(call.name)?.label ?? call.name, source: 'builtin', args: call.args, status: 'pending', startedAt: Date.now() },
        });
        const record = await runTool(call, fresh, workspace, controller, updated => {
          emitToRenderer({ type: 'tool-update', chatId: fresh.id, messageId: assistant.id, call: updated });
        });
        toolRecords.push(record);
        // finish：模型声明任务完成，记下交付摘要并终止循环，不再发给模型
        if (call.name === 'finish' && record.status === 'success') {
          finished = record.result ?? '';
          break;
        }
      }

      updateMessage(fresh.id, assistant.id, { content, reasoning, toolCalls: [...toolRecords] });
      if (finished || loopGuard) break;
      if (!turnHadReply && !content) {
        // 模型可能只想调工具，继续下一轮
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      status = 'stopped';
    } else {
      status = 'error';
      const described = describeError(err);
      errorText = described.message;
    }
  } finally {
    controllers.delete(fresh.id);
  }

  if (status === 'done' && controller.signal.aborted) status = 'stopped';

  // finish 的交付摘要并进最终正文：模型写了说明就接在后面，没写就作为正文
  if (finished) {
    const tail = finished.trim();
    content = content.trim() ? `${content.trim()}\n\n---\n\n${tail}` : tail;
  } else if (loopGuard) {
    const note = `\n\n**已中止：**${loopGuard}`;
    content = content.trim() ? `${content.trim()}${note}` : loopGuard;
  }

  const finalPatch: Partial<ChatMessage> = {
    content: content || (status === 'error' ? '' : content),
    reasoning,
    toolCalls: toolRecords.length ? toolRecords : undefined,
    usage: usage.totalTokens ? usage : undefined,
    durationMs: Date.now() - startedAt,
    status,
    error: errorText,
  };
  updateMessage(fresh.id, assistant.id, finalPatch);
  saveChat(getChat(fresh.id)!);

  if (usage.totalTokens) {
    recordUsage({
      chatId: fresh.id,
      chatTitle: getChat(fresh.id)?.title ?? '',
      providerId: provider.id,
      modelId: modelRef.modelId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
    });
    emitToRenderer({ type: 'usage', chatId: fresh.id, messageId: assistant.id, usage });
  }

  emitToRenderer({ type: 'chat-end', chatId: fresh.id, messageId: assistant.id, status, error: errorText });
  broadcastChat(fresh.id);

  if (status === 'error') {
    return { ok: false, error: { kind: 'unknown', message: errorText ?? '生成失败' } };
  }
  return { ok: true };
}

/* ------------------------------------------------------------ 重新生成 */

export async function regenerate(chatId: string, messageId: string): Promise<SendMessageResult> {
  const chat = getChat(chatId);
  if (!chat) return { ok: false, error: { kind: 'unknown', message: '会话不存在' } };
  const index = chat.messages.findIndex(m => m.id === messageId);
  if (index < 0) return { ok: false, error: { kind: 'unknown', message: '消息不存在' } };
  // 找到这条之前的最后一条用户消息
  let userIndex = -1;
  for (let i = index; i >= 0; i -= 1) {
    if (chat.messages[i].role === 'user') {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) return { ok: false, error: { kind: 'unknown', message: '找不到对应的用户消息' } };
  const userMsg = chat.messages[userIndex];
  // 删除旧答案及其后的所有消息，再重新发送
  chat.messages = chat.messages.slice(0, index);
  saveChat(chat);
  return sendMessage({
    chatId,
    text: userMsg.content,
    attachmentPaths: (userMsg.attachments ?? []).map(a => a.path),
    thinking: userMsg.thinking,
  });
}

/* ------------------------------------------------------------ 上下文用量 */

export function usageOf(chatId: string): ReturnType<typeof contextUsage> | null {
  const chat = getChat(chatId);
  if (!chat) return null;
  const model = chat.model ? inferModelInfo(chat.model.modelId) : null;
  return contextUsage(chat, effectiveLimit(chat, model));
}

export function compressNow(chatId: string): ReturnType<typeof contextUsage> | null {
  const chat = getChat(chatId);
  if (!chat) return null;
  const model = chat.model ? inferModelInfo(chat.model.modelId) : null;
  const limit = effectiveLimit(chat, model);
  const result = maybeCompress(chat, limit, true);
  if (result.changed) {
    saveChat(chat);
    emitToRenderer({ type: 'compressed', chatId, dropped: result.dropped, summary: result.summary });
    broadcastChat(chatId);
  }
  return result.usage;
}

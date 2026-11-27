/* ============================================================================
 * desktop/ipc/index.ts —— 全部 IPC 路由
 * 渲染进程只能通过这里登记过的通道与主进程交互（PRD 二 / 4.10）。
 * ==========================================================================*/

import { app, dialog, ipcMain, shell, BrowserWindow, Notification } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Chat,
  GeneratedImage,
  McpServerConfig,
  McpServerState,
  MemoryEntry,
  Persona,
  ProviderConfig,
  ScheduledTask,
  TaskRunRecord,
  Workspace,
} from '@shared/types';
import type { InvokeMap, EventMap, PullModelsResult, TestProviderResult, BalanceResult } from '@shared/ipc';
import { dataRoot, scratchDir } from '../store/paths';

import {
  getChat,
  createChat,
  deleteChat,
  listChats,
  searchChats,
  saveChat,
  updateChat,
  updateMessage,
  removeMessage,
  ensureChatFolder,
  moveChatFolder,
  renameChatFolder,
  migrateChatRoot,
  releaseWorkspaceChats,
} from '../store/chats';
import { getSettings, saveSettings } from '../store/settings';
import {
  listProviders,
  getProvider,
  getProviderApiKey,
  saveProvider,
  deleteProvider,
  setProviderModels,
} from '../store/providers';
import {
  listWorkspaces,
  getWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  listWorkspaceFiles,
  listChatArtifacts,
  invalidateWorkspaceCache,
} from '../store/workspaces';
import { listMemory, addMemory, updateMemory, deleteMemory } from '../store/memory';
import { listPersonas, savePersona, deletePersona } from '../store/personas';
import { listUsage, clearUsage } from '../store/usage';
import { listAudit } from '../store/audit';
import {
  listImageProviders,
  saveImageProvider,
  deleteImageProvider,
  listImages,
} from '../store/images';
import { pullModels, streamFor, describeError } from '../llm/registry';
import { fetchBalance } from '../llm/balance';
import { LlmError } from '../llm/types';
import { sendMessage, stopChat, regenerate, usageOf, compressNow } from '../agent/runner';
import { generateImages } from '../agent/imagegen';
import {
  cancelDownload as cancelVlmDownload,
  deleteModel as deleteVlmModel,
  downloadModel as downloadVlmModel,
  setVlmProgressSink,
  stopServer as stopVlmServer,
  vlmStatus,
  warmupLocalVlm,
} from '../agent/vlm';
import { cancelDownload, checkForUpdate, clearDownload, downloadUpdate, launchInstaller } from '../agent/update';
import { listPending, resolveApproval } from '../agent/permissions';
import { runtimeInfo } from '../agent/sandbox';
import {
  listMcpConfigs,
  saveMcpConfig,
  deleteMcpConfig,
  importMcpJson,
} from '../mcp/store';
import { ensureClient, dropClient, serverStates, clientsMap } from '../mcp/client';
import {
  listTasks,
  saveTask,
  deleteTask,
  toggleTask,
  runTaskNow,
  resolveMissed,
} from '../tasks/scheduler';

/** 统一的通道注册工具：channel 与 InvokeMap 的键强绑定 */
function handle<K extends keyof InvokeMap>(
  channel: K,
  fn: (payload: InvokeMap[K]['req'], event: Electron.IpcMainInvokeEvent) => Promise<InvokeMap[K]['res']> | InvokeMap[K]['res'],
): void {
  ipcMain.handle(channel, async (event, payload) => fn(payload as InvokeMap[K]['req'], event));
}

export type Emit = <K extends keyof EventMap>(channel: K, payload: EventMap[K]) => void;

export function registerIpc(emit: Emit): void {
  // 本地视觉模型的下载进度直接推给界面
  setVlmProgressSink(progress => emit('vlm:progress', progress));

  /* ------------------------------------------------------------ 应用与设置 */

  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    userData: dataRoot(),
    runtime: runtimeInfo(),
    locale: app.getLocale(),
  }));

  handle('settings:get', () => getSettings());
  handle('settings:save', patch => {
    const next = saveSettings(patch);
    emit('settings:changed', next);
    return next;
  });

  handle('settings:pick-chat-root', async () => {
    const current = getSettings().chatRoot;
    const picked = await dialog.showOpenDialog({
      title: '选择会话默认存放位置',
      defaultPath: current || app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (picked.canceled || !picked.filePaths.length) return null;
    return { path: picked.filePaths[0] };
  });

  handle('settings:migrate-chat-root', ({ from, to }) => migrateChatRoot(from, to));

  handle('app:check-update', () => checkForUpdate());
  handle('update:download', ({ name, url, size, sha256 }) =>
    downloadUpdate(
      { name, url, size: size ?? 0, sha256 },
      progress => emit('update:progress', progress),
    ),
  );
  handle('update:cancel', () => cancelDownload());
  handle('update:reset', ({ name }) => clearDownload({ name, url: '', size: 0 }));
  handle('update:install', ({ path: file }) => launchInstaller(file));

  /* ------------------------------------------------------------ 接入与模型 */

  handle('provider:list', () => listProviders());
  handle('provider:save', input => saveProvider(input));
  handle('provider:delete', ({ id }) => {
    deleteProvider(id);
  });
  handle('provider:set-models', ({ id, models }) => setProviderModels(id, models));

  handle('provider:pull-models', async ({ providerId, kind, baseUrl, apiKey }): Promise<PullModelsResult> => {
    // 未保存的草稿也要能拉：providerId 只是用来回退取已存 Key / 协议
    const saved = providerId ? getProvider(providerId) : undefined;
    const finalKind = kind ?? saved?.kind ?? 'openai';
    const url = (baseUrl || saved?.baseUrl || '').trim();
    if (!url) return { ok: false, kind: 'endpoint', message: '请先填写接口地址' };
    const key = apiKey && apiKey.trim() ? apiKey.trim() : providerId ? getProviderApiKey(providerId) : '';
    if (!key) return { ok: false, kind: 'auth', message: '请先填写 API Key' };
    try {
      const models = await pullModels(finalKind, url, key);
      if (!models.length) return { ok: false, kind: 'parse', message: '接口返回了空模型列表，请检查该地址是否兼容所选协议' };
      return { ok: true, models };
    } catch (err) {
      if (err instanceof LlmError) {
        const k = err.kind === 'rate-limit' || err.kind === 'timeout' ? 'network' : err.kind;
        return { ok: false, kind: k as 'network' | 'auth' | 'endpoint' | 'parse', message: err.message };
      }
      return { ok: false, kind: 'unknown', message: (err as Error).message };
    }
  });

  handle('provider:test', async ({ providerId, kind, baseUrl, apiKey, model }): Promise<TestProviderResult> => {
    const saved = providerId ? getProvider(providerId) : undefined;
    const finalKind = kind ?? saved?.kind ?? 'openai';
    const url = (baseUrl || saved?.baseUrl || '').trim();
    if (!url) return { ok: false, kind: 'endpoint', message: '请先填写接口地址', ms: 0 };
    if (!model) return { ok: false, kind: 'endpoint', message: '请先选择一个模型', ms: 0 };
    const key = apiKey && apiKey.trim() ? apiKey.trim() : providerId ? getProviderApiKey(providerId) : '';
    if (!key) return { ok: false, kind: 'auth', message: '请先填写 API Key', ms: 0 };

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      let reply = '';
      let usage: { promptTokens: number; completionTokens: number } | undefined;
      const stream = streamFor(finalKind, {
        kind: finalKind,
        baseUrl: url,
        apiKey: key,
        model,
        messages: [{ role: 'user', content: '回复「pong」两个字即可，不要多余内容。' }],
        // 测试连通性不要求思考，省时省钱
        reasoningBudget: 0,
        maxTokens: 16,
        signal: controller.signal,
      });
      for await (const event of stream) {
        if (event.type === 'text') reply += event.delta;
        else if (event.type === 'usage') {
          usage = { promptTokens: event.promptTokens, completionTokens: event.completionTokens };
        } else if (event.type === 'error') {
          throw new LlmError(event.kind, event.message);
        }
        if (reply.length > 200) break;
      }
      const ms = Date.now() - started;
      return { ok: true, ms, reply: reply.trim().slice(0, 200) || '（模型没有返回文本，但请求成功）', usage };
    } catch (err) {
      const ms = Date.now() - started;
      const described = describeError(err);
      const k = described.kind === 'rate-limit' ? 'network' : described.kind;
      return { ok: false, kind: k as 'network' | 'auth' | 'endpoint' | 'parse' | 'timeout' | 'unknown', message: described.message, ms };
    } finally {
      clearTimeout(timer);
    }
  });

  handle('provider:balance', async ({ providerId, kind, baseUrl, apiKey }): Promise<BalanceResult> => {
    // 未保存的草稿也能试：providerId 只用来回退取已存配置
    const saved = providerId ? getProvider(providerId) : undefined;
    const finalKind = kind ?? saved?.kind ?? 'openai';
    const url = (baseUrl || saved?.baseUrl || '').trim();
    const key = apiKey && apiKey.trim() ? apiKey.trim() : providerId ? (getProviderApiKey(providerId) ?? '') : '';

    try {
      return await fetchBalance({ kind: finalKind, baseUrl: url, apiKey: key });
    } catch (err) {
      return { ok: false, checkedAt: Date.now(), reason: (err as Error).message };
    }
  });

  /* ------------------------------------------------------------ 会话 */
  handle('chat:list', () => listChats());
  handle('chat:get', ({ id }) => getChat(id));
  handle('chat:create', ({ workspaceId, ensureFolder }) => {
    const chat = createChat(workspaceId ?? null);
    // 「工作区右键 → 创建新对话」这类入口要求会话一开始就落在工作区文件夹里，
    // 不用等到发第一条消息才建目录。失败就把刚建的空会话删掉，别留一个没有落点的壳。
    if (ensureFolder && workspaceId) {
      const ws = getWorkspace(workspaceId);
      if (ws) {
        const base = path.join(ws.path, 'chats');
        try {
          fs.mkdirSync(base, { recursive: true });
          return ensureChatFolder(chat.id, base) ?? chat;
        } catch (err) {
          deleteChat(chat.id, false);
          throw new Error(`在工作区里创建会话文件夹失败：${(err as Error).message}`);
        }
      }
    }
    return chat;
  });
  handle('chat:update', ({ id, patch }) => {
    // 只改会话本身（标题/模型/人格/工作区等）。文件夹名是创建时间戳，改名不联动，
    // 避免「改个会话名 → 磁盘目录跟着变」这种不可预期的副作用。
    const chat = updateChat(id, patch);
    if (!chat) throw new Error('会话不存在');
    return chat;
  });
  handle('chat:rename-folder', ({ id }) => {
    const chat = getChat(id);
    if (!chat) throw new Error('会话不存在');
    if (!chat.folder) return { folder: null, error: null };
    // 只在用户显式点「同步文件夹名」时才把磁盘目录改成当前标题
    try {
      const next = renameChatFolder(id, chat.title);
      return { folder: next?.folder ?? chat.folder, error: null };
    } catch (err) {
      return { folder: chat.folder, error: (err as Error).message };
    }
  });
  handle('chat:delete', ({ id, withFolder }) => deleteChat(id, withFolder ?? Boolean(getChat(id)?.folder)));
  handle('chat:reveal', async ({ id }) => {
    try {
      let folder = getChat(id)?.folder ?? null;
      if (!folder) {
        const chat = ensureChatFolder(id);
        folder = chat?.folder ?? null;
      }
      if (!folder) return { folder: null, error: '这个会话还没有保存位置' };
      fs.mkdirSync(folder, { recursive: true });
      const err = await shell.openPath(folder);
      return { folder, error: err || undefined };
    } catch (err) {
      return { folder: null, error: (err as Error).message };
    }
  });
  /**
   * 本会话的产物：扫会话文件夹下的 artifacts / files / exports / attachments。
   * 没有工作区的会话也能用 —— 这是右栏在无工作区时唯一的数据源。
   */
  handle('chat:artifacts', async ({ id }) => {
    const chat = getChat(id);
    const folder = chat?.folder ?? null;
    if (!folder) return { folder: null, items: [] };
    try {
      return { folder, items: await listChatArtifacts(folder) };
    } catch {
      return { folder, items: [] };
    }
  });
  handle('chat:move-to-workspace', ({ id, workspaceId }) => {
    const chat = getChat(id);
    if (!chat) throw new Error('会话不存在');
    const from = chat.folder ?? null;
    // 目标基准目录：工作区根 → 其下 chats/；无工作区 → 设置里的 chatRoot
    let destBase = getSettings().chatRoot;
    if (workspaceId) {
      const ws = getWorkspace(workspaceId);
      if (!ws) throw new Error('工作区不存在');
      destBase = path.join(ws.path, 'chats');
      fs.mkdirSync(destBase, { recursive: true });
    }
    let moved = false;
    let error: string | undefined;
    try {
      if (chat.folder) {
        moveChatFolder(id, destBase);
        moved = true;
      }
    } catch (err) {
      error = (err as Error).message;
    }
    // 磁盘迁移失败就别改归属，否则会话会指着一个没搬到的位置（PRD 五：失败回滚）
    if (error) return { chat, moved, from, to: chat.folder ?? null, error };
    const next = updateChat(id, { workspaceId: workspaceId ?? null });
    return { chat: next ?? chat, moved, from, to: next?.folder ?? null };
  });
  handle('chat:search', ({ query }) => searchChats(query));
  handle('chat:usage', ({ id }) => {
    const usage = usageOf(id);
    if (!usage) throw new Error('会话不存在');
    return usage;
  });
  handle('chat:compress', ({ id }) => {
    const usage = compressNow(id);
    if (!usage) throw new Error('会话不存在');
    return usage;
  });
  handle('chat:export', async ({ id, format }) => exportChat(id, format));
  handle('chat:message-delete', ({ chatId, messageId }) => {
    const chat = removeMessage(chatId, messageId);
    if (!chat) throw new Error('会话不存在');
    return chat;
  });
  handle('chat:message-edit', ({ chatId, messageId, content }) => {
    const chat = updateMessage(chatId, messageId, { content });
    if (!chat) throw new Error('会话不存在');
    return chat;
  });

  /* ------------------------------------------------------------ Agent */

  handle('agent:send', input => sendMessage(input));
  handle('agent:stop', ({ chatId }) => {
    stopChat(chatId);
  });
  handle('agent:regenerate', ({ chatId, messageId }) => regenerate(chatId, messageId));
  handle('agent:approve', ({ requestId, approved, remember }) => {
    resolveApproval(requestId, approved, remember);
    emit('approval:resolved', { id: requestId, approved });
  });

  /* ------------------------------------------------------------ 工作区 */

  handle('workspace:list', () => listWorkspaces());
  handle('workspace:create', ({ name, path: dir }) => {
    const ws = createWorkspace(name, dir);
    invalidateWorkspaceCache();
    return ws;
  });
  handle('workspace:update', ({ id, patch }) => updateWorkspace(id, patch));
  handle('workspace:delete', ({ id, deleteFolder }) => {
    // 先让这个工作区里的会话回到独立状态（迁文件夹 + workspaceId 置空），再动磁盘
    releaseWorkspaceChats(id);
    deleteWorkspace(id, deleteFolder);
    invalidateWorkspaceCache();
  });
  handle('workspace:files', async ({ id }) => {
    const ws = getWorkspace(id);
    if (!ws) return [];
    return listWorkspaceFiles(ws);
  });
  handle('workspace:open-folder', async ({ id }) => {
    const ws = getWorkspace(id);
    if (ws) await shell.openPath(ws.path);
  });
  handle('workspace:open-path', async ({ path: target }) => {
    // http(s) 链接（比如版本更新的下载页）直接丢给浏览器，别去 showItemInFolder
    if (/^https?:\/\//i.test(target)) {
      await shell.openExternal(target);
      return;
    }
    const stat = fs.existsSync(target) ? fs.statSync(target) : null;
    if (stat?.isDirectory()) await shell.openPath(target);
    else await shell.showItemInFolder(target);
  });
  handle('workspace:read-file', async ({ path: target }) => {
    try {
      const stat = await fsp.stat(target);
      if (stat.size > 6_000_000) return { ok: false, error: '文件超过 6MB，请直接在系统里打开' };
      const ext = path.extname(target).toLowerCase();
      if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.svg'].includes(ext)) {
        const mime = ext === '.svg' ? 'image/svg+xml' : `image/${ext.slice(1) === 'jpg' ? 'jpeg' : ext.slice(1)}`;
        const data = await fsp.readFile(target);
        return { ok: true, dataUrl: `data:${mime};base64,${data.toString('base64')}` };
      }
      const text = (await fsp.readFile(target, 'utf8')).replace(/^\uFEFF/, '');
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  handle('workspace:pick-folder', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths.length) return null;
    return { path: result.filePaths[0] };
  });
  handle('workspace:assign-chat', ({ chatId, workspaceId }) => {
    const chat = updateChat(chatId, { workspaceId });
    if (!chat) throw new Error('会话不存在');
    return chat;
  });

  /* ------------------------------------------------------------ 记忆 */

  handle('memory:list', ({ layer, workspaceId, chatId }) =>
    listMemory({ layer: layer as MemoryEntry['layer'] | undefined, workspaceId, chatId }),
  );
  handle('memory:add', input => addMemory(input));
  handle('memory:update', ({ id, content, tags }) => updateMemory(id, content, tags));
  handle('memory:delete', ({ id }) => {
    deleteMemory(id);
  });

  /* ------------------------------------------------------------ 人格 */

  handle('persona:list', () => listPersonas());
  handle('persona:save', input => savePersona(input));
  handle('persona:delete', ({ id }) => {
    deletePersona(id);
  });

  /* ------------------------------------------------------------ 内置本地视觉模型 */

  handle('vlm:status', () => vlmStatus());
  handle('vlm:download', () => downloadVlmModel());
  handle('vlm:cancel', () => cancelVlmDownload());
  handle('vlm:delete', () => deleteVlmModel());
  handle('vlm:warmup', () => warmupLocalVlm());
  handle('vlm:stop', async () => {
    await stopVlmServer();
  });

  /* ------------------------------------------------------------ 图片生成 */

  handle('image:providers', () => listImageProviders());
  handle('image:save-provider', input => saveImageProvider(input));
  handle('image:delete-provider', ({ id }) => {
    deleteImageProvider(id);
  });
  handle('image:generate', input => generateImages(input));
  handle('image:history', ({ workspaceId, chatId }) => listImages(workspaceId, chatId));

  /* ------------------------------------------------------------ 审批与审计 */

  handle('approval:pending', () => listPending());
  handle('audit:list', ({ limit }) => listAudit(limit ?? 300));

  /* ------------------------------------------------------------ 用量 */

  handle('usage:list', () => listUsage());
  handle('usage:clear', () => {
    clearUsage();
  });

  /* ------------------------------------------------------------ MCP */

  handle('mcp:list', () => ({ configs: listMcpConfigs(), states: serverStates() }));
  handle('mcp:save', input => {
    const config = saveMcpConfig(input as McpServerConfig);
    dropClient(config.id);
    return config;
  });
  handle('mcp:delete', ({ id }) => {
    dropClient(id);
    deleteMcpConfig(id);
  });
  handle('mcp:connect', async ({ id }) => {
    const config = listMcpConfigs().find(c => c.id === id);
    if (!config) return { id, status: 'error', tools: [], restarts: 0, error: '服务器不存在' } satisfies McpServerState;
    dropClient(id);
    const client = ensureClient(config);
    return client.connect();
  });
  handle('mcp:disconnect', ({ id }) => {
    const client = clientsMap().get(id);
    if (client) void client.disconnect();
  });
  handle('mcp:import', ({ json }) => importMcpJson(json));
  handle('mcp:set-tool', ({ serverId, tool, enabled }) => {
    const client = clientsMap().get(serverId);
    if (!client) return { id: serverId, status: 'disconnected', tools: [], restarts: 0 } satisfies McpServerState;
    client.state.tools = client.state.tools.map(t => (t.name === tool ? { ...t, enabled } : t));
    return client.state;
  });

  /* ------------------------------------------------------------ 定时任务 */

  handle('task:list', () => listTasks());
  handle('task:save', input => saveTask(input));
  handle('task:delete', ({ id }) => {
    deleteTask(id);
  });
  handle('task:toggle', ({ id, enabled }) => toggleTask(id, enabled));
  handle('task:run-now', ({ id }): Promise<TaskRunRecord> => runTaskNow(id));
  handle('task:resolve-missed', ({ id, run }) => {
    resolveMissed(id, run);
  });

  /* ------------------------------------------------------------ 系统 */

  handle('shell:open-external', async ({ url }) => {
    await shell.openExternal(url);
  });
  handle('dialog:pick-files', async ({ kind }) => {
    const win = BrowserWindow.getFocusedWindow();
    const filters =
      kind === 'image'
        ? [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] }]
        : [{ name: '全部文件', extensions: ['*'] }];
    const options: Electron.OpenDialogOptions = { properties: ['openFile', 'multiSelections'], filters };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled) return [];
    return describeFiles(result.filePaths);
  });
  // 拖拽 / 粘贴：渲染层只有 File 对象，preload 换成绝对路径后走这里，绝不弹系统选择框
  handle('dialog:describe-files', ({ paths }) => describeFiles(Array.isArray(paths) ? paths : []));
  // 没有磁盘路径的虚拟文件（截图粘贴、浏览器拖拽）：接收字节落盘，再按同一套逻辑描述
  handle('dialog:import-files', ({ files }) => importFileBytes(files));
  handle('notification:show', ({ title, body }) => {
    if (!getSettings().notifications) return;
    if (Notification.isSupported()) new Notification({ title, body }).show();
  });
}

/* ------------------------------------------------------------------ 导出 */

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.jsx': 'text/plain',
  '.py': 'text/plain',
  '.log': 'text/plain',
  '.xml': 'text/xml',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** 图片预览的内联上限：再大就不 base64 塞进 state 了，只留路径 + 图标 */
const PREVIEW_MAX_BYTES = 12 * 1024 * 1024;

export interface DescribedFile {
  id: string;
  name: string;
  path: string;
  mime: string;
  size: number;
  kind: 'image' | 'file';
  preview?: string;
}

/**
 * 按绝对路径造附件描述。点击选择（dialog:pick-files）和拖拽/粘贴
 * （dialog:describe-files）共用这一份，保证两条链路产出的字段与预览逻辑完全一致。
 * 读不到/是目录的路径直接跳过。
 */
function describeFiles(filePaths: string[]): DescribedFile[] {
  const out: DescribedFile[] = [];
  const seen = new Set<string>();
  for (const file of filePaths) {
    if (typeof file !== 'string' || !file) continue;
    const abs = path.resolve(file);
    if (seen.has(abs)) continue;
    seen.add(abs);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const mime = MIME_BY_EXT[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
    const isImage = mime.startsWith('image/');
    let preview: string | undefined;
    if (isImage && stat.size <= PREVIEW_MAX_BYTES) {
      try {
        preview = `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
      } catch {
        preview = undefined;
      }
    }
    out.push({
      id: randomUUID(),
      name: path.basename(abs),
      path: abs,
      mime,
      size: stat.size,
      kind: isImage ? 'image' : 'file',
      preview,
    });
  }
  return out;
}

/** 粘贴的截图 / 浏览器拖进来的虚拟文件没有磁盘路径：把字节落到 scratch 目录，再走同一套描述逻辑 */
function importFileBytes(files: { name: string; mime?: string; data: Uint8Array }[]): DescribedFile[] {
  const dir = path.join(scratchDir(), 'imported');
  fs.mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const item of Array.isArray(files) ? files : []) {
    if (!item || !item.data) continue;
    const bytes = item.data instanceof Uint8Array ? item.data : new Uint8Array(item.data as ArrayBufferLike);
    if (!bytes.byteLength) continue;
    // 名字只留文件名部分，避免 ../ 之类跑出目录
    const raw = typeof item.name === 'string' && item.name ? item.name : 'pasted-file';
    const safe = path.basename(raw).replace(/[\\/:*?"<>|]/g, '_') || 'pasted-file';
    const ext = path.extname(safe);
    const stem = ext ? safe.slice(0, -ext.length) : safe;
    const stamp = Date.now().toString(36);
    let target = path.join(dir, `${stem}-${stamp}${ext}`);
    let n = 1;
    while (fs.existsSync(target)) target = path.join(dir, `${stem}-${stamp}-${n++}${ext}`);
    try {
      fs.writeFileSync(target, Buffer.from(bytes));
      written.push(target);
    } catch {
      // 单个文件写失败不影响其余文件
    }
  }
  return describeFiles(written);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function exportChat(id: string, format: 'md' | 'json' | 'html'): Promise<{ path: string } | null> {
  const chat = getChat(id);
  if (!chat) return null;
  const ws = chat.workspaceId ? getWorkspace(chat.workspaceId) : null;
  // 优先落到会话自己的 exports/，其次工作区，最后应用数据目录
  const dir = ws
    ? path.join(ws.path, 'exports')
    : chat.folder
      ? path.join(chat.folder, 'exports')
      : path.join(dataRoot(), 'exports');
  fs.mkdirSync(dir, { recursive: true });
  // 默认文件名带会话名 + 时间（PRD 七.3）
  const stamp = (() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  })();
  const safeName = chat.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'chat';
  const file = path.join(dir, `${safeName}-${stamp}.${format}`);

  if (format === 'json') {
    await fsp.writeFile(file, JSON.stringify(chat, null, 2), 'utf8');
    return { path: file };
  }

  if (format === 'md') {
    const lines: string[] = [`# ${chat.title}`, ''];
    for (const m of chat.messages) {
      if (m.summary) {
        lines.push('> 已压缩的早前对话摘要', '>', ...m.content.split('\n').map(l => `> ${l}`), '');
        continue;
      }
      if (m.role === 'system') continue;
      lines.push(m.role === 'user' ? '## 我' : '## NAI WA');
      if (m.reasoning) lines.push('<details><summary>思考过程</summary>', '', m.reasoning, '', '</details>');
      lines.push(m.content, '');
      for (const t of m.toolCalls ?? []) {
        lines.push(`- 工具 \`${t.name}\` · ${t.status}${t.filePath ? ` → ${t.filePath}` : ''}`);
      }
      if (m.toolCalls?.length) lines.push('');
    }
    await fsp.writeFile(file, lines.join('\n'), 'utf8');
    return { path: file };
  }

  // html：单文件，内嵌样式
  const body: string[] = [];
  for (const m of chat.messages) {
    if (m.summary) {
      body.push(`<div class="summary">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div>`);
      continue;
    }
    if (m.role === 'system') continue;
    const who = m.role === 'user' ? '我' : 'NAI WA';
    const reasoning = m.reasoning ? `<details><summary>思考过程</summary><pre>${escapeHtml(m.reasoning)}</pre></details>` : '';
    const tools = (m.toolCalls ?? [])
      .map(t => `<div class="tool"><b>${escapeHtml(t.label)}</b> · ${t.status}${t.filePath ? ` → <code>${escapeHtml(t.filePath)}</code>` : ''}</div>`)
      .join('');
    body.push(`<div class="msg ${m.role}"><h2>${who}</h2>${reasoning}${tools}<div class="content">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div></div>`);
  }
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(chat.title)}</title>
<style>
:root{color-scheme:light dark}
body{max-width:820px;margin:40px auto;padding:0 20px;font:15px/1.75 -apple-system,"Segoe UI","Microsoft YaHei UI",sans-serif;background:#0b0f16;color:#e8eefc}
h1{font-size:22px;border-bottom:1px solid #2a3446;padding-bottom:12px}
.msg{margin:22px 0;padding:14px 16px;border-radius:12px;background:#141b26;border:1px solid #222c3c}
.msg.user{background:#182234}
h2{font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:#7fb0e8;margin:0 0 8px}
.summary{color:#93a3bb;font-size:13px;padding:10px 14px;border-left:3px solid #2f3b4f;margin:18px 0}
.tool{font-size:12.5px;color:#9fb0c8;margin:4px 0}
code{font-family:"Cascadia Code",Consolas,monospace;font-size:12px;background:#0d141d;padding:1px 5px;border-radius:4px}
pre{white-space:pre-wrap;font-family:"Cascadia Code",Consolas,monospace;font-size:12.5px;color:#9fb0c8}
details{margin:6px 0 10px}
summary{cursor:pointer;font-size:12.5px;color:#7fb0e8}
</style></head><body><h1>${escapeHtml(chat.title)}</h1>${body.join('\n')}</body></html>`;
  await fsp.writeFile(file, html, 'utf8');
  return { path: file };
}

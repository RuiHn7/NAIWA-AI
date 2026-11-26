/* ============================================================================
 * desktop/mcp/client.ts —— MCP 客户端（stdio + HTTP/SSE）
 * 手写最小 JSON-RPC 实现，避免引入 SDK 带来打包体积与版本依赖问题。
 * 单个 server 崩溃自动重启最多 3 次，退避递增（PRD 4.13）。
 * ==========================================================================*/

import type { McpServerConfig, McpServerState, McpToolInfo } from '@shared/types';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: any;
  error?: { code: number; message: string };
}

type Notification = (state: McpServerState) => void;

export class McpClient {
  readonly id: string;
  readonly config: McpServerConfig;
  state: McpServerState;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<string | number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private notify: Notification;
  private restarts = 0;
  private closedByUser = false;
  private httpSessionId: string | null = null;

  constructor(config: McpServerConfig, notify: Notification) {
    this.id = config.id;
    this.config = config;
    this.notify = notify;
    this.state = { id: config.id, status: 'disconnected', tools: [], restarts: 0 };
  }

  private push(): void {
    this.notify({ ...this.state, restarts: this.restarts });
  }

  async connect(): Promise<McpServerState> {
    this.closedByUser = false;
    this.state.status = 'connecting';
    this.push();
    try {
      if (this.config.transport === 'stdio') await this.startStdio();
      await this.initialize();
      await this.refreshTools();
      this.state.status = 'connected';
      this.state.error = undefined;
    } catch (err) {
      this.state.status = 'error';
      this.state.error = (err as Error).message;
    }
    this.push();
    return this.state;
  }

  private async startStdio(): Promise<void> {
    if (this.proc) return;
    if (!this.config.command) throw new Error('stdio 服务器缺少启动命令');
    const proc = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: 'pipe',
      windowsHide: true,
      shell: process.platform === 'win32',
    }) as ChildProcessWithoutNullStreams;
    this.proc = proc;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    proc.stderr.on('data', () => {
      /* stderr 只用于诊断，不打断协议 */
    });
    proc.on('exit', () => {
      this.proc = null;
      this.rejectAll('MCP 服务器进程已退出');
      if (!this.closedByUser) void this.scheduleRestart();
    });
    proc.on('error', () => {
      this.proc = null;
    });

    await new Promise(resolve => setTimeout(resolve, 120));
  }

  private async scheduleRestart(): Promise<void> {
    if (this.restarts >= 3) {
      this.state.status = 'error';
      this.state.error = '服务器多次崩溃，已标记离线';
      this.push();
      return;
    }
    this.restarts += 1;
    const delay = 800 * this.restarts;
    this.state.status = 'connecting';
    this.push();
    await new Promise(resolve => setTimeout(resolve, delay));
    if (this.closedByUser) return;
    try {
      if (this.config.transport === 'stdio') await this.startStdio();
      await this.initialize();
      await this.refreshTools();
      this.state.status = 'connected';
      this.state.error = undefined;
    } catch (err) {
      this.state.status = 'error';
      this.state.error = (err as Error).message;
    }
    this.push();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf('\n');
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.handleLine(line);
      idx = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  }

  private rejectAll(reason: string): void {
    for (const [, p] of this.pending) p.reject(new Error(reason));
    this.pending.clear();
  }

  /** stdio 用 JSON 行协议；http 用 fetch 单请求 JSON-RPC */
  private async rpc(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    if (this.config.transport === 'stdio') {
      if (!this.proc) throw new Error('MCP 服务器未连接');
      const promise = new Promise<any>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new Error(`调用 ${method} 超时`));
          }
        }, 30_000);
      });
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
      return promise;
    }

    // HTTP/SSE 传输
    if (!this.config.url) throw new Error('HTTP 服务器缺少 url');
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.httpSessionId) headers['Mcp-Session-Id'] = this.httpSessionId;
    const response = await fetch(this.config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    const session = response.headers.get('mcp-session-id');
    if (session) this.httpSessionId = session;
    const text = await response.text();
    // 支持 SSE 包裹的单条响应
    const dataLine = text.split('\n').find(l => l.startsWith('data:'));
    const body = dataLine ? dataLine.slice(5).trim() : text;
    const json = JSON.parse(body) as JsonRpcResponse;
    if (json.error) throw new Error(json.error.message);
    return json.result;
  }

  private async initialize(): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {}, roots: { listChanged: false } },
      clientInfo: { name: 'NAI WA Desktop', version: '1.0.0' },
    });
    // 通知服务器初始化完成（无 id）
    if (this.config.transport === 'stdio' && this.proc) {
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    }
  }

  async refreshTools(): Promise<McpToolInfo[]> {
    const result = await this.rpc('tools/list', {});
    const rows: any[] = result?.tools ?? [];
    const previous = new Map(this.state.tools.map(t => [t.name, t.enabled]));
    this.state.tools = rows.map(r => ({
      name: r.name,
      description: r.description ?? '',
      inputSchema: r.inputSchema ?? {},
      enabled: previous.get(r.name) ?? true,
    }));
    this.push();
    return this.state.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.rpc('tools/call', { name, arguments: args });
    const content: any[] = result?.content ?? [];
    const text = content
      .map(c => (c.type === 'text' ? c.text : c.type === 'image' ? `[图片 ${c.mimeType ?? ''}]` : JSON.stringify(c)))
      .join('\n');
    return text || JSON.stringify(result);
  }

  async disconnect(): Promise<void> {
    this.closedByUser = true;
    this.rejectAll('已断开');
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* 已退出 */
      }
      this.proc = null;
    }
    this.state.status = 'disconnected';
    this.push();
  }
}

/* -------------------------------------------------------------- 管理器 */

const clients = new Map<string, McpClient>();
let stateListener: Notification = () => {};

export function bindMcpListener(fn: Notification): void {
  stateListener = fn;
}

export function clientsMap(): Map<string, McpClient> {
  return clients;
}

export function ensureClient(config: McpServerConfig): McpClient {
  const existing = clients.get(config.id);
  if (existing) return existing;
  const client = new McpClient(config, state => {
    clients.set(state.id, client);
    stateListener(state);
  });
  clients.set(config.id, client);
  return client;
}

export function dropClient(id: string): void {
  const client = clients.get(id);
  if (client) {
    void client.disconnect();
    clients.delete(id);
  }
}

export function serverStates(): McpServerState[] {
  return [...clients.values()].map(c => ({ ...c.state, restarts: c.state.restarts }));
}

/** 所有已连接 server 里被启用的工具 */
export function enabledMcpTools(): { serverId: string; serverName: string; tool: McpToolInfo }[] {
  const out: { serverId: string; serverName: string; tool: McpToolInfo }[] = [];
  for (const client of clients.values()) {
    if (client.state.status !== 'connected') continue;
    for (const tool of client.state.tools) {
      if (tool.enabled) out.push({ serverId: client.id, serverName: client.config.name, tool });
    }
  }
  return out;
}

export function newRequestId(): string {
  return randomUUID();
}

/* ============================================================================
 * desktop/mcp/store.ts —— MCP 服务器配置持久化
 * ==========================================================================*/

import fs from 'node:fs';
import type { McpServerConfig } from '@shared/types';
import { readJson, writeJson } from '../store/json';
import { mcpFile } from '../store/paths';
import { randomUUID } from 'node:crypto';

function load(): McpServerConfig[] {
  const list = readJson<McpServerConfig[]>(mcpFile(), []);
  return Array.isArray(list) ? list : [];
}

function persist(list: McpServerConfig[]): void {
  writeJson(mcpFile(), list);
}

export function listMcpConfigs(): McpServerConfig[] {
  return load();
}

export function getMcpConfig(id: string): McpServerConfig | null {
  return load().find(c => c.id === id) ?? null;
}

export function saveMcpConfig(input: Omit<McpServerConfig, 'id' | 'createdAt'> & { id?: string }): McpServerConfig {
  const list = load();
  const existing = input.id ? list.find(c => c.id === input.id) : undefined;
  if (existing) {
    Object.assign(existing, input, { id: existing.id });
    persist(list);
    return existing;
  }
  const record: McpServerConfig = {
    id: input.id ?? randomUUID(),
    name: input.name,
    transport: input.transport,
    command: input.command,
    args: input.args,
    env: input.env,
    url: input.url,
    enabled: input.enabled,
    createdAt: Date.now(),
  };
  list.push(record);
  persist(list);
  return record;
}

export function deleteMcpConfig(id: string): void {
  persist(load().filter(c => c.id !== id));
}

/** 导入 Claude Desktop / Cursor 的 mcp.json 结构 */
export function importMcpJson(raw: string): { imported: number; errors: string[] } {
  const errors: string[] = [];
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { imported: 0, errors: [`JSON 解析失败：${(err as Error).message}`] };
  }
  const servers: Record<string, any> = parsed?.mcpServers ?? parsed?.servers ?? {};
  const list = load();
  let imported = 0;
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') {
      errors.push(`${name}：配置不是对象，已跳过`);
      continue;
    }
    const c = cfg as Record<string, any>;
    const url = typeof c.url === 'string' ? c.url : typeof c.serverUrl === 'string' ? c.serverUrl : undefined;
    const command = typeof c.command === 'string' ? c.command : undefined;
    if (!url && !command) {
      errors.push(`${name}：既没有 command 也没有 url，已跳过`);
      continue;
    }
    if (list.some(x => x.name === name)) {
      errors.push(`${name}：同名服务器已存在，已跳过`);
      continue;
    }
    list.push({
      id: randomUUID(),
      name,
      transport: command ? 'stdio' : 'http',
      command,
      args: Array.isArray(c.args) ? c.args.map(String) : undefined,
      env: c.env && typeof c.env === 'object' ? Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, String(v)])) : undefined,
      url,
      enabled: true,
      createdAt: Date.now(),
    });
    imported += 1;
  }
  persist(list);
  return { imported, errors };
}

/** 首次启动时把内置常用服务器写进去（未配置则跳过） */
export function ensureMcpFile(): void {
  const file = mcpFile();
  if (!fs.existsSync(file)) writeJson(file, []);
}

/* ============================================================================
 * desktop/agent/permissions.ts —— 风险操作审批中枢
 * 渲染层只负责展示卡片并回传「同意/拒绝」；真实的权限判定在主进程再校验一次，
 * 渲染进程声明「我有完全访问」不算数（PRD 4.10）。
 * ==========================================================================*/

import type { ApprovalRequest, Chat } from '@shared/types';
import { randomUUID } from 'node:crypto';
import { getSettings } from '../store/settings';
import { audit } from '../store/audit';

interface Pending extends ApprovalRequest {
  resolve: (approved: boolean) => void;
}

const pending = new Map<string, Pending>();
/** 本次会话内「永久同意」的操作类型 */
const remembered = new Set<string>();

type Emit = (channel: 'approval:request', payload: ApprovalRequest) => void;

let emitToRenderer: Emit = () => {};

export function bindApprovalEmitter(emit: Emit): void {
  emitToRenderer = emit;
}

export function listPending(): ApprovalRequest[] {
  return [...pending.values()].map(({ resolve, ...rest }) => rest);
}

export function resolveApproval(requestId: string, approved: boolean, remember?: boolean): void {
  const item = pending.get(requestId);
  if (!item) return;
  pending.delete(requestId);
  if (approved && remember) remembered.add(item.kind);
  item.resolve(approved);
  void audit({
    kind: item.kind,
    target: item.target,
    detail: item.detail,
    decision: approved ? 'approved' : 'denied',
    chatId: item.chatId,
  });
}

export function clearPending(): void {
  for (const [, item] of pending) item.resolve(false);
  pending.clear();
}

/**
 * 申请执行一次风险操作。
 * 完全访问模式直接放行（仍记审计）；审批模式等用户点卡片。
 */
export async function requestApproval(input: {
  kind: ApprovalRequest['kind'];
  title: string;
  detail: string;
  target: string;
  risk?: ApprovalRequest['risk'];
  chatId?: string;
}): Promise<boolean> {
  const mode = getSettings().permission;
  if (mode === 'full' || remembered.has(input.kind)) {
    void audit({
      kind: input.kind,
      target: input.target,
      detail: input.detail,
      decision: 'auto',
      chatId: input.chatId,
    });
    return true;
  }

  const request: ApprovalRequest = {
    id: randomUUID(),
    kind: input.kind,
    title: input.title,
    detail: input.detail,
    target: input.target,
    risk: input.risk ?? 'medium',
    chatId: input.chatId,
    createdAt: Date.now(),
  };

  return new Promise<boolean>(resolve => {
    pending.set(request.id, { ...request, resolve });
    emitToRenderer('approval:request', request);
  });
}

/** 主进程侧二次校验：命令与删除在工作区之外时升风险等级 */
export function riskOfPath(target: string, workspacePath: string | null): ApprovalRequest['risk'] {
  if (!workspacePath) return 'medium';
  const inWs = target.startsWith(workspacePath);
  return inWs ? 'low' : 'high';
}

export function chatGuard(chat: Chat | null): string | undefined {
  return chat?.id;
}

/* ============================================================================
 * desktop/store/audit.ts —— 风险操作审计日志（JSONL 追加写）
 * ==========================================================================*/

import type { AuditEntry } from '@shared/types';
import { randomUUID } from 'node:crypto';
import { appendJsonLine, readJsonLines } from './json';
import { auditFile } from './paths';

export async function audit(entry: Omit<AuditEntry, 'id' | 'at'>): Promise<void> {
  await appendJsonLine(auditFile(), { ...entry, id: randomUUID(), at: Date.now() });
}

export async function listAudit(limit = 300): Promise<AuditEntry[]> {
  const rows = await readJsonLines<AuditEntry>(auditFile(), limit);
  return rows.reverse();
}

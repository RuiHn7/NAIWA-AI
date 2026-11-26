/* ============================================================================
 * src/lib/approval.ts —— 审批/审计文案的本地化
 *
 * 这些字符串是主进程拼出来的（写入 N 字符到 <路径>、来自外部服务器「X」…），
 * 里面混着可变数据（路径、字符数、服务器名），不能整条塞进词典。
 * 这里按固定模式拆出可变片段，只翻模板部分；认不出来的原样返回（属数据）。
 * ==========================================================================*/

type T = (source: string) => string;

/** detail：写入 / 追加 / 删除 / 外部服务器 四种主进程模板 */
export function localizeApprovalDetail(detail: string, t: T): string {
  let m = /^(写入|追加) (\d+) 字符到 (.+)$/.exec(detail);
  if (m) {
    const verb = m[1] === '追加' ? t('追加') : t('写入');
    return `${verb} ${m[2]} ${t('字符到')} ${m[3]}`;
  }
  m = /^来自外部服务器「(.+)」$/.exec(detail);
  if (m) return `${t('来自外部服务器')}「${m[1]}」`;
  m = /^将删除 (.+)，此操作不可恢复$/.exec(detail);
  if (m) return `${t('将删除')} ${m[1]}${t('，此操作不可恢复')}`;
  return detail;
}

/** title：只有 MCP 一条是「调用外部工具 <name>」，其余是固定中文 */
export function localizeApprovalTitle(title: string, t: T): string {
  const mcp = /^调用外部工具 (.+)$/.exec(title);
  if (mcp) return `${t('调用外部工具')} ${mcp[1]}`;
  return t(title);
}

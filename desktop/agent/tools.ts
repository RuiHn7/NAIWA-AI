/* ============================================================================
 * desktop/agent/tools.ts —— 内置工具集（Function Calling）
 * 每个工具：schema + 执行函数。所有触碰磁盘/进程的操作都走权限中枢。
 * ==========================================================================*/

import type { LlmToolSchema } from '../llm/types';
import type { Workspace } from '@shared/types';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { getSettings } from '../store/settings';
import { requestApproval, riskOfPath } from './permissions';
import { runCode, runCommand, runtimeInfo, installHint } from './sandbox';
import { getWorkspace, listWorkspaceFiles } from '../store/workspaces';
import { chatArtifacts, chatFiles, scratchDir, workspaceArtifacts } from '../store/paths';

export interface ToolContext {
  chatId: string;
  /** 当前会话的磁盘文件夹（首条消息后就有）。产物优先落这里，跟会话绑在一起。 */
  chatFolder?: string | null;
  workspace: Workspace | null;
  signal: AbortSignal;
  onProgress?: (text: string) => void;
}

export interface ToolOutcome {
  /** 回填给模型的结果文本 */
  text: string;
  /** 大结果落盘后的路径（用于消息里显示文件引用） */
  filePath?: string;
  /** 本次调用产出的全部文件，图片会在对话里直接内联显示 */
  files?: string[];
  denied?: boolean;
}

export interface ToolDef {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 旧名兼容：仍能被历史会话调用，但不出现在 schema / 工具目录里 */
  hidden?: boolean;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutcome>;
}

const MAX_INLINE = 4000;

/**
 * 产物落盘目录（优先级从高到低）：
 *   1. 会话自己的文件夹 `<会话目录>/artifacts` —— 产物跟着会话走，用户能在会话文件夹里直接找到
 *   2. 当前工作区的 `artifacts/` —— 会话还没建文件夹时的兜底
 *   3. 应用数据目录的 `scratch/artifacts` —— 连工作区都没有时的最后兜底
 */
export function artifactsDirOf(ctx: { chatFolder?: string | null; workspace?: Workspace | null }): string {
  if (ctx.chatFolder) return chatArtifacts(ctx.chatFolder);
  if (ctx.workspace) return workspaceArtifacts(ctx.workspace.path);
  return path.join(scratchDir(), 'artifacts');
}

/** 大结果落盘：返回文件路径，模型只看到摘要 */
async function spill(text: string, name: string, ctx: ToolContext): Promise<{ text: string; filePath?: string }> {
  if (text.length <= MAX_INLINE) return { text };
  const dir = artifactsDirOf(ctx);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.txt`);
  await fsp.writeFile(file, text, 'utf8');
  const head = text.slice(0, 1200);
  return { text: `${head}\n\n…【结果过长已截断，共 ${text.length} 字符，完整内容已保存到 ${file}】`, filePath: file };
}

function str(args: Record<string, unknown>, key: string, fallback = ''): string {
  const v = args[key];
  return typeof v === 'string' ? v : fallback;
}
function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * 相对路径的基准目录（优先级从高到低）：
 *   1. 工作区根 —— 有工作区时相对路径就是工作区里的路径，符合用户直觉
 *   2. 会话自己的 `files/` —— 没工作区时，脚本产物跟着会话走
 *   3. 应用数据目录的 `scratch/files`
 */
export function baseDirOf(ctx: { chatFolder?: string | null; workspace?: Workspace | null }): string {
  if (ctx.workspace) return ctx.workspace.path;
  if (ctx.chatFolder) return chatFiles(ctx.chatFolder);
  return path.join(scratchDir(), 'files');
}

/** 把相对路径解析成绝对路径，绝对路径原样返回（由审批兜底） */
function resolvePath(raw: string, ctx: ToolContext): string {
  if (path.isAbsolute(raw)) return path.normalize(raw);
  const base = baseDirOf(ctx);
  fs.mkdirSync(base, { recursive: true });
  return path.resolve(base, raw);
}

/* ------------------------------------------------- 文件遍历（grep / ls 共用） */

/** 遍历时跳过的目录：依赖、版本库、构建产物、沙箱与产物目录 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'release',
  '.sandbox',
  'artifacts',
  'exports',
  'attachments',
  '.idea',
  '.vscode',
  '__pycache__',
  '.venv',
]);

/** 单个文件参与 grep 的上限，超过就当二进制/大文件跳过 */
const GREP_FILE_LIMIT = 512 * 1024;

function looksBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, Math.min(buf.length, 4096));
  for (const byte of probe) if (byte === 0) return true;
  return false;
}

function relTo(base: string, target: string): string {
  const rel = path.relative(base, target).split(path.sep).join('/');
  return rel || '.';
}

/** 广度优先遍历，收集文件绝对路径（上限防止在巨型仓库里跑飞） */
async function walkFiles(root: string, maxFiles = 4000): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [root];
  while (queue.length && out.length < maxFiles) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if (entry.name.startsWith('.') && entry.name !== '.env' && entry.name !== '.gitignore') {
        if (entry.isDirectory()) continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

/** 极简 glob → 正则：支持 `*.ts`、`**\/*.ts`、`*.{js,ts}`、`src/**\/*.tsx` */
function globToRegExp(glob: string): RegExp {
  const expanded = glob.replace(/\{([^}]+)\}/g, (_, group: string) => `(${group.split(',').join('|')})`);
  let out = '';
  for (let i = 0; i < expanded.length; i += 1) {
    const ch = expanded[i];
    if (ch === '*' && expanded[i + 1] === '*') {
      i += 1;
      if (expanded[i + 1] === '/') {
        i += 1;
        out += '(?:.*/)?';
      } else {
        out += '.*';
      }
    } else if (ch === '*') {
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '(' || ch === ')' || ch === '|') {
      out += ch;
    } else {
      out += ch.replace(/[.+^${}[\]\\/]/g, m => `\\${m}`);
    }
  }
  return new RegExp(`^${out}$`);
}

/** 跑一个可执行文件并收集输出（git 等只读命令用，不经过 shell） */
function execText(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const raw = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
      const code = !err ? 0 : typeof raw?.code === 'number' ? (raw.code as number) : 1;
      resolve({ ok: !err, code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err ? err.message : '') });
    });
  });
}

/* ------------------------------------------------------------------ 联网搜索 */

async function webSearch(query: string, signal: AbortSignal): Promise<string> {
  const settings = getSettings();
  const endpoint = settings.webSearchEndpoint.trim();
  if (!endpoint) {
    return `联网搜索未配置。请在「设置 → 接入模型」下方的搜索接口里填写 endpoint（支持返回 JSON 数组的自建搜索服务），或直接告诉我你已有的资料。查询词：${query}`;
  }
  try {
    const url = endpoint.includes('{{q}}') ? endpoint.replace('{{q}}', encodeURIComponent(query)) : `${endpoint}${endpoint.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`;
    const response = await fetch(url, { signal });
    const text = await response.text();
    return text.slice(0, 6000);
  } catch (err) {
    return `搜索失败：${(err as Error).message}`;
  }
}

/* ------------------------------------------------------------------ 网页阅读 */

function htmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  const text = withoutScripts
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return text
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

async function readWebPage(url: string, signal: AbortSignal): Promise<string> {
  try {
    const response = await fetch(url, { signal, headers: { 'User-Agent': 'NAIWA/1.0 (+desktop-agent)' } });
    if (!response.ok) return `抓取失败：HTTP ${response.status}`;
    const type = response.headers.get('content-type') ?? '';
    const raw = await response.text();
    if (type.includes('html')) {
      const text = htmlToText(raw);
      return text.slice(0, 12_000);
    }
    return raw.slice(0, 12_000);
  } catch (err) {
    return `抓取失败：${(err as Error).message}`;
  }
}

/* ------------------------------------------------------------------ 工具定义 */

export const TOOLS: ToolDef[] = [
  {
    name: 'ls',
    label: '列出目录',
    description:
      '列目录内容。不带 path 时列当前工作区根目录；recursive=true 时递归列出整棵树（跳过 node_modules/.git/dist 等）。返回每项的 名称 · 类型 · 大小。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，相对工作区；省略则为工作区根目录' },
        recursive: { type: 'boolean', description: '是否递归列出整棵树，默认 false（只看一级）' },
        max_entries: { type: 'number', description: '最多返回多少条，默认 400' },
      },
      required: [],
    },
    async run(args, ctx) {
      const raw = str(args, 'path').trim();
      const target = raw ? resolvePath(raw, ctx) : baseDirOf(ctx);
      const maxEntries = Math.min(5000, Math.max(10, num(args, 'max_entries', 400)));
      try {
        if (args.recursive === true) {
          const files = await walkFiles(target, maxEntries);
          if (!files.length) return { text: `目录 ${target} 下没有文件。` };
          const rows = files.map(f => {
            try {
              return `${relTo(target, f)} · ${fs.statSync(f).size}B`;
            } catch {
              return relTo(target, f);
            }
          });
          return spill(`${target}（递归，${rows.length} 项）\n\n${rows.join('\n')}`, `ls-${Date.now()}`, ctx);
        }
        const entries = await fsp.readdir(target, { withFileTypes: true });
        if (!entries.length) return { text: `目录 ${target} 是空的。` };
        const rows = entries
          .filter(e => !SKIP_DIRS.has(e.name))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .slice(0, maxEntries)
          .map(e => {
            const full = path.join(target, e.name);
            if (e.isDirectory()) return `${e.name}/ · dir`;
            try {
              const size = fs.statSync(full).size;
              return `${e.name} · file · ${size}B`;
            } catch {
              return `${e.name} · file`;
            }
          });
        return spill(`${target}\n\n${rows.join('\n')}`, `ls-${Date.now()}`, ctx);
      } catch (err) {
        return { text: `列目录失败：${(err as Error).message}` };
      }
    },
  },
  {
    name: 'grep',
    label: '搜索代码',
    description:
      '在工作区里按正则搜索文件内容，返回 `相对路径:行号: 内容`。用于定位函数、变量、关键字的调用点。跳过 node_modules/.git/dist 等目录与二进制文件。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式（JavaScript 语法）' },
        path: { type: 'string', description: '限定搜索的子目录或单文件，相对工作区；省略则搜整个工作区' },
        include: { type: 'string', description: '文件名 glob 过滤，如 `*.ts`、`*.{js,tsx}`' },
        max_results: { type: 'number', description: '最多返回多少条命中，默认 200' },
        ignore_case: { type: 'boolean', description: '是否忽略大小写，默认 false' },
      },
      required: ['pattern'],
    },
    async run(args, ctx) {
      const pattern = str(args, 'pattern');
      if (!pattern) return { text: '缺少 pattern 参数。' };
      let re: RegExp;
      try {
        re = new RegExp(pattern, args.ignore_case === true ? 'i' : '');
      } catch (err) {
        return { text: `正则不合法：${(err as Error).message}。请修正 pattern 后重试。` };
      }
      const base = baseDirOf(ctx);
      const scope = str(args, 'path').trim();
      const rootAbs = scope ? resolvePath(scope, ctx) : base;
      const includeGlob = str(args, 'include').trim();
      const includeRe = includeGlob ? globToRegExp(includeGlob) : null;
      const maxResults = Math.min(2000, Math.max(1, num(args, 'max_results', 200)));

      let files: string[];
      try {
        const stat = await fsp.stat(rootAbs);
        files = stat.isDirectory() ? await walkFiles(rootAbs) : [rootAbs];
      } catch (err) {
        return { text: `路径不存在或无法访问：${rootAbs}（${(err as Error).message}）` };
      }

      const hits: string[] = [];
      let scanned = 0;
      for (const file of files) {
        if (hits.length >= maxResults) break;
        const rel = relTo(base, file);
        if (includeRe && !includeRe.test(rel) && !includeRe.test(path.basename(file))) continue;
        let buf: Buffer;
        try {
          const stat = await fsp.stat(file);
          if (stat.size > GREP_FILE_LIMIT) continue;
          buf = await fsp.readFile(file);
        } catch {
          continue;
        }
        if (looksBinary(buf)) continue;
        scanned += 1;
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (hits.length >= maxResults) break;
          if (!re.test(lines[i])) continue;
          const text = lines[i].length > 240 ? `${lines[i].slice(0, 240)}…` : lines[i];
          hits.push(`${rel}:${i + 1}: ${text.trim()}`);
        }
      }

      if (!hits.length) {
        return { text: `没有命中：pattern=${pattern}${includeGlob ? ` include=${includeGlob}` : ''}（扫描了 ${scanned} 个文件）` };
      }
      const head = `命中 ${hits.length} 条（扫描 ${scanned} 个文件${hits.length >= maxResults ? `，已达上限 ${maxResults}，可能还有更多` : ''}）：\n`;
      return spill(head + hits.join('\n'), `grep-${Date.now()}`, ctx);
    },
  },
  {
    name: 'edit_patch',
    label: '增量改文件',
    description:
      '对已有文件做精确的局部替换（首选，避免整份覆盖）。把 old_string 原样替换成 new_string：old_string 必须与文件内容完全一致（含缩进），且在文件中只出现一次（除非 all=true）。找不到或出现多次都会返回可读错误，按提示修正 old_string 再试。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件路径（相对工作区或绝对路径）' },
        old_string: { type: 'string', description: '要被替换的原文，必须逐字符一致，建议带足上下文以保证唯一' },
        new_string: { type: 'string', description: '替换后的内容；传空字符串表示删除这段' },
        all: { type: 'boolean', description: '是否替换所有出现（默认 false，要求恰好一处）' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async run(args, ctx) {
      const rawPath = str(args, 'path');
      if (!rawPath) return { text: '缺少 path 参数。' };
      if (!('old_string' in args)) return { text: '缺少 old_string 参数（要替换的原文）。' };
      const oldString = str(args, 'old_string');
      const newString = str(args, 'new_string');
      if (!oldString) return { text: 'old_string 不能为空字符串。要新建文件请用 write_file。' };
      if (oldString === newString) return { text: 'old_string 与 new_string 相同，无需修改。' };

      const target = resolvePath(rawPath, ctx);
      let original: string;
      try {
        original = await fsp.readFile(target, 'utf8');
      } catch (err) {
        return { text: `读不到 ${target}：${(err as Error).message}。要新建文件请用 write_file。` };
      }

      const occurrences = original.split(oldString).length - 1;
      const replaceAll = args.all === true;
      if (occurrences === 0) {
        const head = original.slice(0, 400);
        return {
          text: [
            `补丁未应用：在 ${target} 里找不到 old_string。`,
            '常见原因：缩进不一致、换行符是 CRLF、或这段文本已被改过。',
            '请先 read_file 看当前真实内容，再原样复制一段更短且唯一的片段作为 old_string。',
            `文件前 400 字符：\n${head}`,
          ].join('\n'),
        };
      }
      if (occurrences > 1 && !replaceAll) {
        return {
          text: [
            `补丁未应用：old_string 在 ${target} 里出现了 ${occurrences} 次，无法确定改哪一处。`,
            '请扩大上下文（多带几行）让片段唯一，或明确传 all=true 表示全部替换。',
          ].join('\n'),
        };
      }

      const approved = await requestApproval({
        kind: 'fs-write',
        title: '修改文件',
        detail: `在 ${target} 里替换 ${replaceAll ? occurrences : 1} 处（-${oldString.length} +${newString.length} 字符）`,
        target,
        risk: riskOfPath(target, ctx.workspace?.path ?? null),
        chatId: ctx.chatId,
      });
      if (!approved) {
        return { text: `用户拒绝对 ${target} 的修改。请换一种不需要改这个文件的做法，或询问用户。`, denied: true };
      }

      const next = replaceAll ? original.split(oldString).join(newString) : original.replace(oldString, newString);
      try {
        await fsp.writeFile(target, next, 'utf8');
      } catch (err) {
        return { text: `写入失败：${(err as Error).message}` };
      }

      // 回填改动前后的上下文，让模型能自查
      const at = next.indexOf(newString);
      const from = Math.max(0, at - 160);
      const to = Math.min(next.length, at + newString.length + 160);
      const excerpt = at >= 0 ? next.slice(from, to) : '';
      return {
        text: [
          `已修改 ${target}：替换 ${replaceAll ? occurrences : 1} 处，${original.length} → ${next.length} 字符。`,
          excerpt ? `改动位置附近：\n…${excerpt}…` : '',
          '下一步建议：跑测试或 lint 确认没有改坏。',
        ]
          .filter(Boolean)
          .join('\n'),
        filePath: target,
      };
    },
  },
  {
    name: 'shell',
    label: '执行 shell',
    description:
      '在工作区里执行一条 shell 命令并返回 stdout/stderr/退出码。只用于装依赖、跑 lint、编译、跑测试、看版本；交互式或长阻塞命令请传 timeout_ms。审批模式下会请求授权。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令（Windows 走 cmd.exe，其它走 /bin/sh）' },
        timeout_ms: { type: 'number', description: '超时毫秒，默认取设置里的 30000' },
      },
      required: ['command'],
    },
    async run(args, ctx) {
      const command = str(args, 'command');
      if (!command.trim()) return { text: 'command 为空。' };
      const settings = getSettings();
      const approved = await requestApproval({
        kind: 'command',
        title: '执行终端命令',
        detail: command,
        target: ctx.workspace?.path ?? '应用数据目录',
        risk: 'high',
        chatId: ctx.chatId,
      });
      if (!approved) {
        return { text: `用户拒绝执行该命令：${command}。请改用不需要执行命令的方式，或说明命令的用途再询问。`, denied: true };
      }
      ctx.onProgress?.(`执行命令：${command}`);
      const result = await runCommand({
        command,
        workspaceId: ctx.workspace?.id ?? null,
        chatId: ctx.chatId,
        timeoutMs: num(args, 'timeout_ms', settings.sandboxTimeoutMs),
        onChunk: chunk => ctx.onProgress?.(chunk.text),
      });
      const body = [
        `退出码：${result.exitCode ?? '—'}${result.timedOut ? '（超时终止）' : ''} 耗时 ${result.durationMs}ms`,
        result.stdout ? `--- stdout ---\n${result.stdout}` : '',
        result.stderr ? `--- stderr ---\n${result.stderr}` : '',
        result.exitCode === 0 ? '结果：成功，继续下一步。' : '结果：失败。把 stderr 当成观察输入定位原因，改完再跑，不要原样重跑。',
      ]
        .filter(Boolean)
        .join('\n');
      return spill(body, `cmd-${Date.now()}`, ctx);
    },
  },
  {
    name: 'git_diff',
    label: '查看 diff',
    description:
      '读取工作区仓库的改动：默认 `git diff`（未暂存），staged=true 看已暂存，path 可只看某个文件。不写盘、不需要审批。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '只看某个文件或子目录，相对工作区' },
        staged: { type: 'boolean', description: '是否查看已暂存的改动（git diff --staged），默认 false' },
        stat_only: { type: 'boolean', description: '只要统计摘要（git diff --stat），默认 false' },
      },
      required: [],
    },
    async run(args, ctx) {
      const base = ctx.workspace?.path;
      if (!base) return { text: '当前会话没有关联工作区，无法查看 diff。' };
      try {
        const probe = await execText('git', ['rev-parse', '--is-inside-work-tree'], base, 8000);
        if (!probe.ok || !probe.stdout.trim().startsWith('true')) {
          return { text: `工作区 ${base} 不是一个 git 仓库（或没有安装 git），无法查看 diff。` };
        }
      } catch (err) {
        return { text: `调用 git 失败：${(err as Error).message}` };
      }

      const gitArgs = ['--no-pager', 'diff', '--no-color'];
      if (args.staged === true) gitArgs.push('--staged');
      if (args.stat_only === true) gitArgs.push('--stat');
      const scope = str(args, 'path').trim();
      if (scope) gitArgs.push('--', scope);

      const result = await execText('git', gitArgs, base, 20_000);
      if (!result.ok) return { text: `git diff 失败（退出码 ${result.code}）：${result.stderr.trim() || '无输出'}` };
      const diff = result.stdout.trim();
      if (!diff) return { text: `工作区没有${args.staged === true ? '已暂存的' : ''}改动。` };
      return spill(diff, `diff-${Date.now()}`, ctx);
    },
  },
  {
    name: 'finish',
    label: '结束任务',
    description:
      '声明任务完成并结束本轮执行。只有需求已实现、lint 无报错、测试通过、没有遗留高危操作时才调用。参数用于生成交付摘要，不会改动磁盘。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '这次做了什么（一两句话）' },
        changes: { type: 'array', items: { type: 'string' }, description: '变更清单：每个文件一条，如 `src/app.ts —— 新增 xxx`' },
        commands: { type: 'array', items: { type: 'string' }, description: '执行过的命令及其结果' },
        verification: { type: 'string', description: '验证结果：跑了哪些测试/lint，是否通过' },
      },
      required: ['summary'],
    },
    async run(args) {
      const changes = Array.isArray(args.changes) ? (args.changes as unknown[]).map(c => `- ${String(c)}`) : [];
      const commands = Array.isArray(args.commands) ? (args.commands as unknown[]).map(c => `- ${String(c)}`) : [];
      const rows = [
        `## 任务完成`,
        str(args, 'summary'),
        changes.length ? `\n### 变更清单\n${changes.join('\n')}` : '',
        commands.length ? `\n### 执行过的命令\n${commands.join('\n')}` : '',
        str(args, 'verification') ? `\n### 验证结果\n${str(args, 'verification')}` : '',
      ].filter(Boolean);
      return { text: rows.join('\n') };
    },
  },
  {
    name: 'web_search',
    label: '联网搜索',
    description: '联网检索信息。返回搜索结果摘要，适合在需要最新资料时使用。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '检索关键词' } },
      required: ['query'],
    },
    async run(args, ctx) {
      const query = str(args, 'query');
      ctx.onProgress?.(`搜索：${query}`);
      const text = await webSearch(query, ctx.signal);
      return spill(text, `search-${Date.now()}`, ctx);
    },
  },
  {
    name: 'read_web_page',
    label: '网页阅读',
    description: '抓取指定 URL 的正文并转为纯文本，适合阅读搜索结果里的具体页面。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '要抓取的完整 URL' } },
      required: ['url'],
    },
    async run(args, ctx) {
      const url = str(args, 'url');
      ctx.onProgress?.(`抓取：${url}`);
      const text = await readWebPage(url, ctx.signal);
      return spill(text, `page-${Date.now()}`, ctx);
    },
  },
  {
    name: 'write_file',
    label: '写入文件',
    description: '把内容写入本地文件。相对路径相对于当前工作区。审批模式下会请求用户授权。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件路径（相对工作区或绝对路径）' },
        content: { type: 'string', description: '文件内容' },
        append: { type: 'boolean', description: '是否追加而不是覆盖，默认 false' },
      },
      required: ['path', 'content'],
    },
    async run(args, ctx) {
      const target = resolvePath(str(args, 'path'), ctx);
      const content = str(args, 'content');
      const append = args.append === true;
      const approved = await requestApproval({
        kind: 'fs-write',
        title: append ? '追加写入文件' : '写入文件',
        detail: `${append ? '追加' : '写入'} ${content.length} 字符到 ${target}`,
        target,
        risk: riskOfPath(target, ctx.workspace?.path ?? null),
        chatId: ctx.chatId,
      });
      if (!approved) return { text: `用户拒绝了对 ${target} 的写入操作。请换一种不需要写文件的做法，或询问用户希望怎么处理。`, denied: true };
      await fsp.mkdir(path.dirname(target), { recursive: true });
      if (append) await fsp.appendFile(target, content, 'utf8');
      else await fsp.writeFile(target, content, 'utf8');
      const size = (await fsp.stat(target)).size;
      return { text: `已写入 ${target}（${size} 字节）`, filePath: target };
    },
  },
  {
    name: 'read_file',
    label: '读取文件',
    description: '读取本地文本文件内容。图片等二进制文件会返回元信息。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径' }, max_bytes: { type: 'number', description: '最多读取字节数，默认 20000' } },
      required: ['path'],
    },
    async run(args, ctx) {
      const target = resolvePath(str(args, 'path'), ctx);
      const limit = Math.min(200_000, Math.max(1000, num(args, 'max_bytes', 20_000)));
      try {
        const stat = await fsp.stat(target);
        if (stat.isDirectory()) {
          const entries = await fsp.readdir(target);
          return { text: `目录 ${target} 包含：\n${entries.slice(0, 200).join('\n')}` };
        }
        const head = await fsp.open(target, 'r');
        const buf = Buffer.alloc(Math.min(limit, stat.size));
        await head.read(buf, 0, buf.length, 0);
        await head.close();
        const text = buf.toString('utf8');
        return spill(`文件 ${target}（${stat.size} 字节）：\n\n${text}`, `read-${Date.now()}`, ctx);
      } catch (err) {
        return { text: `读取失败：${(err as Error).message}` };
      }
    },
  },
  {
    name: 'list_files',
    label: '列出文件',
    description: '列出当前工作区内的文件（最多 400 条）。',
    parameters: { type: 'object', properties: {}, required: [] },
    hidden: true,
    async run(_args, ctx) {
      if (!ctx.workspace) return { text: '当前会话没有关联工作区，无法列出文件。' };
      const files = await listWorkspaceFiles(ctx.workspace);
      if (!files.length) return { text: `工作区 ${ctx.workspace.path} 目前是空的。` };
      return spill(files.map(f => `${f.relPath} · ${f.kind} · ${f.size}B`).join('\n'), `files-${Date.now()}`, ctx);
    },
  },
  {
    name: 'delete_file',
    label: '删除文件',
    description: '删除文件或空目录。审批模式下必定请求用户授权。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '要删除的路径' } },
      required: ['path'],
    },
    async run(args, ctx) {
      const target = resolvePath(str(args, 'path'), ctx);
      const approved = await requestApproval({
        kind: 'fs-delete',
        title: '删除文件',
        detail: `将删除 ${target}，此操作不可恢复`,
        target,
        risk: 'high',
        chatId: ctx.chatId,
      });
      if (!approved) return { text: `用户拒绝删除 ${target}。请不要重复尝试删除，改为告知用户文件仍在。`, denied: true };
      try {
        await fsp.rm(target, { recursive: false, force: false });
        return { text: `已删除 ${target}` };
      } catch (err) {
        return { text: `删除失败：${(err as Error).message}` };
      }
    },
  },
  {
    name: 'run_command',
    label: '执行终端命令',
    description: '在工作区沙箱目录里执行一条 shell 命令，返回 stdout/stderr。审批模式下必定请求授权。',
    hidden: true,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令（Windows 走 cmd.exe，其它走 /bin/sh）' },
        timeout_ms: { type: 'number', description: '超时毫秒，默认取设置里的 30000' },
      },
      required: ['command'],
    },
    async run(args, ctx) {
      // 与 shell 同一套实现，保留旧名供历史会话使用
      return TOOLS.find(t => t.name === 'shell')!.run(args, ctx);
    },
  },
  {
    name: 'run_code',
    label: '代码沙箱',
    description: '在受限沙箱里运行 Python 或 Node 脚本，返回 stdout/stderr 与产物文件。',
    parameters: {
      type: 'object',
      properties: {
        runtime: { type: 'string', enum: ['python', 'node'], description: '运行时' },
        code: { type: 'string', description: '完整脚本内容' },
        timeout_ms: { type: 'number', description: '超时毫秒' },
      },
      required: ['runtime', 'code'],
    },
    async run(args, ctx) {
      const runtime = str(args, 'runtime', 'python') === 'node' ? 'node' : 'python';
      const info = runtimeInfo();
      if (!info[runtime]) return { text: installHint(runtime) };
      ctx.onProgress?.(`运行 ${runtime} 脚本…`);
      const result = await runCode({
        runtime,
        code: str(args, 'code'),
        workspaceId: ctx.workspace?.id ?? null,
        chatId: ctx.chatId,
        timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
        onChunk: chunk => ctx.onProgress?.(chunk.text),
      });
      const body = [
        `${result.ok ? '执行成功' : '执行失败'} · 退出码 ${result.exitCode ?? '—'} · ${result.durationMs}ms${result.timedOut ? ' · 超时终止' : ''}`,
        result.stdout ? `--- stdout ---\n${result.stdout}` : '',
        result.stderr ? `--- stderr ---\n${result.stderr}` : '',
        result.files.length ? `--- 产物 ---\n${result.files.join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      const spooled = await spill(body, `code-${Date.now()}`, ctx);
      // 脚本产出的文件也在对话里列出来（图片直接预览）
      return { ...spooled, files: result.files.length ? result.files : undefined };
    },
  },
  {
    name: 'generate_image',
    label: '图片生成',
    description:
      '生成图片并落到当前会话的产物目录。没有可用的外部出图后端时会自动改用内置渲染（本地程序化绘制，一定能出图）。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述' },
        size: { type: 'string', description: '尺寸，如 1024x1024' },
        style: { type: 'string', description: '风格预设' },
      },
      required: ['prompt'],
    },
    async run(args, ctx) {
      const { generateImages } = await import('./imagegen');
      const result = await generateImages({
        prompt: str(args, 'prompt'),
        size: str(args, 'size', '1024x1024'),
        count: 1,
        style: str(args, 'style', ''),
        workspaceId: ctx.workspace?.id ?? null,
        chatFolder: ctx.chatFolder ?? null,
        chatId: ctx.chatId,
      });
      if (!result.ok) return { text: `图片生成失败：${result.error}` };
      const files = (result.images ?? []).flatMap(i => i.files.map(f => f.path));
      // 内置渲染 / 降级时把原因说清楚，模型才知道该怎么向用户解释
      const via = result.provider?.startsWith('builtin') ? `内置渲染 · ${result.provider.split(':')[1] ?? ''}` : result.provider;
      const lines = [`已生成 ${files.length} 张图片（${via ?? '图片后端'}）：`, ...files];
      if (result.note) lines.push('', `说明：${result.note}`);
      return {
        text: lines.join('\n'),
        filePath: files[0],
        // 全部产物都带回去，渲染层直接在对话里内联显示
        files,
      };
    },
  },
];

export const TOOL_MAP = new Map(TOOLS.map(t => [t.name, t]));

/** 暴露给模型的工具（隐藏的旧名只用于兼容历史会话，不进 schema） */
function visibleTools(): ToolDef[] {
  return TOOLS.filter(t => !t.hidden);
}

export function builtinSchemas(): LlmToolSchema[] {
  return visibleTools().map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

export function toolCatalogText(extra: { source: string; name: string; description: string }[] = []): string {
  const lines = visibleTools().map(t => `- ${t.name}（${t.label}）：${t.description}`);
  for (const e of extra) lines.push(`- ${e.name}（来自 MCP 服务器 ${e.source}）：${e.description}`);
  return lines.join('\n');
}

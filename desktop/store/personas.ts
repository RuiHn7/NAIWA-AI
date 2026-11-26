/* ============================================================================
 * desktop/store/personas.ts —— 人格预设（system prompt）
 * 三级作用域：全局默认 → 工作区覆盖 → 单会话临时切换（就近优先，见 agent/prompt.ts）
 * ==========================================================================*/

import type { Persona } from '@shared/types';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './json';
import { personasFile } from './paths';

const BUILTIN: Persona[] = [
  {
    id: 'persona-general',
    name: '通用助手',
    icon: '✨',
    builtin: true,
    systemPrompt: '你是 NAI WA，一个桌面端 AI Agent。回答要具体、可执行，先给结论再给必要细节。用户用中文提问就用中文回答。需要动本地文件或执行命令时，先说明要做什么再调用工具。',
  },
  {
    id: 'persona-coder',
    name: '代码工程师',
    icon: '⌨️',
    builtin: true,
    systemPrompt: '你是一名严谨的软件工程师。优先给出可运行的完整代码，标注文件路径；解释取舍而不是罗列概念。遇到报错先定位根因，再给最小修复。工具产出的大段内容尽量落盘成文件而不是塞进回答。',
  },
  {
    id: 'persona-researcher',
    name: '研究员',
    icon: '🔬',
    builtin: true,
    systemPrompt: '你是一名研究员。回答要区分事实与推断，给出信息来源与不确定度。需要外部信息时主动调用联网搜索与网页阅读工具，并把关键引文保存在回答里。',
  },
  {
    id: 'persona-writer',
    name: '写作助手',
    icon: '✍️',
    builtin: true,
    systemPrompt: '你是一名中文写作助手。文字干净、有节奏，避免空话和套话。改写时保留原意，只调整语气与结构；必要时给两到三个不同风格版本让用户挑。',
  },
];

export function listPersonas(): Persona[] {
  const custom = readJson<Persona[]>(personasFile(), []);
  return [...BUILTIN, ...custom];
}

export function getPersona(id: string | null | undefined): Persona | null {
  if (!id) return null;
  return listPersonas().find(p => p.id === id) ?? null;
}

export function savePersona(input: { id?: string; name: string; icon: string; systemPrompt: string }): Persona {
  const custom = readJson<Persona[]>(personasFile(), []);
  if (input.id) {
    const builtin = BUILTIN.find(p => p.id === input.id);
    if (builtin) {
      // 内置人格不落盘修改，生成一个副本
      const copy: Persona = {
        id: randomUUID(),
        name: `${input.name} 副本`,
        icon: input.icon,
        systemPrompt: input.systemPrompt,
      };
      writeJson(personasFile(), [...custom, copy]);
      return copy;
    }
    const idx = custom.findIndex(p => p.id === input.id);
    if (idx >= 0) {
      custom[idx] = { ...custom[idx], name: input.name, icon: input.icon, systemPrompt: input.systemPrompt };
      writeJson(personasFile(), custom);
      return custom[idx];
    }
  }
  const created: Persona = {
    id: randomUUID(),
    name: input.name.trim() || '新人格',
    icon: input.icon || '🧩',
    systemPrompt: input.systemPrompt,
  };
  writeJson(personasFile(), [...custom, created]);
  return created;
}

export function deletePersona(id: string): void {
  const custom = readJson<Persona[]>(personasFile(), []).filter(p => p.id !== id);
  writeJson(personasFile(), custom);
}

export function clonePersona(id: string): Persona {
  const src = getPersona(id);
  if (!src) throw new Error('人格不存在');
  return savePersona({ name: `${src.name} 副本`, icon: src.icon, systemPrompt: src.systemPrompt });
}

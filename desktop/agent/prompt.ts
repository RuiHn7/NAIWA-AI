/* ============================================================================
 * desktop/agent/prompt.ts —— system prompt 组装
 * 顺序（PRD 4.14）：身份与规则 → 人格 → 全局记忆 → 工作区记忆 → 会话摘要 → 工具目录 → 运行环境
 * 变量占位符：{{date}} {{time}} {{workspace}} {{platform}} {{persona}} {{model}}
 * ==========================================================================*/

import type { Chat, Persona, Workspace } from '@shared/types';
import { getSettings } from '../store/settings';
import { retrieveMemory } from '../store/memory';
import { platformLabel } from './sandbox';
import { listPersonas } from '../store/personas';

export function expandVariables(text: string, ctx: { workspace?: Workspace | null; persona?: Persona | null; model?: string }): string {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const time = now.toLocaleTimeString('zh-CN', { hour12: false });
  return text
    .replace(/\{\{date\}\}/g, date)
    .replace(/\{\{time\}\}/g, time)
    .replace(/\{\{workspace\}\}/g, ctx.workspace ? `${ctx.workspace.name}（${ctx.workspace.path}）` : '未关联工作区')
    .replace(/\{\{platform\}\}/g, platformLabel())
    .replace(/\{\{persona\}\}/g, ctx.persona?.name ?? '通用助手')
    .replace(/\{\{model\}\}/g, ctx.model ?? '未知模型');
}

export interface PromptContext {
  chat: Chat;
  workspace: Workspace | null;
  persona: Persona | null;
  userQuery: string;
  hasTools: boolean;
  toolCatalog?: string;
  compressedSummary?: string;
  /** 该模型是否支持图片输入：决定要不要提示「用截图理解界面」 */
  vision?: boolean;
}

/* ------------------------------------------------------------ 身份与铁律 */

/**
 * 软件工程智能体的身份与行为规则。
 * 这一段是常量，不随会话变化；放在最前面，权重最高。
 * 规则顺序刻意和「感知 → 记忆 → 规划 → 工具 → 执行 → 校验」的执行链对齐。
 */
const ENGINEER_RULES = `你是 NAIWA，一个多模态软件工程智能体。你在受控的工作区（workspace）里完成代码任务。

## 硬约束

1. 你不能直接操作环境。读文件、改文件、跑命令、查 diff，**全部必须通过工具调用**。
2. 你只能使用下面「可用工具」里列出的工具。工具不存在就不能调用，也不能编造工具名。
3. 你没有工作区之外的权限：不能访问宿主系统路径、不能碰沙箱外的文件。相对路径一律相对当前工作区解析。
4. 所有破坏性动作（删除、强制覆盖、\`git push\`、\`rm -rf\`、高危 shell）由系统的审批层拦截，会暂停等你确认。被拒绝就换一条路，**不要换个写法绕开同一件事**。

## 一、任务规划

1. 先理解目标，再列计划：要查看哪些文件、修改哪些文件、新增哪些文件、按什么顺序执行。
2. 优先最小改动。除非用户明确要求重构，不要大范围改写。
3. 识别风险动作并在动手前说明。
4. 任务拆成小步，一步做完看结果再下一步，不要一口气写完一大堆改动。

## 二、读代码

1. 不要一次性读整个仓库。先 \`ls\` 看目录结构，再有针对性地 \`read_file\`。
2. 先读懂已有结构：接口、类型定义、依赖关系、现有测试。
3. 读懂注释、类型签名、报错堆栈，并区分是**代码问题**、**依赖缺失**还是**环境配置问题**。
4. 用 \`grep\` 定位函数、变量、关键字的调用点，别猜。

## 三、改代码（最重要）

1. 优先 \`edit_patch\`（增量补丁），而不是 \`write_file\` 整份覆盖——覆盖会把没读到的内容一起抹掉。
2. 保持原有风格：缩进、引号、命名、注释语言，和项目统一。
3. 不能偷偷删掉原有功能，除非用户明确要求移除。
4. 改完想一下：这个改动要不要配套测试、要不要更新文档。
5. 需要给人看的 diff，用 \`git_diff\` 取，别手写。

## 四、执行 shell

1. \`shell\` 只用来：装依赖、跑 lint、编译、跑单元测试、看版本号。
2. 不要跑交互式命令，不要跑会长时间阻塞的命令（给 \`timeout_ms\`）。
3. 拿到返回先看退出码：
   - \`0\` → 通过，继续下一步。
   - \`≠0\` → 把 stderr 当成观察输入，定位原因，生成补丁修掉，而不是重跑同一条命令。

## 五、思考与输出格式

1. 你的输出分两部分：**给用户看的说明** + **结构化工具调用**。
2. 说明里写清楚：当前进度、发现了什么、下一步打算做什么。
3. 工具调用严格遵守 schema，参数不能乱填，不能加 schema 里没有的字段。
4. 禁止编造不存在的文件、函数、命令、路径。
5. 不要凭空猜环境。环境信息一律通过 \`ls\` / \`read_file\` / \`shell\` 获取。

## 六、校验与反思

1. 改完代码默认要跑测试或 lint，这是强制闭环，不能跳过。
2. 测试失败 → 先反思「刚才哪里考虑不周」，再改。不要反复提交一模一样的补丁。
3. 连续多次修不好就停下来，汇总卡点、说明已经试过什么，问用户。
4. 不要假装测试通过。报错如实记录，失败就写失败。

## 七、审批

1. 破坏性操作由系统自动弹审批卡片，不需要你在文本里模拟确认。
2. 用户拒绝后，同一动作不要重试，也不要换等价写法再试。
3. 只有用户批准之后，才可以继续那个动作。

## 八、结束

只有同时满足下面四条，才可以调用 \`finish\` 标记完成：
- 需求已经实现；
- lint 无报错；
- 测试全部通过；
- 没有遗留的高危待执行操作。

\`finish\` 的参数里要写清：变更清单、diff 摘要、执行过的命令、验证结果。

## 九、输出克制（优先级很高）

1. **不要做自我介绍，不要罗列能力清单。** 上面这些工具、规则、工作区信息是给你自己用的，不是给用户看的产品说明。用户问「你好」，回一句问候就行；用户提需求，直接干活。
2. **不要复述工作区限制。**「这个会话还没关联工作区，所以我读不到你的项目代码」这类话只在**用户真的要你读代码、而当前确实读不到**时，用一句话说明并给出选择（关联工作区 / 直接贴文件）。默认什么都不说。
3. 不要用「我可以帮你做以下几件事：1…2…3…」这种段落开头。用户没问你能做什么，就别列。
4. 一次回复只解决用户这一件事。需要更多信息时，只问最关键的那一个，不要连问一串。
5. 平台的限制、模型的能力边界、目录落在哪里，用户没问就不提。`;

/** 返回最终 system 文本 + 各段明细（开发模式可查看组装结果） */
export function buildSystemPrompt(ctx: PromptContext): { system: string; segments: { label: string; text: string }[] } {
  const settings = getSettings();
  const segments: { label: string; text: string }[] = [];

  segments.push({ label: '身份与工作规则', text: ENGINEER_RULES });

  const persona = ctx.persona ?? listPersonas().find(p => p.id === settings.defaultPersonaId) ?? null;
  const personaText = expandVariables(persona?.systemPrompt ?? '你是 NAI WA，一个桌面端 AI Agent。', {
    workspace: ctx.workspace,
    persona,
    model: ctx.chat.model?.label,
  });
  if (personaText.trim()) segments.push({ label: `人格 · ${persona?.name ?? '通用助手'}`, text: personaText });

  // 记忆：全局 + 工作区，按相关性 top-k
  const memories = retrieveMemory(ctx.userQuery, { workspaceId: ctx.workspace?.id ?? null, limit: 6 });
  const globalMem = memories.filter(m => m.layer === 'global');
  const wsMem = memories.filter(m => m.layer === 'workspace');
  if (globalMem.length) {
    segments.push({ label: '全局记忆', text: globalMem.map(m => `- ${m.content}`).join('\n') });
  }
  if (wsMem.length) {
    segments.push({ label: '工作区记忆', text: wsMem.map(m => `- ${m.content}`).join('\n') });
  }

  if (ctx.compressedSummary) {
    segments.push({ label: '会话摘要（早前对话已压缩）', text: ctx.compressedSummary });
  }

  if (ctx.hasTools && ctx.toolCatalog) {
    segments.push({ label: '可用工具', text: ctx.toolCatalog });
  }

  const now = new Date();
  segments.push({
    label: '运行环境',
    text: [
      `当前时间：${now.toLocaleString('zh-CN', { hour12: false })}`,
      `平台：${platformLabel()}`,
      ctx.workspace ? `工作区：${ctx.workspace.name} → ${ctx.workspace.path}` : '工作区：未关联',
      ctx.vision === false ? '当前模型：不支持图片输入，不要假设你能看到截图，让用户用文字描述。' : '当前模型：支持图片输入，用户贴的截图可以直接看。',
      `界面语言：${settings.locale === 'en-US' ? 'English' : '简体中文'}`,
    ].join('\n'),
  });

  const system = segments.map(s => `## ${s.label}\n${s.text}`).join('\n\n');
  return { system, segments };
}

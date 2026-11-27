/* ============================================================================
 * src/lib/i18n.ts —— 轻量 i18n
 *   设计取向：以「中文原文」为键。组件里写 t('新对话')，
 *   词典里没有对应条目时原样返回中文 —— 覆盖是增量的，漏翻不会白屏也不会崩。
 *
 *   不引第三方库：本项目字符串量级不大，一张表 + 一个 hook 就够，
 *   也避免再给渲染层加依赖。
 * ==========================================================================*/

import { useApp } from '@/store/useApp';
import type { Locale } from '@shared/types';

/* ------------------------------------------------------------ 英文词典 */

export const EN: Record<string, string> = {
  /* ---------------- 侧栏 */
  新对话: 'New chat',
  工作区: 'Workspace',
  权限: 'Permissions',
  搜索会话: 'Search chats',
  搜索: 'Search',
  设置: 'Settings',
  折叠侧栏: 'Collapse sidebar',
  展开侧栏: 'Expand sidebar',
  本地工作台: 'Local workspace',
  收起侧栏: 'Collapse sidebar',
  今天: 'Today',
  昨天: 'Yesterday',
  '近 7 天': 'Previous 7 days',
  更早: 'Earlier',
  跨年: 'Older',
  置顶: 'Pinned',
  没有匹配的会话: 'No matching chats',
  还没有会话: 'No chats yet',
  重命名: 'Rename',
  取消置顶: 'Unpin',
  导出: 'Export',
  导出为: 'Export as',
  删除会话: 'Delete chat',
  会话: 'Chat',
  '调整侧栏宽度': 'Resize sidebar',
  会话栏: 'Chat list',
  '新对话 (Ctrl+N)': 'New chat (Ctrl+N)',
  工作区与产物: 'Workspace & artifacts',
  会话操作: 'Chat actions',
  条消息: 'messages',
  '单文件 HTML': 'Single-file HTML',

  /* ---------------- 顶栏 */
  切换模型: 'Switch model',
  切换人格: 'Switch persona',
  关联工作区: 'Workspace',
  无工作区: 'No workspace',
  不关联: 'None',
  管理接入项: 'Manage providers',
  管理人格: 'Manage personas',
  管理工作区: 'Manage workspaces',
  导出当前会话: 'Export chat',
  右侧栏: 'Side panel',
  打开右侧栏: 'Open side panel',
  收起右侧栏: 'Close side panel',
  切换侧栏: 'Toggle sidebar',
  点击重命名: 'Click to rename',
  选择模型: 'Select model',
  '管理…': 'Manage…',
  通用助手: 'General assistant',
  '展开侧栏 (Ctrl+B)': 'Expand sidebar (Ctrl+B)',
  '折叠侧栏 (Ctrl+B)': 'Collapse sidebar (Ctrl+B)',
  '还没有可用模型，请到「设置 → 接入模型」添加接入项':
    'No model available yet — add a provider in Settings → Providers',
  已导出到: 'Exported to',

  /* ---------------- 空态 / 建议卡 */
  '有什么可以帮你？': 'What can I help with?',
  '可以聊天、查资料、读写文件、跑代码、生成图片 —— 需要动手时会先问你。':
    'Chat, research, read and write files, run code, generate images — it asks before acting.',
  解释一个概念: 'Explain a concept',
  '用通俗的话讲清楚': 'In plain language',
  写点代码: 'Write some code',
  '脚本、组件、小工具': 'Scripts, components, small tools',
  查点资料: 'Look something up',
  '联网搜索 + 读网页': 'Web search + page reading',
  整理文件: 'Tidy files',
  '在工作区里动手': 'Work inside a workspace',
  '用通俗的话解释一下扩散模型是怎么生成图片的':
    'Explain in plain language how diffusion models generate images',
  '写一个 Python 脚本，把某个目录下的所有图片按拍摄时间重命名':
    'Write a Python script that renames every image in a folder by capture time',
  '帮我查一下 Electron 45 相比 44 有哪些值得注意的变化':
    'Look up what changed in Electron 45 compared with 44',
  '列一下当前工作区的文件结构，并给出一份整理建议':
    'List the files in this workspace and suggest how to tidy them up',
  执行计划: 'Plan',
  打开产物文件: 'Open output file',
  产物: 'Outputs',
  字: 'chars',

  /* ---------------- 输入区 */
  '给 NAI WA 发消息…': 'Message NAI WA…',
  未接入: 'Not connected',
  '先新建一个会话': 'Create a chat first',
  '正在聆听…': 'Listening…',
  结束: 'Finish',
  添加附件: 'Add attachment',
  添加: 'Add',
  任意类型: 'Any type',
  '还没有可用模型，先去接入一个': 'No model available yet — connect one first',
  结束语音输入: 'Stop voice input',
  松开即可添加文件: 'Release to add files',
  '停止生成 (Esc)': 'Stop generating (Esc)',
  '发送 (⏎)': 'Send (⏎)',
  '把更早的消息压成摘要，释放上下文': 'Summarise earlier messages to free up context',
  条: 'msgs',
  已压缩: 'compressed',
  '⏎ 发送 · ⇧⏎ 换行': '⏎ send · ⇧⏎ newline',
  'NAI WA 会犯错，请核对重要信息 · Enter 发送 / Shift+Enter 换行':
    'NAI WA can make mistakes — double-check important details · Enter to send / Shift+Enter for newline',
  发送: 'Send',
  停止: 'Stop',
  停止生成: 'Stop generating',
  压缩上下文: 'Compress',
  压缩上文: 'Compress',
  思考强度: 'Thinking',
  轮: 'turns',
  步: 'steps',
  缓存命中: 'cache',
  上下文长度: 'Context window',
  跟随模型: 'Follow model',
  '只影响这个会话的上下文窗口，压缩阈值与进度圆环会跟着变。':
    'Affects this conversation only — the compress threshold and progress ring follow it.',
  账户余额: 'Balance',
  自动: 'Auto',
  用户发起的对话轮次: 'Conversation turns you started',
  模型回复与工具调用的总步数: 'Model replies plus tool calls',
  最近一条回复的生成速度: 'Generation speed of the latest reply',
  选择文件: 'Choose file',
  选择图片: 'Choose image',
  图片生成: 'Images',
  清空附件: 'Clear attachments',
  附件: 'Attachments',
  语音输入: 'Voice input',
  停止录音: 'Stop recording',
  '响应快，适合日常问答': 'Fast, good for everyday questions',
  '默认档，质量和速度平衡': 'Balanced quality and speed',
  '深度推理，较慢': 'Deeper reasoning, slower',
  '当前环境不支持语音识别，可用系统听写输入':
    'Speech recognition is unavailable here — use your system dictation instead',
  '麦克风权限被拒绝，请在系统设置里允许': 'Microphone permission denied — allow it in system settings',
  无法启动语音识别: 'Could not start speech recognition',
  '松手取消': 'Release to cancel',
  '把文件拖到这里': 'Drop files here',

  /* ---------------- 消息 */
  复制: 'Copy',
  代码: 'code',
  已复制: 'Copied',
  代码已复制: 'Code copied',
  已压缩更早的对话: 'Earlier messages compressed',
  请求失败: 'Request failed',
  已停止生成: 'Generation stopped',
  本次用量: 'Token usage for this reply',
  删除这条消息: 'Delete this message',
  编辑并重新发送: 'Edit and resend',
  编辑: 'Edit',
  删除: 'Delete',
  保存: 'Save',
  取消: 'Cancel',
  确定: 'Confirm',
  重试: 'Retry',
  重新生成: 'Regenerate',
  有帮助: 'Helpful',
  没帮助: 'Not helpful',
  思考过程: 'Reasoning',
  思考中: 'Thinking',
  展开: 'Expand',
  收起: 'Collapse',
  回到最新: 'Jump to latest',
  已停止: 'Stopped',
  '（无输出）': '(no output)',
  '正在执行…': 'Running…',
  '操作未获授权，已跳过。': 'Not authorised — skipped.',
  执行失败: 'Failed',
  正在生成: 'Generating',

  /* ---------------- 审批 */
  '需要你确认': 'Needs your approval',
  '本次会话内同类操作不再询问': "Don't ask again for this type of action in this chat",
  同意: 'Allow',
  拒绝: 'Deny',
  高风险: 'High risk',
  中风险: 'Medium risk',
  低风险: 'Low risk',
  写入文件: 'Write file',
  删除文件: 'Delete file',
  执行命令: 'Run command',
  安装依赖: 'Install dependency',
  网络请求: 'Network request',
  外部工具: 'External tool',
  调用外部工具: 'Call external tool',
  写入: 'write',
  追加: 'append',
  字符到: 'characters to',
  来自外部服务器: 'From external server',
  将删除: 'Will delete',
  '，此操作不可恢复': ' — this cannot be undone',
  /* ---------------- 工具卡片（desktop/agent/tools.ts 的 label） */
  列出目录: 'List directory',
  搜索代码: 'Search code',
  增量改文件: 'Patch file',
  '执行 shell': 'Run shell',
  '查看 diff': 'View diff',
  结束任务: 'Finish task',
  联网搜索: 'Web search',
  网页阅读: 'Page reader',
  读取文件: 'Read file',
  列出文件: 'List files',
  执行终端命令: 'Run command',
  代码沙箱: 'Code sandbox',
  /* ---------------- 内置人格名（desktop/store/personas.ts） */
  代码工程师: 'Staff engineer',
  研究员: 'Researcher',
  写作助手: 'Writing partner',
  确认策略: 'Approval policy',
  '当前是「完全放行」：读写文件、执行命令都不会再问你。审计记录仍然会写。':
    'Currently "allow everything": file writes and commands run without asking. The audit log is still recorded.',
  '当前是「按需确认」：涉及磁盘写入、删除、执行命令、外部工具调用时会先弹确认卡。':
    'Currently "ask when needed": writes, deletes, commands and external tool calls raise a confirmation card first.',
  完全放行: 'Allow everything',
  '只在你完全信任当前工作区时打开。打开后 Agent 的任何动作都不会再征询。':
    'Only turn this on if you fully trust the current workspace. The agent will never ask again.',
  风险提示: 'Risk levels',
  '低风险是工作区内的读操作，高风险是删除、越界路径与命令执行。':
    'Low is reads inside the workspace; high is deletion, out-of-scope paths and command execution.',
  低: 'Low',
  中: 'Medium',
  高: 'High',
  待确认: 'Pending',
  '这些是 Agent 正在等待你回答的动作。': 'These are the actions the agent is waiting on.',
  没有待确认的动作: 'Nothing waiting for approval',
  一切正常: 'All clear',
  操作记录: 'Audit log',
  '每次确认或拒绝都会留一条，只存在本机。':
    'Every approval or denial leaves one entry, stored on this machine only.',
  '还没有记录。': 'No entries yet.',
  已同意: 'approved',
  已拒绝: 'denied',
  自动放行: 'auto',

  /* ---------------- 右栏 */
  文件: 'Files',
  浏览: 'Browse',
  打开: 'Open',
  打开文件夹: 'Open folder',
  收起面板: 'Close panel',
  刷新: 'Refresh',
  在文件管理器里打开: 'Show in file manager',
  '过滤文件…': 'Filter files…',
  没有匹配的文件: 'No matching files',
  工作区还是空的: 'Workspace is empty',
  用系统程序打开: 'Open with system app',
  关闭预览: 'Close preview',
  无法读取该文件: 'Could not read this file',
  这个类型不支持内联预览: 'This file type cannot be previewed inline',
  输入网址: 'Enter a URL',
  '（空）': '(none)',
  '在设置 → 工作区里选一个，或从顶栏切一个工作区过来。':
    'Pick one in Settings → Workspaces, or switch it from the top bar.',
  '这个会话还没关联工作区。': 'This chat has no workspace yet.',
  '去关联一个工作区，就能在这里看到文件。': 'Link a workspace to see its files here.',
  还没有文件: 'No files yet',
  '调整一下搜索词试试。': 'Try a different search term.',
  '这个地址不在内置浏览的白名单里。': 'This address is not on the built-in browser allowlist.',
  '去设置里调整': 'Change in settings',
  当前允许: 'Allowed',

  /* ---------------- 命令面板 */
  命令面板: 'Command palette',
  '输入命令或搜索会话…': 'Type a command or search chats…',
  '搜索会话或输入命令…': 'Search chats or type a command…',
  没有匹配的会话或命令: 'No matching chats or commands',
  '导出当前会话（Markdown）': 'Export current chat (Markdown)',
  新建对话: 'New chat',
  打开设置: 'Open settings',
  压缩当前上下文: 'Compress current context',
  导出当前会话为文件: 'Export current chat',
  切换到深色主题: 'Switch to dark theme',
  切换到浅色主题: 'Switch to light theme',
  '设置 · 通用': 'Settings · General',
  '设置 · 接入模型': 'Settings · Providers',
  '设置 · 工作区': 'Settings · Workspaces',
  '设置 · 记忆': 'Settings · Memory',
  '设置 · 人格': 'Settings · Personas',
  '设置 · MCP 工具': 'Settings · MCP tools',
  '设置 · 定时任务': 'Settings · Scheduled tasks',
  '设置 · 图片生成': 'Settings · Image generation',
  '设置 · 用量统计': 'Settings · Usage',
  '设置 · 权限与审计': 'Settings · Approval & audit',
  '设置 · 快捷键': 'Settings · Shortcuts',

  /* ---------------- 设置外壳 */
  通用: 'General',
  接入模型: 'Providers',
  记忆: 'Memory',
  人格: 'Personas',
  'MCP 工具': 'MCP tools',
  定时任务: 'Scheduled tasks',
  用量: 'Usage',
  权限与审计: 'Approval & audit',
  快捷键: 'Shortcuts',
  '主题、语言、默认思考强度': 'Theme, language, default thinking',
  'OpenAI 兼容 / Anthropic / Gemini 接入项': 'OpenAI-compatible / Anthropic / Gemini providers',
  '关联本地目录，文件与记忆都以它为单位': 'Local folders — the unit for files and memory',
  '全局 / 工作区 / 会话三层长期记忆': 'Global / workspace / session long-term memory',
  '自定义系统提示词，可按会话切换': 'Custom system prompts, switchable per chat',
  '连接外部 MCP 服务器并挑选工具': 'Connect external MCP servers and pick tools',
  '按时间或 cron 自动跑一段对话': 'Run a chat on a schedule or cron',
  '接入出图后端，直接生成图片': 'Image backends and quick generation',
  'Token 消耗与预估费用': 'Token spend and estimated cost',
  '两档权限、待确认请求与审计日志': 'Two permission modes, pending requests, audit log',
  '键盘操作一览': 'Keyboard reference',

  /* ---------------- 设置正文 · 通用 */
  外观: 'Appearance',
  '深色是默认主题；选择「跟随系统」时会随系统外观切换。':
    'Dark is the default; "Follow system" tracks your OS appearance.',
  主题: 'Theme',
  跟随系统: 'Follow system',
  深色: 'Dark',
  浅色: 'Light',
  界面语言: 'Language',
  对话: 'Conversation',
  '默认值会在新建会话时套用，之后仍可在输入区随时切换。':
    'Defaults apply to new chats; you can still switch per chat from the composer.',
  默认思考强度: 'Default thinking level',
  默认: 'Default',
  'Low 更快，Max 更深但更慢，也更容易花掉上下文。':
    'Low is faster; Max reasons deeper but is slower and burns context.',
  默认人格: 'Default persona',
  上下文压缩: 'Context compression',
  '自动压缩会在用量超过阈值时把更早的消息折成摘要；手动压缩永远可用，自动压缩结果不理想时可以自己再折一次。':
    'Auto compression folds older messages into a summary once usage passes the threshold. Manual compression is always available — use it when the automatic result is not good enough.',
  自动压缩上下文: 'Auto-compress context',
  '关掉以后上下文会一直增长，直到撞上模型窗口上限才报错。':
    'When off, context keeps growing until it hits the model window and the request fails.',
  压缩阈值: 'Compress threshold',
  '用量达到窗口的这个比例时触发；越高手动空间越大，越低越省 token。':
    'Triggered when usage reaches this share of the window. Higher leaves more headroom; lower saves more tokens.',
  计费: 'Billing',
  '用于估算「用量」页面里的费用，不影响实际扣费。':
    'Only used to estimate cost on the Usage page — it never triggers real charges.',
  输入费率: 'Input rate',
  输出费率: 'Output rate',
  '美元 / 百万 token': 'USD / 1M tokens',
  系统: 'System',
  桌面通知: 'Desktop notifications',
  '定时任务跑完后发系统通知。': 'Notify after a scheduled task finishes.',
  提交前确认: 'Confirm before acting',
  '关闭后所有文件写入、命令执行都不再询问，请谨慎。':
    'When off, file writes and commands run without asking. Be careful.',
  内置浏览: 'Built-in browser',
  '右侧「浏览」标签只允许打开这些地址，一行一个，支持 * 通配。':
    'The Browse tab may only open these addresses, one per line, * wildcard supported.',
  允许访问: 'Allowed addresses',
  关于: 'About',
  版本: 'Version',
  平台: 'Platform',
  已就绪: 'ready',
  未检测到: 'not found',

  /* ---------------- 设置正文 · 工作区 */
  '绑定目录后，Agent 才能读文件、写文件、跑脚本；未绑定时会落到临时沙箱里，会话结束不保留。':
    'Linking a folder lets the agent read, write and run scripts there. Without one it falls back to a temporary sandbox that is discarded when the chat ends.',
  还没有工作区: 'No workspaces yet',
  选一个目录当工作区: 'Pick a folder as a workspace',
  '建议单独建一个空目录，别直接指向系统盘根目录。':
    'Create a dedicated empty folder rather than pointing at a drive root.',
  工作区已创建: 'Workspace created',
  创建工作区: 'New workspace',
  创建新对话: 'New chat here',
  打开程序: 'Open NAI WA',
  '退出 NAI WA': 'Quit NAI WA',
  已重命名: 'Renamed',
  已移除: 'Removed',
  移除工作区: 'Remove workspace',
  重命名工作区: 'Rename workspace',
  在资源管理器中打开: 'Open in file manager',
  同步文件夹名: 'Sync folder name',
  文件夹名已同步: 'Folder name synced',
  '迁移已有会话？': 'Migrate existing chats?',
  新的存放位置: 'New location',
  '要现在把已有会话文件夹迁移过去吗？': 'Move the existing chat folders there now?',
  迁移: 'Migrate',
  只改设置: 'Settings only',
  清空用量记录: 'Clear usage records',
  同时删除磁盘目录: 'Also delete the folder',
  '只从列表里移除，磁盘文件保留。': 'Remove from the list only — files on disk stay.',
  个会话: 'chats',
  连目录一起删除: 'Delete folder too',
  '选择中…': 'Choosing…',
  新建工作区: 'New workspace',
  目录结构: 'Folder layout',
  '新建工作区时会自动准备这些子目录。': 'These subfolders are created automatically.',
  '工作区长期记忆，Agent 能读到': 'workspace long-term memory, readable by the agent',
  拖进来的图片与文件: 'images and files you drop in',
  '工具产出（大结果、代码、图表）': 'tool outputs (large results, code, charts)',
  导出的会话: 'exported chats',
  '导出的会话 Markdown / HTML': 'exported chats (Markdown / HTML)',
  'run_code 的临时脚本与产物': 'scratch scripts and outputs from run_code',

  /* ---------------- 设置正文 · 用量 */
  统计范围: 'Range',
  '近 30 天': 'Last 30 days',
  合计: 'Totals',
  '总 token': 'Total tokens',
  输入: 'Input',
  输出: 'Output',
  预估费用: 'Estimated cost',
  请求数: 'Requests',
  按模型: 'By model',
  '费用按「通用」里填的单价估算，不是真实账单。':
    'Cost uses the rates from General — an estimate, not a real invoice.',
  没有记录: 'No records',
  还没有用量: 'No usage yet',
  '开始对话以后这里会自动累计。': 'Usage is accumulated here once you start chatting.',
  最近记录: 'Recent records',
  '这个范围里没有记录。': 'No records in this range.',
  '（未命名会话）': '(untitled chat)',
  清理: 'Cleanup',
  '清空全部用量记录？此操作不可恢复。': 'Clear all usage records? This cannot be undone.',
  清空全部记录: 'Clear all records',

  /* ---------------- 设置正文 · 人格 */
  '（副本）': ' (copy)',
  名称与系统提示词都要填: 'Both a name and a system prompt are required',
  已保存: 'Saved',
  '内置人格不能删除，可以改成副本再调整':
    'Built-in personas cannot be deleted — make a copy and adjust that',
  已删除: 'Deleted',
  编辑人格: 'Edit persona',
  新建人格: 'New persona',
  '系统提示词会放在整个 prompt 的最前面，写清楚角色、语气、边界。':
    'The system prompt goes at the very top of the whole prompt — spell out role, tone and boundaries.',
  名称: 'Name',
  '例如：严谨的代码审查员': 'e.g. a meticulous code reviewer',
  图标: 'Icon',
  系统提示词: 'System prompt',
  支持: 'Supports',
  '这类变量，会在运行时替换。': 'style variables, substituted at runtime.',
  '保存中…': 'Saving…',
  人格列表: 'Personas',
  '新建会话时会带上默认人格，输入区里也能随时切换。':
    'New chats start with the default persona; you can also switch it from the composer.',
  还没有人格: 'No personas yet',
  建一个人格: 'Create a persona',
  '把常用的工作方式写成系统提示词，以后不用每次重复。':
    'Write down a working style once and reuse it every time.',
  内置: 'built-in',
  改副本: 'Edit copy',

  /* ---------------- 设置正文 · 记忆 */
  全局: 'Global',
  '所有会话都能读到。适合放长期偏好，比如「回答尽量短」。':
    'Readable by every chat. Good for long-term preferences such as "keep answers short".',
  '只在绑定该工作区的会话里生效。': 'Only applies to chats linked to this workspace.',
  '只属于当前会话，换会话就不带过去。': 'Belongs to the current chat only — not carried over.',
  写一条记忆: 'Add a memory',
  '一句一条，写清楚「是什么」，别写太长的段落，检索时命中率更高。':
    'One fact per line, stated plainly — short lines match more reliably on retrieval.',
  已记住: 'Remembered',
  已更新: 'Updated',
  '还没有工作区，先到「工作区」分区建一个。': 'No workspace yet — create one in Workspaces first.',
  '当前没有打开的会话。': 'No chat is open right now.',
  '例如：我习惯用简体中文回答，代码注释也用中文。':
    'e.g. I prefer answers in Simplified Chinese, with code comments in Chinese too.',
  记住: 'Remember',
  已有记忆: 'Saved memories',
  '每次对话会按相关度挑几条拼进系统提示词，不是全部塞进去。':
    'Each turn pulls in a few relevant entries rather than stuffing them all in.',
  '读取中…': 'Loading…',
  这一层还是空的: 'This layer is empty',
  还没有记忆: 'No memories yet',
  'Agent 在对话里学到的偏好，也可以让它自己写进来。':
    'Preferences picked up in conversation can also be written here by the agent.',
  '由 Agent 写入': 'written by the agent',

  /* ---------------- 设置正文 · 接入模型 */
  'OpenAI 兼容': 'OpenAI compatible',
  编辑接入项: 'Edit connection',
  新增接入项: 'New connection',
  '保存后 Key 会通过系统安全存储加密，界面上只显示「已保存」，不会再回填明文。':
    'The key is encrypted with the system secure store; only "Saved" is shown afterwards, never the plaintext.',
  协议: 'Protocol',
  显示名称: 'Display name',
  '例如：OpenAI 官方': 'e.g. OpenAI official',
  'OpenAI 兼容请填到': 'For OpenAI-compatible APIs enter up to',
  '为止；Anthropic 填域名即可，会自动拼':
    '; for Anthropic just the host — /v1/messages is appended.',
  '留空表示不修改已保存的 Key': 'Leave blank to keep the saved key',
  '拉取中…': 'Pulling…',
  拉取模型列表: 'Pull model list',
  拉到: 'Fetched',
  个模型: 'models',
  可用模型: 'Available models',
  '取消勾选的模型不会出现在输入区与顶栏的切换菜单里。':
    'Unchecked models are hidden from the composer and the top-bar switcher.',
  '取消勾选的模型不会出现在输入区与顶栏的切换菜单里；每个模型都可以单独发一句 ping 试试能不能通。':
    'Unchecked models are hidden from the composer and the top-bar switcher; each model can be pinged on its own to check it works.',
  '填好地址和 Key 就能直接「拉取模型列表」，不必先保存。':
    'With the URL and key filled in you can pull the model list right away — no need to save first.',
  '按名称过滤…': 'Filter by name…',
  视觉: 'vision',
  推理: 'reasoning',
  上下文: 'Context',
  支持图片: 'images',
  仅文本: 'text only',
  测试连通性: 'Test connection',
  连接正常: 'Connected',
  通过: 'passed',
  请先填写接口地址: 'Enter the endpoint URL first',
  给这个接入项起个名字: 'Give this connection a name',
  接入项: 'Model connections',
  '可以同时接入多个服务，输入区里按会话随时切换。':
    'You can connect several services and switch per chat from the composer.',
  还没有接入任何模型: 'No models connected yet',
  先加一个接入项: 'Add your first connection',
  '填 Base URL 与 API Key，拉取模型列表后勾选可用的模型。':
    'Fill in the base URL and API key, pull the model list, then tick the ones you want.',
  还没拉取模型: 'No models pulled yet',

  /* ---------------- 设置正文 · MCP */
  给这个: 'Give this',
  '给这个 Server 起个名字': 'Give this server a name',
  'stdio 传输需要填写启动命令': 'stdio transport needs a start command',
  'http 传输需要填写地址': 'http transport needs a URL',
  连接失败: 'Connection failed',
  '已连接，发现': 'Connected — found',
  个工具: 'tools',
  '编辑 MCP Server': 'Edit MCP server',
  '新增 MCP Server': 'New MCP server',
  '新增 Server': 'Add server',
  'stdio 会在本机起一个进程；http 直接连远端地址。':
    'stdio spawns a local process; http talks to a remote endpoint.',
  传输方式: 'Transport',
  'stdio（本地进程）': 'stdio (local process)',
  'http（远端地址）': 'http (remote endpoint)',
  启动命令: 'Start command',
  参数: 'Arguments',
  '按空格拆分；路径含空格时先加引号。': 'Split on spaces; quote paths that contain spaces.',
  环境变量: 'Environment',
  '一行一个 KEY=VALUE。': 'One KEY=VALUE per line.',
  地址: 'URL',
  还没有: 'No',
  '还没有 MCP Server': 'No MCP servers yet',
  接一个外部工具集: 'Connect an external tool set',
  '支持 stdio 本地进程与 http 远端地址，也可以直接粘贴 mcpServers JSON 导入。':
    'stdio local processes and http endpoints are both supported; you can also paste mcpServers JSON.',
  断开: 'Disconnect',
  连接: 'Connect',
  未连接: 'Not connected',
  '连上以后，它暴露的工具会和内置工具一起出现在对话里；每次调用前都会先问你。':
    'Once connected, its tools show up alongside the built-in ones; every call asks you first.',
  '连接中…': 'Connecting…',
  重启: 'restarts',
  次: 'times',
  粘贴: 'Paste',
  '粘贴 JSON 导入': 'Paste JSON to import',
  '从 JSON 导入': 'Import from JSON',
  '支持 mcpServers 或 servers 两种写法，同名的会被跳过。':
    'Both mcpServers and servers shapes work; duplicates are skipped.',
  导入: 'Import',
  个: 'imported',
  个失败: 'failed',

  /* ---------------- 设置正文 · 定时任务 */
  编辑任务: 'Edit task',
  新建任务: 'New task',
  '到点后会新建一个「定时任务 · 名称」会话并把提示词发出去，产出留在那个会话里。':
    'When it fires, a "Scheduled · <name>" chat is created, the prompt is sent there, and the output stays in that chat.',
  '例如：每天早上整理行业新闻': 'e.g. Summarise industry news every morning',
  类型: 'Type',
  重复: 'Recurring',
  一次性: 'One-off',
  执行时间: 'Run at',
  重复方式: 'Repeats',
  每天: 'Daily',
  每周: 'Weekly',
  每月: 'Monthly',
  'cron 表达式': 'cron expression',
  时间: 'Time',
  星期: 'Weekday',
  日: 'Sun',
  一: 'Mon',
  二: 'Tue',
  三: 'Wed',
  四: 'Thu',
  五: 'Fri',
  六: 'Sat',
  周: 'Days',
  每月几号: 'Day of month',
  号: '',
  提示词: 'Prompt',
  '整理今天与「多模态大模型」相关的三条进展，每条一句话总结并附来源。':
    'Summarise three recent developments in multimodal LLMs, one line each with a source.',
  名称和提示词都要填: 'Both a name and a prompt are required',
  跑完了: 'Run finished',
  任务列表: 'Scheduled tasks',
  '应用需要保持运行才会到点触发；关掉以后错过的任务下次启动会问你要不要补跑。':
    'The app must be running for tasks to fire; after a restart it asks whether to catch up on missed runs.',
  还没有定时任务: 'No scheduled tasks yet',
  建一个任务: 'Create a task',
  '比如每天九点整理一次行业新闻，或者每周一汇总上周的代码改动。':
    'For example a daily 9am industry digest, or a Monday summary of last week’s code changes.',
  有错过: 'missed',
  '执行中…': 'Running…',
  立即执行: 'Run now',
  停用: 'Disable',
  下次: 'Next',
  上次: 'Last',
  历史: 'History',
  '应用关闭期间错过了这次执行。': 'This run was missed while the app was closed.',
  现在补跑: 'Run it now',
  跳过: 'Skip',
  '（无摘要）': '(no summary)',
  成功: 'Success',
  失败: 'Failed',

  /* ---------------- 设置正文 · 图片生成 */
  直接出图: 'Generate',
  '生成结果会落到工作区的 artifacts/images 或应用数据目录，并记录在下方的历史里。':
    'Results are written to the workspace artifacts/images folder (or app data) and listed in history below.',
  '深夜的机房里，一排服务器指示灯像星图一样闪烁，冷青色，电影感打光':
    'A server room at night, rack lights blinking like a star map, cold cyan, cinematic lighting',
  负向提示词: 'Negative prompt',
  '模糊, 变形, 多余的手指': 'blurry, deformed, extra fingers',
  尺寸: 'Size',
  风格: 'Style',
  张数: 'Count',
  后端: 'Backend',
  '（还没有接入项）': '(no connections yet)',
  '（停用）': ' (disabled)',
  '生成中…': 'Generating…',
  生成图片: 'Generate images',
  '当前会话没绑工作区，图片会落到应用数据目录。':
    'This chat has no workspace, so images go to the app data folder.',
  图片后端: 'Image backends',
  '本地 SD WebUI / ComfyUI 不需要 Key，只要服务在跑。':
    'Local SD WebUI / ComfyUI need no key — just a running service.',
  还没有图片后端: 'No image backend yet',
  加一个后端: 'Add a backend',
  '本地已经有 ComfyUI 的话，填上地址就能直接用。':
    'If ComfyUI is already running locally, just fill in its URL.',
  新增后端: 'Add backend',
  生成历史: 'History',
  '只保留最近的记录，文件本身在磁盘上。': 'Only recent records are kept; the files stay on disk.',
  还没有生成过图片: 'Nothing generated yet',
  空的: 'Empty',
  点击在系统里打开: 'Click to open in the system viewer',
  打开存放位置: 'Show in folder',
  在右侧阅读: 'Read in side panel',
  点击在右侧阅读: 'Click to read in the side panel',
  本会话产物: 'This chat’s outputs',
  这个会话还没有产物: 'No outputs in this chat yet',
  '让 Agent 生成点东西，产物会落在这个会话的文件夹里。':
    'Ask the agent to make something — outputs land in this chat’s own folder.',
  打开会话文件夹: 'Open chat folder',
  先写点提示词: 'Write a prompt first',
  先加一个图片接入项: 'Add an image connection first',
  '这个地址只有文本接口，出图会返回 404。要生图请换成 OpenAI 官方、Stability，或本地 SD WebUI / ComfyUI。':
    'This endpoint is text-only, so image generation returns 404. Point it at OpenAI, Stability, or a local SD WebUI / ComfyUI instead.',
  生成失败: 'Generation failed',
  出图: 'Generated',
  张: 'images',
  不加风格: 'No style',
  摄影: 'Photo',
  电影感: 'Cinematic',
  动漫: 'Anime',
  水彩: 'Watercolour',
  '3D 渲染': '3D render',
  扁平插画: 'Flat illustration',

  /* ---------------- 通用按钮 */
  界面出了点问题: 'Something went wrong',
  重新加载窗口: 'Reload window',
  重试一次: 'Try again',
  新增一条: 'Add one',
  保存修改: 'Save changes',
  移除: 'Remove',
  确认: 'Confirm',
  关闭: 'Close',
  全部: 'All',
  清空: 'Clear',
  未配置: 'Not configured',
  启用: 'Enabled',
  已停用: 'Disabled',
  '缺': 'missing',
  '缺Key': 'Missing key',
  '缺 Key': 'Missing key',
  模型: 'Models',
  拉取模型: 'Pull models',
  已选: 'selected',
  全选: 'Select all',
  清空选择: 'Clear',

  /* ---------------- 快捷键分区 */
  输入框: 'Composer',
  列表与菜单: 'Lists & menus',
  说明: 'Notes',
  新建会话: 'New chat',
  '折叠 / 展开侧栏': 'Collapse / expand sidebar',
  '发送（编辑态下则是保存）': 'Send (saves while editing a message)',
  '自动加入附件': 'Attached automatically',
  换行: 'Newline',
  '在菜单与命令面板里移动': 'Move through menus and the palette',
  执行当前项: 'Run the highlighted item',
  右键会话: 'Right-click a chat',
  粘贴图片或文件: 'Paste an image or file',
  '重命名 / 置顶 / 导出 / 删除': 'Rename / pin / export / delete',
  '依次关闭：设置 → 面板 → 抽屉 → 停止生成':
    'Close in order: settings → side panel → drawer → stop generating',
  'macOS 上把 Ctrl 换成 ⌘。所有快捷键在输入框获得焦点时仍然生效，除了纯字母组合。':
    'On macOS use ⌘ instead of Ctrl. Every shortcut still works while the composer has focus, except plain-letter combinations.',
  '快捷键在应用任意位置生效，弹窗打开时优先响应弹窗。':
    'Shortcuts work anywhere in the app; open dialogs take precedence.',

  /* ---------------- 启动与降级提示 */
  启动失败: 'Failed to start',
  重新加载: 'Reload',
  '正在浏览器中预览，桌面能力（文件 / 命令 / 模型）不可用':
    'Previewing in a browser — desktop features (files, commands, models) are unavailable',

  /* ---------------- 窗口与标题栏 */
  最小化: 'Minimize',
  最大化: 'Maximize',
  向下还原: 'Restore',
  调整面板宽度: 'Resize panel',
  窗口内全屏: 'Fill window',
  退出窗口内全屏: 'Exit fill window',
  会话已迁移到该工作区: 'Chat moved into this workspace',

  /* ---------------- 权限徽标与完全访问风险告知 */
  审批: 'Ask first',
  完全访问: 'Full access',
  '审批模式：写入/命令/外部工具执行前都会先问你':
    'Ask first — file writes, commands and external tools all ask before running',
  '完全访问：工具无需审批直接执行，点击切回审批模式':
    'Full access — tools run without asking. Click to switch back',
  已切回审批模式: 'Back to ask-first mode',
  已开启完全访问: 'Full access enabled',
  '开启完全访问？': 'Enable full access?',
  '我已了解，开启完全访问': 'I understand, enable it',
  '开启后，NAI WA 可以不经确认直接执行下面这些动作：':
    'Once enabled, NAI WA can do all of the following without asking:',
  '在你选定的工作区内外执行任意终端命令': 'Run any terminal command inside or outside your workspace',
  '读写、覆盖、删除磁盘上的任意文件': 'Read, write, overwrite or delete any file on disk',
  '调用外部 MCP 工具并把结果带回来': 'Call external MCP tools and bring the results back',
  '所有动作仍会记进「权限与审计」日志，但不再逐条询问。可以随时点输入框里的徽标切回审批模式。':
    'Every action is still written to the audit log, but nothing asks first. Click the badge in the composer to switch back at any time.',
  继续: 'Continue',
  '继续。上一次回复停在下面这段，从断点往后接着写，不要重复已经写过的内容：':
    'Continue. The previous reply broke off at the passage below — pick up from the break without repeating what you already wrote:',
  '继续。': 'Continue.',

  /* ---------------- 会话生命周期与存放位置 */
  在资源管理器中查看: 'Show in file manager',
  移动到工作区: 'Move to workspace',
  已移动到工作区: 'Moved into workspace',
  已移出工作区: 'Moved out of workspace',
  会话存放位置: 'Chat storage',
  '没有关联工作区的会话都放在这里，每个会话一个独立文件夹，文件夹名是会话创建时间。':
    'Chats without a workspace live here — one folder per chat, named after its creation time.',
  当前目录: 'Current folder',
  '建议放在非系统盘，避免系统重装时一起丢掉。':
    'Prefer a non-system drive so a reinstall does not take the chats with it.',
  未设置: 'Not set',
  更改默认存放位置: 'Change location',
  存放位置已更新: 'Storage location updated',
  关闭窗口时: 'When closing the window',
  '选「最小化到托盘」时窗口只是隐藏，托盘图标里可以再打开。':
    'With “minimize to tray” the window is only hidden — reopen it from the tray icon.',
  最小化到托盘: 'Minimize to tray',
  直接退出: 'Quit',
  '没有找到可用的非系统盘，已回退到用户目录。':
    'No usable non-system drive found — fell back to your home folder.',
  '没有找到可写目录，已回退到应用数据目录。':
    'No writable location found — fell back to the app data folder.',

  /* ---------------- 更新检查 */
  更新: 'Updates',
  '手动检查一次新版本；没连上更新源也不会影响使用。':
    'Check for a new version by hand; an unreachable update source never blocks the app.',
  版本检查: 'Version check',
  检查更新: 'Check for updates',
  '检查中…': 'Checking…',
  还没有配置更新源: 'No update source configured yet',
  检查失败: 'Check failed',
  有新版本: 'New version available',
  已经是最新版本: 'Already up to date',
  '已经是最新版本。': 'Already on the latest version.',
  软件更新: 'Software update',
  '检查 GitHub 上的最新版本': 'Check the latest version on GitHub',
  当前版本: 'Current version',
  上次检查: 'Last checked',
  还没有检查过: 'Not checked yet',
  '点右边的按钮检查一次。': 'Use the button on the right to check once.',
  打开下载页: 'Open download page',
  自动检查: 'Check automatically',
  '每次启动时查一次，有新版就在侧栏显示胶囊。':
    'Runs once per launch; a new build shows up as a pill in the sidebar.',
  打开软件后自动检查新版本: 'Check for new versions when the app starts',
  更新源: 'Update source',
  在浏览器里打开仓库: 'Open the repository in a browser',
  '默认检查 GitHub 上 RuiHn7/NAIWA-AI 的最新版本。':
    'Checks the latest version of RuiHn7/NAIWA-AI on GitHub by default.',
  新版本: 'New version',
  '点开进入软件更新页，应用内下载并安装': 'Opens the software update page — download and install in-app',
  忽略: 'Dismiss',
  发现新版本: 'New version found',
  下载并安装: 'Download and install',
  下载中: 'Downloading',
  停止下载: 'Stop download',
  继续下载: 'Resume download',
  重新下载: 'Download again',
  '正在测速，自动选择最快线路…': 'Testing routes, picking the fastest one…',
  '已停止：已下载的进度会保留，点「继续下载」接着下，或「重新下载」从头来。':
    'Stopped: downloaded parts are kept. Resume, or download again from scratch.',
  重启并安装: 'Restart and install',
  '正在启动安装程序…': 'Launching installer…',
  '校验安装包…': 'Verifying package…',
  已下载: 'Downloaded',
  下载失败: 'Download failed',
  启动安装程序失败: 'Failed to launch the installer',
  '安装包已下载，可以重启安装了': 'Installer downloaded — ready to restart and install',
  '安装包已就绪：点「重启并安装」会自动关闭本程序并启动安装器':
    'Installer is ready: "Restart and install" closes this app and launches the installer.',
  '这次发布没有挂安装包，只能到下载页手动下。':
    'This release has no installer attached — download it from the release page.',

  '检查更新失败': 'Update check failed',
  本次会话的产物: 'Outputs from this chat',

  /* ---------------- 内置出图 */
  内置渲染: 'Built-in renderer',
  '内置渲染（本地）': 'Built-in renderer (local)',
  '内置渲染（本地，不需要 Key）': 'Built-in renderer (local, no key needed)',
  '内置渲染是本地程序化绘制，不需要 Key，适合风景和氛围底图。它画不出具体的人、动物、产品和文字，要那些请接入真实出图后端。':
    'The built-in renderer draws locally and needs no key. It is good for scenery and mood backgrounds, but cannot draw specific people, animals, products or text — connect a real image backend for those.',
  '内置渲染是本地程序化绘制，不需要 Key，按提示词里的场景、光线和主体生成画面，适合风景和氛围底图。它画不出具体的人、动物、产品和文字，要那些请接入真实出图后端。':
    'The built-in renderer draws locally and needs no key. It builds the scene from the setting, lighting and subject in your prompt — good for scenery and mood backgrounds. It cannot draw specific people, animals, products or text; connect a real image backend for those.',
  '默认用内置渲染在本地画，产物落在当前会话的 artifacts/images 里。':
    'Draws locally with the built-in renderer by default; outputs land in this chat’s artifacts/images.',

  /* ---------------- 识图 */
  识图: 'Vision',
  自动挑选: 'Auto pick',
  已手动指定: 'Manually set',
  '该接入项里第一个支持图片的模型': 'First image-capable model in this provider',
  出图后自动核对: 'Verify images automatically',

  /* ---------------- 本机识图（默认能力，无需配置） */
  '本机识图': 'Local vision',
  '本机识图已就绪': 'On-device vision is ready',
  '本机识图（默认，无需配置）': 'On-device vision (default, no setup)',
  '识图（可选精度增强）': 'Vision (optional accuracy boost)',
  '默认用软件内置的本机识图': 'Uses built-in on-device vision by default',
  '已回到本机识图（默认）': 'Back to on-device vision (default)',
  '已启用多模态精度增强': 'Multimodal boost enabled',
  '点一下可以换一个多模态模型（可选）': 'Click to pick another multimodal model (optional)',
  '软件内置离线识别模型（1000 类物体）、像素分析、离线 OCR 与生成历史反查，不需要任何配置':
    'Built-in offline classifier (1000 object classes), pixel analysis, offline OCR and image-history lookup — no setup needed',
  '点这里可选接入一个多模态模型，进一步提升精度':
    'Click to optionally add a multimodal model for even higher accuracy',
  '软件内置本机识图已就绪：解码、像素分析、Windows 离线 OCR、生成历史反查，不需要任何配置。下面列出的多模态模型只是可选的精度增强 —— 指定后会在识图结果上再叠加一段画面描述。':
    'Built-in on-device vision is ready: decoding, pixel analysis, Windows offline OCR and image-history lookup — no setup needed. The multimodal models below are only an optional accuracy boost; picking one adds an extra description on top of the on-device result.',
  '软件内置识图，无需配置：内置离线识别模型（MobileNetV2，1000 类，本机推理）直接判断「这是什么物体」并给出置信度，像素分析判断图像类型，Windows 自带 OCR 离线读出图中文字，本软件生成的图还会回查生成历史拿到提示词与主体。这些事实交给当前主模型理解并回答，所以纯文本主模型也能识图。下面只在需要更高精度时才用得上。':
    'Vision is built in and needs no setup: an offline classifier (MobileNetV2, 1000 classes, running on this machine) says what the object is and how confident it is, pixel analysis classifies the image, Windows offline OCR reads the text, and images generated here are matched against their prompt in image history. Those facts go to the current chat model, so even a text-only model can understand images. The controls below only matter for extra accuracy.',
  '没有指定多模态模型时，识图完全由软件在本机完成；如果以后想提升照片识别精度，可以接入一个多模态模型再在这里选。':
    'With no multimodal model selected, vision runs entirely on this machine. Add one later and pick it here if you want better photo recognition.',
  '打开后，每次出图都会再用本机识图核对一遍画面（叠加你选的多模态模型描述），主模型就能据此确认画出来的是什么，而不是回「我无法确认」。':
    'When on, every generated image is checked with on-device vision (plus your optional multimodal model), so the chat model can confirm what was drawn instead of replying "I can\'t verify".',
  '没有手动指定时，会自动用第一个标了「支持图片」的模型作为增强；不指定也完全不影响本机识图。':
    'Without a manual choice, the first model tagged "vision" is used as a boost; leaving it unset does not affect on-device vision at all.',

  /* ---------------- 内置本地视觉模型（离线识图） */
  '本地视觉模型': 'Local vision model',
  '本地视觉模型已就绪': 'Local vision model is ready',
  '识图已就绪': 'Vision is ready',
  '点一下可以换回内置识图或换一个多模态模型': 'Click to switch back to built-in vision or pick another multimodal model',
  '本地视觉模型（本机）': 'Local vision model (on-device)',
  '用本地视觉模型识图': 'Use the local vision model for images',
  '本地视觉模型下载完成': 'Local vision model downloaded',
  '已停止下载，已下载的部分保留，可继续': 'Download stopped; partial file kept for resuming',
  '已删除本地视觉模型': 'Local vision model deleted',
  '没有可删除的模型': 'Nothing to delete',
  '模型已加载': 'Model loaded',
  '加载失败': 'Failed to load',
  '加载中…': 'Loading…',
  '校验模型完整性…': 'Verifying model integrity…',
  '下载模型（约 2.7GB，可断点续传）': 'Download model (≈2.7 GB, resumable)',
  '预热（先把模型读进显存）': 'Warm up (preload into VRAM)',
  '删除模型': 'Delete model',
  '运行时': 'Runtime',
  '已随安装包就位': 'bundled with the app',
  '缺失，需重新安装最新版本': 'missing — reinstall the latest version',
  '存放目录': 'Model folder',
  未下载: 'Not downloaded',
  未就绪: 'Not ready',
  '已就绪（未加载）': 'Ready (not loaded)',
  校验中: 'Verifying',
  加载中: 'Starting',
  '已加载，可识图': 'Loaded — ready for images',
  异常: 'Error',
  '安装包只带推理运行时（约 70MB），模型下载后长期留在本机，识图在本机完成，不依赖外部接口：描述画面内容、读图中文字、回答「这是什么」。不下载也照样能用原来的本机识图。':
    'The installer only carries the runtime (≈70 MB). The model is downloaded once and stays on this machine, with vision running on-device and no external API needed: describing scenes, reading text in images, answering "what is this". Without it, the built-in classifier and OCR still work.',
  '本地视觉模型之外再加一层': 'One more optional layer on top of the local model',
  '识图优先用上面的本地视觉模型（装好模型后在本机推理，能描述画面、读文字）。这里的云端多模态模型是可选的第二层：指定后会优先调用它，失败再自动回落到本地视觉模型与本机分类 + OCR，所以不会因为云端不可用就没法识图。':
    'Vision uses the local model above first (runs on this machine once downloaded, describing scenes and reading text). This cloud multimodal model is an optional second layer: when set it is tried first, and any failure falls back to the local model plus classifier and OCR, so a cloud outage never disables vision.',
  'Qwen2.5-VL-3B 在本机推理，能描述画面、读图中文字': 'Qwen2.5-VL-3B runs on this machine and can describe scenes and read text',
  '点这里可以换成云端多模态模型，进一步提升精度': 'Click to switch to a cloud multimodal model for extra accuracy',
  '内置识图已就绪': 'Built-in vision is ready',
  '离线分类（1000 类）、像素分析、离线 OCR 与生成历史反查，不需要任何配置':
    'Offline classifier (1000 classes), pixel analysis, offline OCR and image-history lookup — no setup needed',
  '想要能描述任意画面的效果，去设置里下载本地视觉模型（一次性，之后离线）':
    'For descriptions of any image, download the local vision model in Settings (one time, then offline)',
  '内置识图（本地视觉模型 + 分类 + OCR，无需配置）': 'Built-in vision (local model + classifier + OCR, no setup)',
  '内置识图默认可用：下载了本地视觉模型就能描述任意画面、读图中文字；没下载时用离线分类 + 像素分析 + OCR 兜底。下面列出的云端多模态模型是可选的精度增强。':
    'Built-in vision works out of the box: with the local model downloaded it can describe any scene and read text; without it, the offline classifier, pixel analysis and OCR take over. The cloud models below are an optional boost.',

  /* ---------------- 时间与时长（src/lib/format.ts） */
  刚刚: 'just now',
  '{n} 分钟前': '{n}m ago',
  '{n} 小时前': '{n}h ago',
  '{n} 天前': '{n}d ago',
  已到时间: 'due now',
  '{n} 秒后': 'in {n}s',
  '{n} 分钟后': 'in {n}m',
  '{n} 小时后': 'in {n}h',
  '明天 {t}': 'tomorrow {t}',
  '{n} 天后 {t}': 'in {n}d {t}',
  '{n} 分 {m} 秒': '{n}m {m}s',
  '（无参数）': '(no arguments)',
};

/* ------------------------------------------------------------ 核心函数 */

export function translate(source: string, locale: Locale | string | undefined): string {
  if (locale !== 'en-US') return source;
  return EN[source] ?? source;
}

/** 组件里用：const t = useT(); t('新对话') → 'New chat' */
export function useT(): (source: string) => string {
  const locale = useApp(s => s.settings?.locale);
  return (source: string) => translate(source, locale);
}

/** 不需要 hook 的地方（ErrorBoundary 之类的 class 组件） */
export function currentLocale(): Locale {
  try {
    return (useApp.getState().settings?.locale ?? 'zh-CN') as Locale;
  } catch {
    return 'zh-CN';
  }
}

export function t(source: string): string {
  return translate(source, currentLocale());
}

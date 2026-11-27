# NAI WA · 桌面端 AI Agent

从网页版 `D:\AIGC\NAI WA` 重构出的跨平台桌面应用。本地优先：会话、工作区、记忆、图片全部存在本机，模型接口自己填，不经过任何中间服务器。

技术栈：Electron 45 + React 19 + TypeScript + Vite 6 + zustand 5 + marked/highlight.js/DOMPurify + @tanstack/react-virtual。

---

## 快速开始

```bash
npm install
npm run dev          # 开发模式（vite dev server + electron）
npm start            # 生产构建后直接启动
npm run dist:win     # 打包 Windows 安装包（NSIS）
npm run fetch:llama  # 取本地视觉模型运行时到 assets/llama（打包前跑一次）
npm run dist:mac     # 打包 macOS dmg
npm run dist:linux   # 打包 Linux AppImage + deb
```

产物：`dist/`（渲染层）、`dist-electron/`（主进程 + preload）、`release/`（安装包）。

> **任务管理器里显示 NAI WA**：`scripts/dev.mjs` 启动前会调 `scripts/app-exe.mjs`，把 `node_modules/electron/dist/electron.exe` 复制成同目录的 `NAI WA.exe`，并用 rcedit 改写 `FileDescription / ProductName / InternalName` 与应用图标。开发版因此也以「NAI WA」出现在任务管理器、任务栏与通知里（直接双击 `electron.exe` 看到的仍是 Electron）。
> 想手动重建：`npm run app-exe`（`node scripts/app-exe.mjs --force` 强制覆盖）。

> Windows 上如果 `electron.exe` 报 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`，是环境变量 `ELECTRON_RUN_AS_NODE=1` 在作怪：
> `Remove-Item Env:ELECTRON_RUN_AS_NODE` 之后再启动。

---

## 第一次使用

1. 打开「设置 → 接入模型」，新增一个接入项。
2. 三选一协议：**OpenAI 兼容** / **Anthropic** / **Gemini**，填 Base URL 与 API Key，点「拉取模型」。
3. 勾选要用的模型保存。回到主界面，右下角模型 pill 就能切了。
4. 想让它动文件/跑命令，先在「设置 → 工作区」关联一个目录。

API Key 用 Electron `safeStorage` 加密后写进 `secrets.json`（系统不支持时退回 base64 明文，前缀区分）。

---

## 功能地图

### 身份：软件工程智能体
system prompt 的第一段永远是「身份与工作规则」（`desktop/agent/prompt.ts` 的 `ENGINEER_RULES`），按八节约束模型行为：

1. **任务规划** —— 先列计划再动手，最小改动，风险动作先说明，拆小步。
2. **读代码** —— 先 `ls` 再 `read_file`，用 `grep` 定位，区分代码问题 / 依赖缺失 / 环境配置。
3. **改代码** —— 优先 `edit_patch` 而不是整份覆盖，保持原有风格，不偷删功能，改完想测试与文档。
4. **Shell** —— 只用于装依赖 / lint / 编译 / 测试 / 看版本；退出码 0 继续，非 0 把 stderr 当观察输入改补丁。
5. **思考与输出** —— 内部思考写清「进度 / 发现了什么 / 下一步」，工具调用严格按 schema，禁止编造文件与命令，环境信息必须靠工具获取。
6. **校验与反思** —— 改完必须跑测试或 lint（强制闭环），失败先反思再改，连续失败停下来汇总，不假装测试通过。
7. **审批** —— 破坏性动作走审批层，被拒不得换个写法绕开。
8. **结束** —— 需求实现 + lint 无错 + 测试全过 + 无遗留高危，才允许调用 `finish`；`finish` 必须带变更清单、执行过的命令、验证结果。

剩下的段落依次是：人格 → 全局记忆 → 工作区记忆 → 会话摘要 → 可用工具 → 运行环境。运行环境里会按模型能力写明「当前模型支持 / 不支持图片输入」。

### 对话
- 流式输出、可折叠的思考过程（reasoning）、Markdown + 代码高亮 + 一键复制、表格/引用/任务列表。
- 手动停止保留已出字；失败可重试；最后一条可重新生成；消息可编辑、删除、复制。
- 会话自动命名、置顶、搜索、右键菜单（重命名 / 置顶 / 导出 / 删除）。
- **自动压缩上下文**：用量超过阈值（默认 75%，可在 `设置 → 通用 → 上下文压缩` 调整，也能整个关掉）时自动把更早的消息折成摘要，保留最近 10 条。**手动「压缩上下文」永远可用** —— 自动结果不理想时可以自己再折一次。
- 导出 Markdown / JSON / 单文件 HTML。

### Agent 工具（13 个内置）
软件工程智能体主链路：`ls` → `grep` → `read_file` → `write_file` / `edit_patch` → `shell` → `git_diff` → `finish`。

| 工具 | 说明 | 需要审批 |
| --- | --- | --- |
| `ls` | 列目录（`recursive` 时按相对路径递归列出） | — |
| `grep` | 正则搜工作区，输出 `路径:行号: 内容`，跳过二进制与 `node_modules/.git/dist/release` | — |
| `read_file` | 读工作区文本文件（`max_bytes` 默认 20000） | — |
| `edit_patch` | **增量改文件**：`old_string` 必须唯一命中；找不到或命中多处会返回可读报错（缩进/CRLF/已被改过）而不是硬失败 | ✓ |
| `write_file` / `delete_file` | 写 / 删文件 | ✓ |
| `shell` | 执行终端命令（`cmd.exe /d /s /c`，超时强杀、输出截断） | ✓ |
| `git_diff` | 在工作区跑 `git diff`（支持 `staged` / `stat_only`），只读 | — |
| `finish` | 声明任务完成，参数写变更清单 / 执行过的命令 / 验证结果，并终止主循环 | — |
| `web_search` | 内置实时网页检索（Bing，开箱即用；也可在设置里换成自建搜索接口） | — |
| `read_web_page` | 抓网页转纯文本 | — |
| `run_code` | Python / Node 脚本沙箱执行（超时强杀、输出截断） | — |
| `generate_image` | 出图：优先用你配的外部后端，**没有可用后端时自动改用内置渲染**（本地程序化绘制，一定能出图） | — |

`list_files` / `run_command` 作为旧名保留（不进 schema，只兼容历史会话）。
主循环上限 24 轮；同一工具 + 同一参数重复 3 次会被判定为打转并中止，把结论告诉用户。工具返回超过 4000 字自动落盘到 `artifacts/`，上下文里只留前 1200 字 + 文件路径。

**产物在对话里直接可见**：工具返回的产物文件（`generate_image` 出的图、`run_code` / `write_file` 写出的文件）挂在工具卡的 `files` 上，图片当场渲染成缩略图，其它类型列成文件条目，卡片头部还有产物数量角标。每个产物都带两个动作：**「打开存放位置」**（在资源管理器里定位到该文件，图片是缩略图右下角的小按钮，其它类型是条目右侧的小图标）与 **文本类的「在右侧阅读」**（点文件名或「在右侧阅读」，文件直接在右侧栏里渲染出来，不用切窗口）。卡片展开后底部还有一整行 `打开存放位置 / 在右侧阅读`，产物多的时候不用一个个去找小图标。

**产物落在会话自己的文件夹里**：`generate_image`、`run_code`、`spill` 的落盘目录按 `会话文件夹/artifacts` → `<工作区>/artifacts` → 应用数据目录 依次回退；会话有文件夹时产物就跟着会话走（`<会话目录>/artifacts/images/gen-<时间戳>-0.png`），不再堆在 C 盘的 `%APPDATA%\naiwa-desktop\images` 下。`ls` / `read_file` / `grep` 的相对路径仍然优先按工作区解析，没有工作区时落到 `<会话目录>/files/`。

**会话末尾有产物汇总**：一轮答完（流式结束）后，消息流末尾会出现「本次会话的产物」面板，把该会话文件夹里 `artifacts / files / exports / attachments` 下的所有产物铺开 —— 图片直接是缩略图，其它文件是可点条目（点一下在右栏读，右侧小图标是打开存放位置）。面板可收起，产物只在流式进行中隐藏，不用往上翻去找。

### 识图：内置本地视觉模型（本机运行）
识图不依赖主模型是不是多模态，三层接力，任何一层失败都往下退：
1. **本地视觉模型**：`llama.cpp`（Vulkan 版，随安装包分发约 70MB）+ **Qwen2.5-VL-3B**（首次使用时下载到 `<会话根目录>/models/vlm`，约 2.7GB，SHA-256 校验，装好后在本机推理）。能描述画面、读图中文字、回答「这是什么」，8G 显存约 1–5 秒一张。
2. **可选云端多模态**：设置里显式指定的接入项优先；失败自动回落，不会因为云端不可用就没法识图。
3. **本机兜底**：MobileNetV2（1000 类）+ 像素分析 + Windows OCR + 生成历史反查 —— 模型没下载时照样有识图结果，不会出现「我看不了图」。

模型不进 asar/安装包：`scripts/fetch-llama.mjs` 负责取运行时（打包时由 `extraResources` 复制到 `resources/llama`），模型由应用内下载器按需下载、断点续传、可删除。开发态把运行时放 `assets/llama`，模型目录可用设置里的 `vlmDir` 覆盖。

### 出图：内置渲染兜底
`设置 → 图片生成` 的后端列表第一项固定是 **「内置渲染（本地，不需要 Key）」**：
- 纯 Node 程序化绘制（`desktop/agent/paint.ts`，自写 PNG 编码器，无第三方依赖、不联网、不要 Key），按提示词里的场景、光线和主体取色构图。
- **任何外部后端失败都会自动降级到它** —— 没配后端、后端指向只有文本接口的厂商（DeepSeek 等）、HTTP 401/404/429、ComfyUI 超时、接口没返回图片数据，全都会改成「本地画一张」，返回里带一句 `说明：…` 告诉你是怎么降级的。所以 `generate_image` 不再有「无法生成图片」这种结果。

### 三层记忆
- **全局**：跨工作区共享的用户偏好。
- **工作区**：绑定到某个目录，同时同步一份 `memory/MEMORY.md` 供人读。
- **会话**：只在当前会话生效。

每次请求按字面命中（5 分）、标签（3 分）、字符重叠（×0.35，上限 6）、同工作区（+1.5）、时间衰减（`max(0, 1.2 - days/60)`）打分，阈值 1.2 以上取前 6 条拼进 system prompt。

### MCP
设置页可直接配 stdio（command + args + env）或 HTTP 服务器，也可以粘贴 `mcpServers` JSON 批量导入。工具列表可逐个开关，调用外部工具前会走一次审批。服务器崩溃自动重启，最多 3 次退避重连。

### 定时任务
支持一次性 / 每天 / 每周 / 每月 / 5 段 cron。任务跑在自己的会话里（`定时任务 · <名字>`），结果写进历史。错过的任务会在下次启动时提示「现在补跑 / 跳过」。

### 右侧栏
- **文件**：绑定工作区时列工作区文件；**没绑工作区时列「本会话产物」**（扫会话文件夹下的 `artifacts / files / exports / attachments`），所以纯聊天会话也看得到自己产出的图片和文件。点条目在栏内预览，图片直接显示，文本 / 代码 / JSON 按纯文本渲染；标题右侧两个按钮分别是「刷新」与「打开会话文件夹 / 在工作区里打开」。
- **浏览**：内置 webview，只允许打开白名单里的地址（`设置 → 通用 → 内置浏览`，支持 `*` 通配）。不在名单里的地址会给出提示卡片，而不是白屏。

### 窗口与界面框架
- 无边框窗口，标题栏由应用自绘：顶栏右侧是「最小化 / 最大化·还原 / 关闭」，关闭行为在 `设置 → 通用 → 关闭窗口时` 选「最小化到托盘 / 直接退出」（默认托盘）。
- 拖动顶栏空白处移动窗口，双击空白处最大化 / 还原；侧栏左缘、右栏左缘各有拖宽手柄，宽度都会记住。
- 右栏「窗口内全屏」只占满应用窗口（不是系统全屏），再点恢复；动画走 transform / width，不触发重排。
- 侧栏底部「用户卡靠左、设置齿轮靠右」同一行，侧栏收窄时降级为纯图标；有新版本时用户卡上方会多一条蓝色胶囊。

### 会话与磁盘
- 首次启动在**非系统盘**自动建 `NAI WA` 根目录（如 `D:\NAI WA`，无可用盘则回退用户目录并在设置里提示），可在 `设置 → 通用 → 会话存放位置` 更改并选择是否迁移已有会话（磁盘搬 + 索引更新，失败回滚）。
- 点「新对话」不建文件夹；**发出第一条消息后才建**，文件夹名是创建时间 `2026-11-26_05-53-09`，同秒冲突追加 `-2`。空白会话同一时刻只有一个，重启后不保留；从**工作区右键 → 创建新对话**进来的会话例外，它一建好就落在 `<工作区>/chats/<时间戳>/`。
- 空白会话复用前会先向主进程核实这条会话还在磁盘上，所以「删光所有会话后再点新对话」也能正常建出来（不会卡在旧的内存状态上）。
- 首条消息后会话自动命名（本地提取关键词，不联网，失败保持「新对话」）；**只改会话标题，不动磁盘文件夹名**。
- 会话右键：重命名（只改标题）、同步文件夹名、在资源管理器中查看、置顶、移动到工作区、导出、删除（可选连目录一起删）。
- 工作区节点右键：创建新对话（会话直接落在 `<工作区>/chats/`）、在资源管理器中打开、重命名工作区、移除工作区、连目录一起删除。
- 侧栏操作区四项：新对话 / 工作区 / **创建工作区** / 权限。创建工作区直接在侧栏选一个目录就建好，不用先进设置页。
- 侧栏按最后活跃时间分组：今天 / 昨天 / 本周 / 更早；有工作区时按工作区分组，节点可展开收起，会话可**拖拽**迁到某个工作区（磁盘文件夹一并搬，失败回滚并提示）。

### 输入区
- 顺序固定为 ＋ / 权限 / …空隙… / 余额 / 模型 / 麦克风 / 发送（模型与麦克风靠右相邻）。
- 模型与思考强度合并成一个控件：同一面板先挑模型再挑 Low/High/Max，收起即生效，按钮上紧凑显示「模型名 + 档位」，hover 看完整信息。
- **鼠标悬停在模型上**（还没点下去）时，右侧会展开「上下文长度」二级菜单，标题带当前模型名（如 `上下文长度 · deepseek-flash`），换一行就重新播一次入场动画：`自动`（跟随模型最大窗口） / `300K` / `600K` / `1M`，只影响当前会话，压缩阈值与进度圆环的分母一起变。
- 权限徽标在输入框内：`审批` 或 `完全访问`。切到完全访问会先弹风险告知窗二次确认，确认后徽标转红，再点一次即可切回审批。
- 草稿按会话保留，切走再回来还在；停止生成后消息尾部有「继续」，点一下接着写。
- 输入框贴着窗口底边；下方一条统计行显示 **轮 · 步 · tok/s · 总 tok · 缓存命中率 · 上下文进度圆环 + 百分比**，右侧是「压缩上下文」。
- **「回到最新」胶囊**在输入框正上方、右边缘与输入框右边缘对齐，只在往上滚过之后出现，点一下平滑滚回底部。
- 模型按钮左侧显示该账号的余额（如 `¥0.52`），探测不到余额接口的厂商就不显示，不占位。

### 接入模型
- 「拉取模型列表」不要求先保存：填好 Base URL 与 API Key 就能立刻拉（新接入项、草稿状态都行）。
- 每个模型的卡片上直接标出 **上下文窗口**（如 `128K`）与 **支持图片 / 仅文本**，还有 `推理` 标记；右侧「测试」按钮发一句 ping 看能不能通，成功显示耗时，失败显示错误原因，可逐个排查。
- 思考型模型（DeepSeek reasoner 等）在多轮带工具调用时要求回传 `reasoning_content`，本应用已原样带回，不会再报 400。

### 其他
- 中英双语：`设置 → 通用 → 界面语言` 可在「简体中文 / English」间切换，切换后立即生效（含菜单、设置页 12 个分区、相对时间、审批文案、命令面板与快捷键说明）。默认中文。深色 / 浅色 / 跟随系统三态完整适配，首帧前写好 `data-theme` 无白闪。
- 会话导出三种格式：Markdown / JSON / 单文件 HTML（顶栏导出按钮，或右键会话），默认文件名带「会话名 + 时间戳」，落 `<工作区>/exports`、`<会话文件夹>/exports` 或 `<userData>/exports`。
- 更新检查：`设置 → 软件更新`。默认查 GitHub 上 `RuiHn7/NAIWA-AI` 的最新版本（依次尝试 `releases/latest` → `tags` → 默认分支的 `package.json`，三级兜底）；**打开软件时自动检查**（可在同一页关掉）。发现新版本时，侧栏用户卡片**上方**出现蓝色胶囊「新版本 x.y.z」，点它打开下载页，点右侧 × 忽略本次提醒。想走自建分发时设环境变量 `NAIWA_UPDATE_MANIFEST` 指向一个 `{ version, url, notes }` 的 JSON 即可，优先级最高。
- 命令面板 `Ctrl/⌘ + P`，16 条命令 + 会话跳转。
- 全局快捷键：`Ctrl+N` 新对话、`Ctrl+P` 命令面板、`Ctrl+,` 设置、`Ctrl+B` 折叠侧栏、`Esc` 逐层退出。
- 拖拽文件进输入框即作为附件；支持粘贴截图；支持语音直录（Web Speech API，`zh-CN`）。
- 权限模式两档：`approval`（每次问）/ `full`（全放行）。每次决策都写审计日志。
- 系统托盘常驻，关窗口不退出（可在设置里改成直接退出）。托盘右键菜单：`打开程序` / `新建会话` / `设置` / `退出 NAI WA`（红色圆点标记）。**判断依据是设置里的「关闭窗口时」**，跟托盘是否创建成功无关，所以打包版也不会关窗即退。
- 会话写入磁盘走「写临时文件 → 原子替换」，断电或崩溃不会留下半截文件。
- **移除工作区不会丢会话**：工作区被移除（或连目录一起删）时，原本属于它的会话全部回到独立状态，磁盘文件夹自动迁回默认存放位置（`D:\NAI WA`）。
- **性能**：侧栏 / 顶栏 / 输入区 / 消息列都改成窄选择器订阅，流式输出期间侧栏 DOM 完全不动（实测流式一条消息期间 `.sb-list` 的 MutationObserver 计数为 0）。
- **图片后端要选能出图的**：`设置 → 图片生成` 里如果 Base URL 填的是 DeepSeek / Moonshot / 百炼 / 火山 / 智谱这类只有文本接口的地址，表单会当场给出橙色警告，生成时也会直接说明「这个地址没有 /images/generations，必然 404」，并给出可选的替代后端，而不是只回一段 `HTTP 404 Not Found`。

---

## 目录结构

```
desktop/                主进程
  main.ts               窗口 / 托盘 / CSP / 单实例锁
  preload.ts            contextBridge 暴露 window.naiwa
  ipc/index.ts          全部 IPC 路由
  store/                JSON 持久化：settings / providers / chats / workspaces /
                        memory / personas / usage / audit / images / secrets / paths
  llm/                  openai.ts / anthropic.ts / gemini.ts / registry.ts / sse.ts
  agent/                runner.ts（ReAct 主循环）/ tools.ts / compress.ts /
                        permissions.ts / sandbox.ts / prompt.ts / imagegen.ts /
                        paint.ts（内置程序化出图）/ vlm.ts（本地视觉模型托管）/
                        vision.ts（识图三层接力）/ update.ts（版本检查）
  mcp/                  client.ts（手写 JSON-RPC）/ store.ts
  tasks/scheduler.ts    cron 与一次性任务调度
shared/                 types.ts / ipc.ts —— 主进程与渲染层共用契约
src/                    React 渲染层
  App.tsx               根布局 + 全局快捷键 + 拖拽遮罩
  components/           12 个通用组件 + message/ + settings/（12 分区）
  store/useApp.ts       zustand，事件总线接线
  lib/                  bridge / format / markdown / i18n / approval
  styles/               tokens / base / layout / chat / composer / panels / overlays /
                        highlight（深空蓝 + 青色 accent，大圆角 6/8/12/16）
scripts/                build-main.mjs / dev.mjs / app-exe.mjs / mock-*.mjs / cdp.mjs /
                        i18n-audit.mjs / ico-extract.mjs
build/                  图标（ico / icns / png / icons）+ license.txt
```

运行时数据在 `%APPDATA%\naiwa-desktop\`（macOS `~/Library/Application Support/naiwa-desktop`，Linux `~/.config/naiwa-desktop`）：

```
settings.json  providers.json  secrets.json  personas.json  mcp.json  tasks.json
usage.json  images.json  image-history.json  audit.jsonl
chats/<id>.json         一会话一文件
workspaces/<id>/        memory/ attachments/ artifacts/ exports/ .sandbox/
```

`D:\NAI WA\`（或探测到的非系统盘根目录）下是未绑定工作区的会话文件夹，每个会话一个目录，名字是创建时间 `2026-11-26_07-55-54`，里面同样是 `attachments/ artifacts/ exports/ .sandbox/`。

工作区是用户自己的目录，`seedWorkspace` 只在里面补建上述 5 个子目录，不碰其他文件。

---

## 本地联调工具（`scripts/`，仅开发用）

```bash
node scripts/mock-llm.mjs 8799      # 假 OpenAI 兼容接口（默认只回「该模型开发中」，MOCK_DEMO=1 才走完整 DEMO/工具分支）
node scripts/mock-image.mjs 8798    # 假出图接口（sdwebui + openai 两种路由）
node scripts/mock-mcp.mjs           # 假 MCP stdio 服务器（echo / now 两个工具）
node scripts/cdp.mjs shot out.png   # 通过 CDP 截图（需 --remote-debugging-port=9333 启动）
node scripts/i18n-audit.mjs         # 检查 t('…') 用到但词典缺的键（应为 missing: 0）
node scripts/scan-cjk.mjs           # 列出没走 t() 的中文字面量（含 KEY 定义，人工判读）
node scripts/app-exe.mjs            # 重建「NAI WA.exe」开发版启动器（改进程名与图标）
node scripts/ico-extract.mjs src.ico out.png  # 从 ico 里抽最大一帧（Icon 只给最小帧时用）
```

> `mock-llm.mjs` 现在默认对所有请求只返回「该模型开发中，请接入 API 以使用本 Agent 工具」。想回归 markdown / 工具审批流程时用 `MOCK_DEMO=1 node scripts/mock-llm.mjs 8799`。

`cdp.mjs` 还支持 `eval` / `fill`（触发 React onChange 必须用它）/ `click` / `key` / `shotw` / `evalw`。

---

## 已知边界

- 只测过 Windows（开发版 + NSIS 安装版）。macOS / Linux 构建脚本就位但未实机验证。
- 图片后端里只有 `sdwebui` 走通了真实联调；`openai` / `stability` / `comfyui` 按官方接口实现，未接真实 key 验证 —— 但这几个即使失败也会自动落到内置渲染，不会卡住出图。
- 应用未签名，Windows 首次运行会被 SmartScreen 拦一次。
- 语音输入依赖 Chromium 的 Web Speech API，离线环境下不可用。

---

## 仓库

- 源码：<https://github.com/RuiHn7/NAIWA-AI>
- 更新检查默认读这个仓库的最新版本（`releases/latest` → `tags` → `package.json`）。

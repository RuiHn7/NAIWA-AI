/* ============================================================================
 * scripts/mock-llm.mjs —— 本地 OpenAI 兼容 mock 服务，仅用于冒烟验收
 *
 *   node scripts/mock-llm.mjs [port]
 *
 * 支持：
 *   GET  /v1/models            返回模型列表
 *   POST /v1/chat/completions  默认只回「该模型开发中，请接入 API…」，用于验证占位模型
 *                              的提示文案。用 MOCK_DEMO=1 启动则恢复回归行为：
 *                              请求里带 “查一下” 时先发一个 web_search 的 tool_call，
 *                              收到 tool 结果后再出正文；普通消息返回 DEMO —— 覆盖
 *                              markdown 全要素
 * ==========================================================================*/

import http from 'node:http';

const PORT = Number(process.argv[2] || 8799);

/* 默认行为：这两个模型一律回「开发中」提示，跟前端配置里的占位模型一致。
 * 需要跑 markdown / 工具 / 审批等回归时，用 MOCK_DEMO=1 启动即可恢复旧行为。 */
const DEMO_MODE = process.env.MOCK_DEMO === '1';

const DEVELOPING = `**该模型开发中，请接入 API 以使用本 Agent 工具。**

到「设置 → 接入模型」里添加一个真实接入项（OpenAI 兼容 / Anthropic / Gemini 都行），填好 Base URL 与 API Key，拉取模型列表后选中它，就能开始对话了。`;

const MODELS = [
  { id: 'mock-flash', object: 'model', owned_by: 'mock' },
  { id: 'mock-reason', object: 'model', owned_by: 'mock', reasoning: true },
];

function chunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/* Markdown 全要素回归用的正文：标题层级 / 嵌套列表 / 表格 / 代码块 / 行内代码 /
 * 链接 / 图片 / 引用 / 任务列表 / 粗斜体删除线。 */
const DEMO = `收到：「__ECHO__」。

# 一级标题
## 二级标题
### 三级标题

普通段落，包含 **粗体**、*斜体*、~~删除线~~、行内代码 \`npm run build\` 和一个[链接](https://example.com)。

## 无序 · 三层嵌套

- 一级要点
  - 二级要点
    - 三级要点
  - 二级要点之二
- 一级要点之二
  - 二级要点之三

## 有序 · 混嵌套

1. 第一步：拉代码
   1. 切到工作目录
   2. 跑安装
2. 第二步：编译
   - 主进程
   - 渲染层
3. 第三步：验收

## 任务列表

- [x] 无边框标题栏
- [x] 输入区重组
- [ ] 拖拽迁移
- [ ] 打包验证

## 表格

| 模块 | 状态 | 备注 |
| --- | --- | --- |
| 窗口框架 | 完成 | frameless |
| 会话生命周期 | 完成 | 每会话一文件夹 |
| Markdown | 回归中 | 嵌套列表 |

## 代码

\`\`\`ts
export function dayBucket(ts: number, now = Date.now()): Bucket {
  const diff = Math.floor((now - ts) / 86400000);
  return diff <= 0 ? '今天' : '本周';
}
\`\`\`

\`\`\`bash
npx tsc -p tsconfig.web.json --noEmit && npx vite build
\`\`\`

> 引用块也应该正常显示。
> 第二行引用里也可以有 **强调** 和 \`代码\`。

![占位图](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)
`;

function emitText(res, text, model) {
  const pieces = text.match(/[\s\S]{1,6}/g) ?? [];
  let i = 0;
  const timer = setInterval(() => {
    if (i >= pieces.length) {
      clearInterval(timer);
      res.write(
        chunk({
          id: 'chatcmpl-mock',
          object: 'chat.completion.chunk',
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 320, completion_tokens: 180, total_tokens: 500 },
        }),
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.write(
      chunk({
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta: { content: pieces[i] }, finish_reason: null }],
      }),
    );
    i += 1;
  }, 28);
}

function emitToolCall(res, model, id, name, args) {
  res.write(
    chunk({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
  );
  res.write(
    chunk({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    }),
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: MODELS }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let payload = {};
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        /* ignore */
      }

      const model = payload.model || 'mock-flash';
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const last = messages[messages.length - 1] ?? {};
      const lastText =
        typeof last.content === 'string'
          ? last.content
          : Array.isArray(last.content)
            ? last.content.map((p) => p?.text ?? '').join(' ')
            : '';
      const hasToolResult = (() => {
        // 只看最后一条 user 消息之后有没有 tool 结果，否则历史里的旧结果会误判
        let lastUser = -1;
        messages.forEach((m, i) => {
          if (m.role === 'user') lastUser = i;
        });
        return messages.slice(lastUser + 1).some((m) => m.role === 'tool');
      })();
      const textOf = (m) =>
        typeof m?.content === 'string'
          ? m.content
          : Array.isArray(m?.content)
            ? m.content.map((p) => p?.text ?? '').join(' ')
            : '';
      const lastUserText = textOf(
        [...messages].reverse().find((m) => m.role === 'user') ?? {},
      );
      const wantsTool = lastUserText.includes('查一下');
      const wantsWrite = lastUserText.includes('写个文件');
      const lastToolName = [...messages].reverse().find((m) => m.role === 'tool')?.name ?? '';
      // 软件工程智能体工具回归：ls-grep-patch-diff-finish 一条链路
      const isAgentDrill = lastUserText.includes('工具回归');
      // 打转回归：验证 runner 对重复调用的中止
      const isAgentLoop = lastUserText.includes('打转回归');
      // 补丁报错回归：验证 edit_patch 的错误信息是否可读
      const isAgentFail = lastUserText.includes('补丁报错回归');
      // 识图回归：验证内置离线识别模型能说出「这是什么」
      const isVisionDrill = lastUserText.includes('识图回归');
      // 生图回归：验证产物能在对话里内联显示
      const isImageDrill = lastUserText.includes('生图回归');

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      if (!DEMO_MODE) {
        emitText(res, DEVELOPING, model);
        return;
      }

      /* 识图 / 出图后的视觉核对：请求里带图片 part 就走这条，返回一段固定描述。
       * 用来验证「纯文本主模型 + 独立视觉模型」这条链路是通的。 */
      const hasImagePart = messages.some(
        (m) => Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url'),
      );
      if (hasImagePart) {
        emitText(
          res,
          '画面是一片深蓝色夜空，中间横着一条偏灰紫的星带，下方是黑色山脊剪影；整体冷调、噪点明显，画面里没有用户描述的家具主体。这是模板化的风景底图，不是具体物体。',
          model,
        );
        return;
      }

      // 软件工程智能体工具回归：ls → grep → write_file → edit_patch → shell → git_diff → finish
      if (isAgentDrill) {
        const lastUserIdx =
          messages.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0).pop() ?? 0;
        // 回传的 tool 消息没有 name 字段，按 tool 结果条数推进步骤
        const steps = [
          ['ls', {}],
          ['grep', { pattern: 'hello', include: '*.txt' }],
          ['write_file', { path: 'drill/note.txt', content: 'hello one\nhello two\n' }],
          ['edit_patch', { path: 'drill/note.txt', old_string: 'hello two', new_string: 'HELLO TWO' }],
          ['shell', { command: 'echo drill-ok' }],
          ['git_diff', {}],
          [
            'finish',
            {
              summary: '工具回归：ls / grep / write_file / edit_patch / shell / git_diff 全链路跑通。',
              changes: ['drill/note.txt —— 新建并局部替换一行'],
              commands: ['echo drill-ok —— 退出码 0'],
              verification: 'mock 环境下每个工具都返回成功，finish 正常收尾。',
            },
          ],
        ];
        const done = messages.slice(lastUserIdx + 1).filter((m) => m.role === 'tool').length;
        const [name, args] = steps[Math.min(done, steps.length - 1)];
        return emitToolCall(res, model, `call_drill_${done}_${name}`, name, args);
      }

      // 生图回归：验证 generate_image 产出的图片能在对话里内联显示
      if (isImageDrill) {
        const lastUserIdxG =
          messages.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0).pop() ?? 0;
        const doneG = messages.slice(lastUserIdxG + 1).filter((m) => m.role === 'tool').length;
        if (doneG === 0) {
          return emitToolCall(res, model, 'call_img_1', 'image_gen', {
            prompt: '一张实木书桌，长方形桌面，四条笔直桌腿，浅灰墙面背景，柔和棚拍光，产品摄影',
            size: '768x768',
            style: 'photo',
          });
        }
        return emitToolCall(res, model, 'call_img_finish', 'finish', {
          summary: '生图回归：图片已生成，工具卡里应带出图后端标签、模板说明与视觉核对结果。',
        });
      }

      // 识图回归：先调 image_understand，再把报告摘要放进 finish 的 summary
      if (isVisionDrill) {
        const lastUserIdxV =
          messages.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0).pop() ?? 0;
        const toolMsgsV = messages.slice(lastUserIdxV + 1).filter((m) => m.role === 'tool');
        if (!toolMsgsV.length) {
          return emitToolCall(res, model, 'call_vision_1', 'image_understand', {
            image_url: process.env.MOCK_IMAGE || 'C:/Users/Administrator/Desktop/1 (2).png',
            query: '这是什么？图里有什么？',
          });
        }
        const raw = toolMsgsV[0].content;
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
        return emitToolCall(res, model, 'call_vision_finish', 'finish', {
          summary: '识图回归结果：' + text.replace(/\s+/g, ' ').slice(0, 600),
        });
      }

      // 补丁报错回归：故意给一个不存在的 old_string，验证 tool 返回的可读报错
      if (isAgentFail) {        const lastUserIdxF =
          messages.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0).pop() ?? 0;
        const doneF = messages.slice(lastUserIdxF + 1).filter((m) => m.role === 'tool').length;
        if (doneF === 0) {
          return emitToolCall(res, model, 'call_fail_patch', 'edit_patch', {
            path: 'drill/note.txt',
            old_string: '这段文本根本不存在 in file',
            new_string: 'x',
          });
        }
        return emitToolCall(res, model, 'call_fail_finish', 'finish', {
          summary: '补丁报错回归：故意制造失败，检查报错是否可读。',
        });
      }

      // 打转回归：永远发同一个 ls，用来验证 runner 的重复调用保护
      if (isAgentLoop) {
        return emitToolCall(res, model, `call_loop_${Date.now()}`, 'ls', {});
      }

      if (!hasToolResult) {
        // 前 12 个 chunk 发推理内容，验证 thinking 区
        let r = 0;
        const think =
          '用户想让我说明白这件事。先确认一下需要哪些信息，再决定是否调用工具。';
        const pieces = think.match(/[\s\S]{1,5}/g) ?? [];
        const t = setInterval(() => {
          if (r >= pieces.length) {
            clearInterval(t);
            if (lastUserText.includes('echo')) {
              res.write(
                chunk({
                  id: 'chatcmpl-mock',
                  object: 'chat.completion.chunk',
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: 'call_mock_echo',
                            type: 'function',
                            function: {
                              name: 'echo',
                              arguments: JSON.stringify({ text: lastUserText }),
                            },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                }),
              );
              res.write(
                chunk({
                  id: 'chatcmpl-mock',
                  object: 'chat.completion.chunk',
                  model,
                  choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                }),
              );
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
            if (wantsWrite) {
              res.write(
                chunk({
                  id: 'chatcmpl-mock',
                  object: 'chat.completion.chunk',
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: 'call_mock_write',
                            type: 'function',
                            function: {
                              name: 'write_file',
                              arguments: JSON.stringify({
                                path: 'mock-note.md',
                                content: '# NAI WA mock\n\n这是审批流程的测试文件。\n',
                              }),
                            },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                }),
              );
              res.write(
                chunk({
                  id: 'chatcmpl-mock',
                  object: 'chat.completion.chunk',
                  model,
                  choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                }),
              );
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
            if (wantsTool) {
              res.write(
                chunk({
                  id: 'chatcmpl-mock',
                  object: 'chat.completion.chunk',
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: 'call_mock_1',
                            type: 'function',
                            function: { name: 'web_search', arguments: '{"query":"NAI WA 桌面端"}' },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                }),
              );
              res.write(
                chunk({
                  id: 'chatcmpl-mock',
                  object: 'chat.completion.chunk',
                  model,
                  choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                }),
              );
              res.write('data: [DONE]\n\n');
              res.end();
            } else {
              emitText(
                res,
                DEMO.replace('__ECHO__', lastText.slice(0, 40).replace(/\n/g, ' ')),
                model,
              );
            }
            return;
          }
          res.write(
            chunk({
              id: 'chatcmpl-mock',
              object: 'chat.completion.chunk',
              model,
              choices: [
                { index: 0, delta: { reasoning_content: pieces[r] }, finish_reason: null },
              ],
            }),
          );
          r += 1;
        }, 16);
        return;
      }

      emitText(
        res,
        lastToolName
          ? `工具 \`${lastToolName}\` 已经执行完毕，结果是：\n\n> ${lastText.slice(0, 80).replace(/\n/g, ' ')}\n\n需要我接着做别的吗？\n`
          : '查完了：**NAI WA 是一个本地优先的桌面 AI Agent**。\n\n1. 会话存本机\n2. 工具调用要审批\n3. 支持 MCP 外部工具\n',
        model,
      );
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-llm] listening on http://127.0.0.1:${PORT}/v1`);
});

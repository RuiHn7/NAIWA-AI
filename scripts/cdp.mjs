/* ============================================================================
 * scripts/cdp.mjs —— 通过 Chrome DevTools Protocol 驱动已开启调试端口的 Electron
 *
 *   node scripts/cdp.mjs <command> [args...]
 *
 * 命令：
 *   eval "<js>"        在页面里执行表达式并打印结果
 *   shot <file>        整窗截图
 *   type "<text>"      往当前焦点元素输入（用 Input.insertText）
 *   click "<sel>"      点击匹配选择器的第一个元素
 *   key <keyName>      发送按键（Enter / Escape / Tab ...）
 * ==========================================================================*/

const PORT = Number(process.env.CDP_PORT || 9333);

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

function pick(list) {
  return (
    list.find(t => t.type === 'page' && t.url.includes('index.html')) ??
    list.find(t => t.type === 'page') ??
    list[0]
  );
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.waiting = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', e => reject(e));
    });
    this.ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve, reject } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

const [, , cmd, ...rest] = process.argv;

const list = await targets();
const target = pick(list);
if (!target) {
  console.error('no page target found');
  process.exit(1);
}

const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.ready;
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');

async function evaluate(expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    return `EXCEPTION: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`;
  }
  const v = res.result?.value;
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

if (cmd === 'eval') {
  console.log(await evaluate(rest.join(' ')));
} else if (cmd === 'shot') {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const fs = await import('node:fs');
  fs.writeFileSync(rest[0] || 'shot-cdp.png', Buffer.from(data, 'base64'));
  console.log('saved', rest[0] || 'shot-cdp.png');
} else if (cmd === 'type') {
  await cdp.send('Input.insertText', { text: rest.join(' ') });
  console.log('typed');
} else if (cmd === 'fill') {
  const sel = rest[0];
  const text = rest.slice(1).join(' ');
  console.log(
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return 'not found';
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'filled';
    })()`),
  );
} else if (cmd === 'click') {
  console.log(
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(rest[0])});
      if (!el) return 'not found: ' + ${JSON.stringify(rest[0])};
      el.click();
      return 'clicked';
    })()`),
  );
} else if (cmd === 'resize') {
  // 只做 CSS 视口模拟，不动真实窗口；截图会按这个宽度渲染
  const width = Number(rest[0] || 1280);
  const height = Number(rest[1] || 820);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 700,
  });
  console.log('emulated viewport', width, height);
} else if (cmd === 'evalw') {
  // 设置视口 + 求值（同一个 CDP session，matchMedia 才会跟着变）
  const width = Number(rest[0] || 1280);
  const height = Number(rest[1] || 820);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 700,
  });
  await new Promise((r) => setTimeout(r, 500));
  console.log(await evaluate(rest.slice(2).join(' ')));
} else if (cmd === 'shotw') {
  // 同一个会话里设置视口再截图（Emulation 覆盖是 session 级的）
  const width = Number(rest[0] || 1280);
  const height = Number(rest[1] || 820);
  const file = rest[2] || 'shot-cdp.png';
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 700,
  });
  await new Promise((r) => setTimeout(r, 700));
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const fs = await import('node:fs');
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(
    'saved',
    file,
    'viewport',
    await evaluate('innerWidth + "x" + innerHeight'),
  );
} else if (cmd === 'key') {
  const key = rest[0];
  const map = {
    Enter: { windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' },
    Escape: { windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' },
    Tab: { windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab' },
    Backspace: { windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' },
  };
  const def = map[key] ?? { key };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...def });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...def });
  console.log('key', key);
} else {
  console.error('usage: node scripts/cdp.mjs <eval|shot|type|click|key> ...');
}

cdp.close();

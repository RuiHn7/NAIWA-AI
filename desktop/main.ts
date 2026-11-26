/* ============================================================================
 * desktop/main.ts —— Electron 主进程入口
 *   · 单实例锁 / 窗口状态持久化 / 托盘 / 快捷键 / 主题跟随系统
 *   · contextIsolation + 无 nodeIntegration，所有能力通过 preload 白名单暴露
 *   · 安全：禁止渲染进程直接 new-window、外链走系统浏览器、webview 白名单
 * ==========================================================================*/

import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, session, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { initPaths, dataRoot, detectChatRoot } from './store/paths';
import { getSettings, saveSettings } from './store/settings';
import { registerIpc } from './ipc/index';
import { bindApprovalEmitter } from './agent/permissions';
import { bindAgent } from './agent/runner';
import { bindMcpListener } from './mcp/client';
import { bindTaskNotifier, startScheduler } from './tasks/scheduler';
import { getChat, pruneBlankChats } from './store/chats';
import type { AgentEvent, ApprovalRequest, McpServerState, ScheduledTask, TaskRunRecord } from '@shared/types';
import { EventMap } from '@shared/ipc';

const DEV_URL = process.env.VITE_DEV_SERVER_URL;

/* ------------------------------------------------------------------ webview 白名单 */

/**
 * 白名单匹配：支持 `*` 通配。
 * 注意 Electron 的 will-attach-webview 里 params.src 有时是带尾斜杠的
 * 「https://developer.mozilla.org/」，所以这里统一先去掉尾部斜杠再比。
 */
function matchAllow(pattern: string, target: string): boolean {
  const trim = (s: string) => s.replace(/\/+$/, '');
  const escaped = trim(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  try {
    return new RegExp(`^${escaped}/?$`, 'i').test(trim(target)) || new RegExp(`^${escaped}`, 'i').test(target);
  } catch {
    return false;
  }
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

/* ------------------------------------------------------------------ 事件总线 */

function emit<K extends keyof EventMap>(channel: K, payload: EventMap[K]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/* ------------------------------------------------------------------ 窗口状态 */

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

function stateFile(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState(): WindowState {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf8');
    const parsed = JSON.parse(raw) as WindowState;
    if (parsed.width && parsed.height) return parsed;
  } catch {
    /* 首次启动 */
  }
  return { width: 1280, height: 820 };
}

function saveWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getNormalBounds();
  const state: WindowState = { ...bounds, maximized: mainWindow.isMaximized() };
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2), 'utf8');
  } catch {
    /* 磁盘不可写时忽略 */
  }
}

/* ------------------------------------------------------------------ 窗口 */

/**
 * 应用图标路径。打包后 `__dirname` 在 asar 内（resources/app.asar/dist-electron），
 * `../build/icon.png` 只有把 build/ 也打进 files 时才存在；这里再补
 * resourcesPath 与 dist/ 两个兜底位置，避免托盘/窗口图标拿不到。
 */
function iconPath(): string {
  const candidates = [
    path.join(__dirname, '../build/icon.png'),
    path.join(process.resourcesPath ?? '', 'build/icon.png'),
    path.join(__dirname, '../dist/icon.png'),
    path.join(process.resourcesPath ?? '', 'icon.png'),
    path.join(__dirname, '../build/icon.ico'),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function createWindow(): void {
  const state = loadWindowState();
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0d13' : '#f6f8fc',
    title: 'NAI WA',
    icon: iconPath() || undefined,
    autoHideMenuBar: true,
    // 自绘标题栏（PRD 二.1）：Windows/Linux 完全去边框，mac 保留红绿灯并让出位置
    frame: false,
    titleBarStyle: isMac ? 'hidden' : 'default',
    trafficLightPosition: isMac ? { x: 14, y: 14 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: false,
    },
  });

  if (state.maximized) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    pushWindowState();
  });

  // 最大化状态变化要推给渲染层，标题栏才能换图标
  mainWindow.on('maximize', () => pushWindowState());
  mainWindow.on('unmaximize', () => pushWindowState());
  mainWindow.on('enter-full-screen', () => pushWindowState());
  mainWindow.on('leave-full-screen', () => pushWindowState());

  if (DEV_URL) {
    void mainWindow.loadURL(DEV_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.webContents.on('did-finish-load', () => {
    applyTheme();
    pushWindowState();
  });

  // 外链一律走系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const allowlist = getSettings().webviewAllowlist ?? [];
    const target = params.src ?? '';
    const allowed = target === '' || allowlist.some(pattern => matchAllow(pattern, target));
    if (!allowed) event.preventDefault();
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.preload = undefined;
  });

  mainWindow.on('close', event => {
    saveWindowState();
    // 关闭行为跟随设置：最小化到托盘 / 直接退出（PRD 二.1）。
    // 这里**不再**要求 tray 对象一定存在 —— 托盘创建失败（图标缺失等）时，
    // 用户设的是「最小化到托盘」，就应该仍然收起窗口而不是整个退出。
    const toTray = getSettings().closeAction !== 'quit';
    if (!quitting && toTray) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** 把最大化 / 全屏状态推给渲染进程 */
function pushWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  emit('window:state', { maximized: mainWindow.isMaximized(), fullscreen: mainWindow.isFullScreen() });
}

function applyTheme(): void {
  const { theme } = getSettings();
  nativeTheme.themeSource = theme === 'system' ? 'system' : theme;
  emit('theme:changed', { shouldUseDarkColors: nativeTheme.shouldUseDarkColors });
}

/**
 * 首次启动时确定会话根目录：设置里没存就自动探测非系统盘，
 * 探测失败把原因写进 chatRootFallback 供设置页提示。
 */
function bootstrapChatRoot(): void {
  const settings = getSettings();
  if (settings.chatRoot) return;
  const { dir, fallback } = detectChatRoot();
  saveSettings({ chatRoot: dir, chatRootFallback: fallback ?? undefined });
}

/* ------------------------------------------------------------------ 窗口控制 IPC */

function registerWindowIpc(): void {
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize();
  });
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return { maximized: false };
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { maximized: mainWindow.isMaximized() };
  });
  ipcMain.handle('window:close', () => {
    mainWindow?.close();
  });
  ipcMain.handle('window:state', () => ({
    maximized: !!mainWindow?.isMaximized(),
    fullscreen: !!mainWindow?.isFullScreen(),
  }));
}

/* ------------------------------------------------------------------ 托盘 */

/**
 * 托盘菜单里「退出」前面的红色圆点。Electron 的原生菜单没法给文字上色，
 * 唯一能表达「红色」的就是给这一项挂一个红色图标。直接内联 PNG，省掉打包资源路径问题。
 */
const RED_DOT_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAMCAYAAABWdVznAAAASklEQVR42mN44OXFQApGFwh44OV18YGX138ovggVw6phApJCdDwBXUMAHsUwHICs4SIRGi4ia/hPJCZfA8lOItnTJAcrWRFHFAYAakMgVL7M5PkAAAAASUVORK5CYII=';

function redDot(): Electron.NativeImage {
  const image = nativeImage.createFromBuffer(Buffer.from(RED_DOT_PNG, 'base64'));
  return image.isEmpty() ? image : image.resize({ width: 10, height: 10 });
}

function showMainWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

function createTray(): void {
  // 图标缺失也要把托盘建出来：托盘是「关窗后还能回来」的唯一入口，
  // 早期这里 `if (!icon) return;` 会让打包版直接没有托盘，关窗即退出。
  const icon = iconPath();
  let image = icon ? nativeImage.createFromPath(icon) : nativeImage.createEmpty();
  if (image.isEmpty()) {
    const fallback = path.join(process.resourcesPath ?? '', 'icon.png');
    if (fs.existsSync(fallback)) image = nativeImage.createFromPath(fallback);
  }
  if (image.isEmpty()) console.warn('[NAI WA] 托盘图标缺失，使用空图标占位');
  try {
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 18, height: 18 }));
  } catch (err) {
    console.warn('[NAI WA] 托盘创建失败：', (err as Error).message);
    return;
  }
  const menu = Menu.buildFromTemplate([
    { label: '打开程序', click: () => showMainWindow() },
    { label: '新建会话', click: () => emit('nav:command', { command: 'new-chat' }) },
    { label: '设置', click: () => emit('nav:command', { command: 'settings' }) },
    { type: 'separator' },
    {
      label: '退出 NAI WA',
      icon: redDot(),
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setToolTip('NAI WA');
  tray.setContextMenu(menu);
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
  tray.on('right-click', () => tray?.popUpContextMenu(menu));
  console.log('[NAI WA] 托盘已创建');
}

/* ------------------------------------------------------------------ 单实例 */

/**
 * 进程身份：开发版跑的是 electron.exe，任务管理器里会显示「Electron」。
 * setName 让任务管理器 / 通知 / 任务栏分组都显示 NAI WA。
 * 注意：setName 会连带改变默认 userData 路径，所以紧接着把 userData
 * 显式钉回原来的 `naiwa-desktop` 目录，老数据（会话/设置/密钥）照旧可读。
 */
app.setName('NAI WA');
/**
 * 默认 userData 固定在 naiwa-desktop，老数据照旧可读。
 * 开发 / 验收时可以用 NAIWA_PROFILE=test 启动一份独立的用户数据（含单实例锁），
 * 这样不用退出正在用的正式版本也能同时跑一个干净实例。
 */
const profile = (process.env.NAIWA_PROFILE ?? '').trim();
app.setPath('userData', path.join(app.getPath('appData'), profile ? `naiwa-desktop-${profile}` : 'naiwa-desktop'));
app.setAppUserModelId('com.naiwa.desktop');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

/* ------------------------------------------------------------------ 启动 */

app.whenReady().then(() => {
  initPaths();

  // 首次启动：探测非系统盘作为会话默认存放位置（PRD 四.1）
  bootstrapChatRoot();

  // 空白会话不恢复（PRD 四.2）
  try {
    pruneBlankChats();
  } catch {
    /* 首次启动目录还没建好时忽略 */
  }

  // CSP：允许内联样式（主题变量）与本地文件，禁止外部脚本
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: file:",
      "media-src 'self' data: blob:",
      "font-src 'self' data:",
      DEV_URL ? `connect-src 'self' ${DEV_URL} ws://localhost:* http://localhost:* https:` : "connect-src 'self' data: blob: https:",
      "frame-src 'self' https: http:",
    ].join('; ');
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });

  bindApprovalEmitter((channel, payload: ApprovalRequest) => emit(channel, payload));
  bindAgent(
    (event: AgentEvent) => emit('agent:event', event),
    () => {
      /* 会话写盘后渲染层通过主动刷新获取，无需额外推送 */
    },
  );
  bindMcpListener((state: McpServerState) => emit('mcp:state', state));
  bindTaskNotifier((task: ScheduledTask, record: TaskRunRecord) => {
    emit('task:completed', { task, record });
  });

  registerIpc(emit);
  registerWindowIpc();
  createWindow();
  createTray();
  applyTheme();
  startScheduler();

  nativeTheme.on('updated', () => {
    emit('theme:changed', { shouldUseDarkColors: nativeTheme.shouldUseDarkColors });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('window-all-closed', () => {
  // 只有用户明确选择「关闭窗口时直接退出」才真的退出；
  // 设在托盘时窗口关掉只是隐藏，主进程必须活着等托盘把窗口唤回来。
  if (process.platform !== 'darwin' && getSettings().closeAction === 'quit') app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  saveWindowState();
  // 明确终止所有挂起的审批，避免主进程卡在 Promise 上
  import('./agent/permissions').then(m => m.clearPending()).catch(() => {});
});

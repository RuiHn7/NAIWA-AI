/* ============================================================================
 * desktop/preload.ts —— 渲染进程唯一入口
 * 只把 shared/ipc.ts 里登记过的通道暴露出去，白名单之外一律不可达。
 * ==========================================================================*/

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { NaiwaApi } from '@shared/ipc';

const api: NaiwaApi = {
  invoke(channel, payload) {
    return ipcRenderer.invoke(channel, payload) as Promise<any>;
  },
  on(channel, handler) {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => handler(payload as never);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  platform: process.platform,
  // 拖拽进来的 File 没有 .path 了，只能靠 webUtils 换真实磁盘路径
  pathForFile(file) {
    try {
      if (!file) return '';
      return webUtils.getPathForFile(file as File) ?? '';
    } catch {
      return '';
    }
  },
};

contextBridge.exposeInMainWorld('naiwa', api);

// 便于渲染层在开发期确认 preload 已生效
contextBridge.exposeInMainWorld('naiwaBridge', {
  version: process.versions.electron,
  node: process.versions.node,
  chrome: process.versions.chrome,
});

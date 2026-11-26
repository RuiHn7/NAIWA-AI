/* ============================================================================
 * src/lib/bridge.ts —— preload 暴露的 window.naiwa 的类型化包装
 * 渲染进程绝不直接碰 Node / fs，一律走这里。
 * ==========================================================================*/

import type { NaiwaApi } from '@shared/ipc';

declare global {
  interface Window {
    naiwa?: NaiwaApi;
    naiwaBridge?: { version: string; node: string; chrome: string };
  }
}

const noop = (): void => {};

/** 在普通浏览器里预览时给出可读的降级，不至于整页崩掉 */
function missing(): NaiwaApi {
  const fail = async () => {
    throw new Error('当前不在 Electron 环境中运行，桌面能力不可用');
  };
  return {
    invoke: fail as unknown as NaiwaApi['invoke'],
    on: () => noop,
    platform: 'web',
  };
}

export const api: NaiwaApi = typeof window !== 'undefined' && window.naiwa ? window.naiwa : missing();

export const isDesktop = api.platform !== 'web';

export const invoke = api.invoke;
export const on = api.on;

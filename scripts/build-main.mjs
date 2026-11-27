import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';

/** 主进程与 preload 必须打成 CommonJS，Electron 直接加载。 */
const common = {
  platform: 'node',
  target: 'node22',
  bundle: true,
  format: 'cjs',
  sourcemap: true,
  // onnxruntime-node 是原生模块（.node 二进制），必须外部化，随 app 的 node_modules 分发
  external: ['electron', 'onnxruntime-node'],
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: [path.join(root, 'desktop/main.ts')],
  outfile: path.join(root, 'dist-electron/main.cjs'),
});

await build({
  ...common,
  entryPoints: [path.join(root, 'desktop/preload.ts')],
  outfile: path.join(root, 'dist-electron/preload.cjs'),
});

console.log('[build-main] 主进程与 preload 构建完成');

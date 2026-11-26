import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import electronPath from 'electron';
import { ensureAppExe } from './app-exe.mjs';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';

const common = {
  platform: 'node',
  target: 'node22',
  bundle: true,
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
};

async function buildElectron() {
  await build({ ...common, entryPoints: [path.join(root, 'desktop/main.ts')], outfile: path.join(root, 'dist-electron/main.cjs') });
  await build({ ...common, entryPoints: [path.join(root, 'desktop/preload.ts')], outfile: path.join(root, 'dist-electron/preload.cjs') });
}

await buildElectron();

const server = await createServer({ configFile: path.join(root, 'vite.config.ts') });
await server.listen();
const url = `http://127.0.0.1:${server.config.server.port}`;
console.log(`[dev] 渲染进程开发服务器：${url}`);

const child = spawn(ensureAppExe() ?? electronPath, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url, NODE_ENV: 'development' },
});

child.on('close', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    child.kill();
  });
}

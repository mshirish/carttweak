/**
 * npm run dev: API server (:8787) + Vite (:5173, proxies /api to the server).
 * Ctrl+C stops both.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const procs: ChildProcess[] = [];

function start(name: string, args: string[], cwd: string) {
  // the web dev server proxies /api to the API port (PORT, default 8787)
  const p = spawn(node, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, API_PORT: process.env.PORT ?? '8787' } });
  const tag = (s: string) => s.split(/\r?\n/).filter(Boolean).map((l) => `[${name}] ${l}`).join('\n');
  p.stdout!.on('data', (d) => console.log(tag(String(d))));
  p.stderr!.on('data', (d) => console.error(tag(String(d))));
  p.on('exit', (code) => {
    console.log(`[${name}] exited (${code})`);
    stop();
  });
  procs.push(p);
}

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (p.exitCode == null) p.kill();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

start('server', [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'server', 'src', 'index.ts')], root);
start('web', [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', process.env.WEB_PORT ?? '5173', '--strictPort'], path.join(root, 'web'));
console.log('CartTweak: open http://localhost:5173 (API on :8787). Run `npm run warm` first for a fast demo.');

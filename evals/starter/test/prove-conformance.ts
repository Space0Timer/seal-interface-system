// Proves the starter can't be the reason a condition fails: the conformance
// app, dropped into a freshly assembled workspace and served by the
// workspace's own dev server (with its copy of the mock API), passes the
// shared behavior tests. Desktop light is enough to prove the plumbing; the
// tests themselves run in every project elsewhere.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materialize, REPO } from '../src/materialize.ts';

const port = 5399;
const base = `http://localhost:${port}`;
const scratch = mkdtempSync(join(tmpdir(), 'starter-proof-'));

const ws = materialize({ out: join(scratch, 'workspace') });
copyFileSync(join(REPO, 'evals/tests/conformance-app/index.html'), join(ws, 'index.html'));
copyFileSync(join(REPO, 'evals/tests/conformance-app/main.ts'), join(ws, 'main.ts'));

const server = spawn('pnpm', ['exec', 'vite', '--port', String(port), '--strictPort'], { cwd: ws, stdio: 'ignore', detached: true });

async function waitForServer(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(base)).ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the workspace dev server didn't start on ${base}`);
}

let exitCode = 0;
try {
  await waitForServer(30_000);
  execFileSync('pnpm', ['exec', 'playwright', 'test', '--project', 'desktop-light', '--output', join(scratch, 'test-results')], {
    cwd: join(REPO, 'evals', 'tests'),
    stdio: 'inherit',
    env: { ...process.env, EVAL_BASE_URL: base },
  });
  console.log('The conformance app passes the shared behavior tests inside a fresh starter workspace.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  if (server.pid) process.kill(-server.pid, 'SIGTERM');
}
process.exit(exitCode);

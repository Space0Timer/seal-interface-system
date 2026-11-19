// Proves the starter can't be the reason a condition fails: the conformance
// app, dropped into a freshly assembled workspace and served by the
// workspace's own dev server (with its copy of the mock API), passes the
// shared behavior tests. Desktop light is enough to prove the plumbing; the
// tests themselves run in every project elsewhere.
//
// The tests are bound to the server this script started: it gets a free port
// from the OS, starts Vite there with --strictPort, and waits for that
// process to announce the URL. If the process exits (for example on a port
// collision), the proof fails instead of testing another workspace.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materialize, REPO } from '../src/materialize.ts';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

const scratch = mkdtempSync(join(tmpdir(), 'starter-proof-'));
const ws = materialize({ out: join(scratch, 'workspace') });
copyFileSync(join(REPO, 'evals/tests/conformance-app/index.html'), join(ws, 'index.html'));
copyFileSync(join(REPO, 'evals/tests/conformance-app/main.ts'), join(ws, 'main.ts'));

const port = await freePort();
const base = `http://localhost:${port}`;
const server = spawn('pnpm', ['exec', 'vite', '--port', String(port), '--strictPort'], {
  cwd: ws,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let output = '';
let exited: number | null | undefined;
server.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
server.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
server.on('exit', (code) => (exited = code));

async function waitForOwnServer(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-control-regex
  const announced = () => output.replace(/\u001b\[[0-9;]*m/g, '').includes(`localhost:${port}/`);
  while (Date.now() < deadline) {
    if (exited !== undefined) throw new Error(`this workspace's Vite exited (code ${exited}) before serving:\n${output}`);
    if (announced()) {
      try {
        if ((await fetch(base)).ok) return;
      } catch {
        // Announced but not answering yet.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`this workspace's Vite didn't serve on ${base} in time:\n${output}`);
}

let exitCode = 0;
try {
  await waitForOwnServer(30_000);
  execFileSync('pnpm', ['exec', 'playwright', 'test', '--project', 'desktop-light', '--output', join(scratch, 'test-results')], {
    cwd: join(REPO, 'evals', 'tests'),
    stdio: 'inherit',
    env: { ...process.env, EVAL_BASE_URL: base },
  });
  if (exited !== undefined) throw new Error(`this workspace's Vite exited during the tests (code ${exited})`);
  console.log(`The conformance app passes the shared behavior tests inside a fresh starter workspace (${base}).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  if (server.pid && exited === undefined) process.kill(-server.pid, 'SIGTERM');
}
process.exit(exitCode);

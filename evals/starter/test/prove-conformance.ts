// Proves the starter can't be the reason a condition fails: the conformance
// app, dropped into a freshly assembled workspace, built, and served by the
// workspace's own preview server (with its copy of the mock API), passes the
// shared behavior tests. Desktop light is enough to prove the plumbing; the
// tests themselves run in every project elsewhere.
//
// It serves a production build, as the runner will, so no dev-server reload
// can interrupt an upload mid-test.
//
// The tests are bound to the server this script started: it gets a free port
// from the OS, starts `vite preview` there with --strictPort, and waits for
// that process to announce the URL. If the process exits (for example on a
// port collision), the proof fails instead of testing another workspace.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
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

/** Stops the server and its children. Safe if it already exited. */
function stop(server: ChildProcess): void {
  if (server.exitCode !== null || server.signalCode !== null || !server.pid) return;
  try {
    process.kill(-server.pid, 'SIGTERM'); // the whole process group (POSIX)
  } catch {
    server.kill('SIGTERM'); // no group, or not POSIX
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'starter-proof-'));
let server: ChildProcess | undefined;
let exitCode = 0;

try {
  const ws = materialize({ out: join(scratch, 'workspace') });
  copyFileSync(join(REPO, 'evals/tests/conformance-app/index.html'), join(ws, 'index.html'));
  copyFileSync(join(REPO, 'evals/tests/conformance-app/main.ts'), join(ws, 'main.ts'));
  execFileSync('pnpm', ['exec', 'vite', 'build'], { cwd: ws, stdio: 'pipe' });

  const port = await freePort();
  const base = `http://localhost:${port}`;
  const preview = spawn('pnpm', ['exec', 'vite', 'preview', '--port', String(port), '--strictPort'], {
    cwd: ws,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  server = preview;
  let output = '';
  preview.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  preview.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const gone = () => preview.exitCode !== null || preview.signalCode !== null;

  // Wait for this process to announce its own URL, then answer on it.
  // eslint-disable-next-line no-control-regex
  const announced = () => output.replace(/\u001b\[[0-9;]*m/g, '').includes(`localhost:${port}/`);
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (gone()) throw new Error(`this workspace's vite preview exited (code ${preview.exitCode}) before serving:\n${output}`);
    if (announced()) {
      const ok = await fetch(base).then((r) => r.ok, () => false);
      if (ok) break;
    }
    if (Date.now() > deadline) throw new Error(`this workspace's vite preview didn't serve on ${base} in time:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  execFileSync('pnpm', ['exec', 'playwright', 'test', '--project', 'desktop-light', '--output', join(scratch, 'test-results')], {
    cwd: join(REPO, 'evals', 'tests'),
    stdio: 'inherit',
    env: { ...process.env, EVAL_BASE_URL: base },
  });
  if (gone()) throw new Error(`this workspace's vite preview exited during the tests:\n${output}`);
  console.log(`The conformance app passes the shared behavior tests inside a fresh starter workspace (${base}).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  if (server) stop(server);
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(exitCode);

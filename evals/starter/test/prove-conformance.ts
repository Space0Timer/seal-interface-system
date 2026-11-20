// Proves the starter can't be the reason a condition fails: the conformance
// app, dropped into a freshly assembled workspace, built, and served by the
// workspace's own preview server (with its copy of the mock API), passes the
// shared behavior tests. Desktop light is enough to prove the plumbing; the
// tests themselves run in every project elsewhere.
//
// It serves a production build, as the runner does, so no dev-server reload
// can interrupt an upload mid-test.
//
// The tests are bound to the server this script started (see
// src/preview.ts): it gets a free port from the OS, starts `vite preview`
// there with --strictPort, and uses the URL that process announces. If the
// process exits (for example on a port collision), the proof fails instead
// of testing another workspace.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materialize, REPO } from '../src/materialize.ts';
import { startPreview, type Preview } from '../src/preview.ts';

const scratch = mkdtempSync(join(tmpdir(), 'starter-proof-'));
let server: Preview | undefined;
let exitCode = 0;

try {
  const ws = materialize({ out: join(scratch, 'workspace') });
  copyFileSync(join(REPO, 'evals/tests/conformance-app/index.html'), join(ws, 'index.html'));
  copyFileSync(join(REPO, 'evals/tests/conformance-app/main.ts'), join(ws, 'main.ts'));
  execFileSync('pnpm', ['exec', 'vite', 'build'], { cwd: ws, stdio: 'pipe' });

  server = await startPreview(ws);
  execFileSync('pnpm', ['exec', 'playwright', 'test', '--project', 'desktop-light', '--output', join(scratch, 'test-results')], {
    cwd: join(REPO, 'evals', 'tests'),
    stdio: 'inherit',
    env: { ...process.env, EVAL_BASE_URL: server.url },
  });
  if (server.gone()) throw new Error(`this workspace's vite preview exited during the tests:\n${server.output()}`);
  console.log(`The conformance app passes the shared behavior tests inside a fresh starter workspace (${server.url}).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  server?.stop();
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(exitCode);

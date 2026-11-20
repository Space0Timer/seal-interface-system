// The runner, end to end, with the fake adapter (no model calls): a full
// run, a run whose build fails, runs whose isolation fails before and after
// generation, a run whose generation fails, and a run whose generated code
// tries to reach the host during the build and preview. With
// CLAUDE_CODE_BIN set, the same pipeline also runs the real Claude Code CLI
// against the local stub model, which costs nothing.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { claudeCodeAdapter, findClaude } from '../../adapters/claude-code/index.ts';
import { fakeAdapter } from '../../adapters/fake/index.ts';
import type { Adapter } from '../../adapters/types.ts';
import { leakIn } from '../../starter/src/leaks.ts';
import { REPO } from '../../starter/src/materialize.ts';
import { sandboxAvailable } from '../src/confine.ts';
import { renderPrompt } from '../src/prompt.ts';
import { runEval, runLogged, type Manifest } from '../src/run.ts';

const temps: string[] = [];
const resultsRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-results-'));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const quiet = () => undefined;
const failed = (m: Manifest) => m.isolation.checks.filter((c) => !c.ok).map((c) => c.id);
/** Runs fn with one environment variable set, then restores it. */
async function withEnv<T>(name: string, value: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

test('the generator prompt is neutral for every brief: no eval words, owner copy, repo path or placeholder', () => {
  for (const file of readdirSync(join(REPO, 'evals', 'briefs'))) {
    const prompt = renderPrompt(file.replace(/\.md$/, ''));
    assert.equal(leakIn(prompt), null, file);
    assert.ok(!prompt.includes(REPO), file);
    assert.ok(!prompt.includes('{{'), file);
    assert.ok(prompt.includes(file), file);
  }
});

test('inputs are checked before anything is created', async () => {
  const root = resultsRoot();
  await assert.rejects(runEval({ brief: 'asset-library', condition: 'no-such', adapter: fakeAdapter(), resultsRoot: root, log: quiet }), /unknown condition/);
  await assert.rejects(runEval({ brief: '../AGENTS', condition: 'plain', adapter: fakeAdapter(), resultsRoot: root, log: quiet }), /no screenshot states/);
  const live = { ...fakeAdapter(), live: true };
  await assert.rejects(runEval({ brief: 'asset-library', condition: 'plain', adapter: live, resultsRoot: root, log: quiet }), /exact model ID/);
  await assert.rejects(runEval({ brief: 'asset-library', condition: 'plain', adapter: live, model: 'm', resultsRoot: root, log: quiet }), /spending cap/);
  assert.deepEqual(readdirSync(root), []);
});

test('a command that exits is followed by whatever it left running: killed, not waited for', async () => {
  const dir = resultsRoot();
  const started = Date.now();
  // The background sleep keeps the output pipe open, as a build's leftover process could.
  const code = await runLogged('/bin/sh', ['-c', 'sleep 60 & echo $!'], { cwd: dir, logFile: join(dir, 'out.log') });
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 4_000, `resolved after ${Date.now() - started} ms`);
  const pid = Number(readFileSync(join(dir, 'out.log'), 'utf8').trim());
  assert.ok(pid > 0);
  // Killed at once; give the system a moment to reap it.
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 20 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(), false, 'the background process is gone');
});

test('a full fake run: isolated, built, tested in every project, screenshotted, recorded, cleaned up', async () => {
  const root = resultsRoot();
  const m = await runEval({ brief: 'asset-library', condition: 'plain', adapter: fakeAdapter(), resultsRoot: root, log: quiet });
  const out = join(root, m.runId);
  assert.equal(m.status, 'complete', m.error ?? 'no error');
  assert.match(m.runId, /^[0-9a-f]{12}$/);
  assert.deepEqual(failed(m), []);
  assert.ok(m.isolation.checks.some((c) => c.id === 'runner.workspace-neutral'));
  assert.equal(m.hashes.skill, null);
  assert.match(m.hashes.starter ?? '', /^[0-9a-f]{64}$/);

  // The output is the generator's files, untouched.
  assert.deepEqual(m.output?.added.sort(), ['main.ts']);
  assert.deepEqual(m.output?.changed, ['index.html']);
  assert.equal(readFileSync(join(out, 'output', 'main.ts'), 'utf8'), readFileSync(join(REPO, 'evals/tests/conformance-app/main.ts'), 'utf8'));
  assert.ok(existsSync(join(out, 'output', 'src', 'App.tsx')), 'all of src/ is kept');

  assert.equal(m.build?.ok, true);
  assert.equal(m.confinement?.sandbox, sandboxAvailable() ? 'sandbox-exec' : 'none');
  assert.equal(m.preview?.copiedIn, sandboxAvailable() ? 'sandbox-exec' : 'none', 'dist/ left the workspace only through the confined copy');
  assert.deepEqual([m.preview?.links, m.preview?.refused], [[], []]);
  assert.match(m.preview?.url ?? '', /^http:\/\/(localhost|127\.0\.0\.1):\d+$/);
  assert.equal(m.tests?.ran, true);
  assert.deepEqual(m.tests?.failures, []);
  assert.ok((m.tests?.passed ?? 0) >= 4 * 10, `${m.tests?.passed} tests passed`);
  assert.equal(m.tests?.touchTargets.length, 2, 'touch-target evidence from both mobile projects');
  assert.equal(m.screenshots?.expected.length, 24);
  assert.deepEqual(m.screenshots?.missing, []);
  for (const shot of m.screenshots?.saved ?? []) assert.ok(readFileSync(join(out, shot)).subarray(1, 4).toString() === 'PNG', shot);
  assert.equal(m.tokenLint.status, 'not-applicable');

  // Every output file is listed, and the mapping lives apart from the run folders.
  assert.ok(m.files.some((f) => f.path === 'screenshots/mobile-dark/partial-upload-failure.png'));
  assert.ok(m.files.every((f) => existsSync(join(out, f.path))));
  const mapping = readFileSync(join(root, 'mapping.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { runId: string; condition: string });
  assert.deepEqual(mapping.map((e) => [e.runId, e.condition]), [[m.runId, 'plain']]);
  assert.ok(!existsSync(m.workspace!), 'the temp workspace is deleted');
});

test('a failed build is recorded as is: no fix, no tests, workspace deleted', async () => {
  const root = resultsRoot();
  const m = await runEval({ brief: 'asset-library', condition: 'plain', adapter: fakeAdapter('broken-build'), resultsRoot: root, log: quiet });
  assert.equal(m.status, 'complete', m.error ?? 'no error');
  assert.equal(m.build?.ok, false);
  assert.match(readFileSync(join(root, m.runId, 'build.log'), 'utf8'), /error TS/);
  assert.equal(readFileSync(join(root, m.runId, 'output', 'src', 'App.tsx'), 'utf8'), 'export function App(): number {\n  return "not a number";\n}\n');
  assert.equal(m.tests, null);
  assert.equal(m.screenshots, null);
  assert.ok(!existsSync(m.workspace!));
});

test('a run that reads the canary is invalid and goes no further', async () => {
  const root = resultsRoot();
  const m = await runEval({ brief: 'asset-library', condition: 'plain', adapter: fakeAdapter('leaky'), resultsRoot: root, log: quiet });
  assert.equal(m.status, 'invalid');
  assert.deepEqual(failed(m), ['fake.canary-unread']);
  assert.equal(m.build, null);
  assert.ok(existsSync(join(root, m.runId, 'manifest.json')));
  assert.ok(!existsSync(m.workspace!));
});

test('a workspace that fails an isolation check stops the run before the adapter is called', async () => {
  const root = resultsRoot();
  // A temp folder whose path names the eval, so the workspace path check fails.
  const flagged = mkdtempSync(join(tmpdir(), 'eval-'));
  temps.push(flagged);
  const fake = fakeAdapter();
  let calls = 0;
  const spy: Adapter = {
    ...fake,
    generate: (...args) => {
      calls += 1;
      return fake.generate(...args);
    },
  };
  const m = await withEnv('TMPDIR', flagged, () => runEval({ brief: 'asset-library', condition: 'plain', adapter: spy, resultsRoot: root, log: quiet }));
  assert.equal(calls, 0, 'the adapter was never called');
  assert.equal(m.status, 'invalid');
  assert.deepEqual(failed(m), ['runner.workspace-path-neutral']);
  assert.equal(m.generation, null);
  assert.equal(m.output, null);
  assert.equal(m.build, null);
  assert.ok(existsSync(join(root, m.runId, 'manifest.json')));
  assert.ok(!existsSync(m.workspace!));
});

test('a failed generation ends the run with the adapter\'s error: partial output kept, nothing built or scored', async () => {
  const root = resultsRoot();
  const m = await runEval({ brief: 'asset-library', condition: 'plain', adapter: fakeAdapter('timeout'), resultsRoot: root, log: quiet });
  assert.equal(m.status, 'error');
  assert.equal(m.error, 'generation failed: the session timed out');
  assert.equal(m.isolation.ok, true);
  assert.equal(m.generation?.ok, false);
  assert.ok(existsSync(join(root, m.runId, 'output', 'main.ts')), 'the partial output is kept for diagnosis');
  assert.equal(m.build, null);
  assert.equal(m.tests, null);
  assert.equal(m.screenshots, null);
  assert.ok(!existsSync(m.workspace!));
});

test('the build runs confined, and the build is scored against the runner\'s own mock API, not the workspace\'s', async () => {
  const root = resultsRoot();
  const token = `test-token-${randomBytes(8).toString('hex')}`;
  const m = await withEnv('CLAUDE_CODE_OAUTH_TOKEN', token, () =>
    runEval({ brief: 'asset-library', condition: 'plain', adapter: fakeAdapter('snoop'), projects: ['desktop-light'], resultsRoot: root, log: quiet }),
  );
  assert.equal(m.status, 'complete', m.error ?? 'no error');
  // The workspace's copy of the mock API fails every request, so passing tests mean the runner's own served them.
  assert.deepEqual(m.tests?.failures, []);
  assert.ok((m.tests?.passed ?? 0) > 0);
  assert.equal(m.confinement?.sandbox, sandboxAvailable() ? 'sandbox-exec' : 'none');
  const build = readFileSync(join(root, m.runId, 'build.log'), 'utf8');
  assert.match(build, /snoop token: unset/);
  assert.ok(!build.includes(token), 'the build never sees the token');
  const env = /snoop env: (.*)/.exec(build)?.[1]?.split(',') ?? [];
  assert.ok(env.includes('HOME') && !env.some((name) => name.startsWith('CLAUDE')), env.join(', '));
  assert.ok(build.includes(`snoop home: ${join(dirname(m.workspace!), 'build', 'home')}`), 'the build runs with a fresh home');
  if (sandboxAvailable()) {
    assert.match(build, /snoop canary: EPERM/);
    assert.match(build, /snoop repo: EPERM/);
  }
  // Serving runs no generated code: the Vite config is never loaded again.
  assert.ok(!readFileSync(join(root, m.runId, 'preview.log'), 'utf8').includes('snoop'));
  assert.ok(!readFileSync(join(root, m.runId, 'manifest.json'), 'utf8').includes(token));
  assert.ok(!existsSync(join(root, m.runId, 'isolation-marker.txt')), 'the marker is gone once generation ends');
});

test('the my-skill hook: the skill lands where the adapter says, with its hash; the starter is unchanged', async () => {
  const root = resultsRoot();
  const plain = await runEval({ brief: 'asset-library', condition: 'plain', adapter: fakeAdapter('broken-build'), resultsRoot: root, log: quiet });
  const skilled = await runEval({ brief: 'asset-library', condition: 'my-skill', adapter: fakeAdapter('broken-build'), resultsRoot: root, log: quiet });
  assert.match(skilled.hashes.skill ?? '', /^[0-9a-f]{64}$/);
  assert.equal(skilled.hashes.starter, plain.hashes.starter, 'the same starter in both conditions');
  assert.equal(skilled.prompt, plain.prompt, 'the same prompt in both conditions');
  assert.equal(skilled.tokenLint.status, 'not-built-yet');
  assert.deepEqual(failed(skilled), []);
});

const bin = findClaude();
test('the real Claude Code CLI, isolated, against the local stub model (no cost)', { skip: bin ? false : 'set CLAUDE_CODE_BIN to run' }, async () => {
  const root = resultsRoot();
  const m = await runEval({
    brief: 'asset-library',
    condition: 'plain',
    adapter: claudeCodeAdapter({ stubModel: true }),
    projects: ['desktop-light'],
    resultsRoot: root,
    log: quiet,
  });
  assert.equal(m.status, 'complete', `${m.error}\n${JSON.stringify(m.isolation.checks.filter((c) => !c.ok), null, 2)}`);
  assert.deepEqual(failed(m), []);
  assert.ok(m.isolation.checks.some((c) => c.id === 'claude-code.probe-shell-agent-temp' && c.ok));
  assert.equal(m.build?.ok, true);
  assert.deepEqual(m.tests?.failures, []);
  assert.deepEqual(m.screenshots?.missing, []);
  assert.ok(!existsSync(m.workspace!));
});

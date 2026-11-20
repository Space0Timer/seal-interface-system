// The runner, end to end, with the fake adapter (no model calls): a full
// run, a run whose build fails, and a run whose isolation fails. With
// CLAUDE_CODE_BIN set, the same pipeline also runs the real Claude Code CLI
// against the local stub model, which costs nothing.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { claudeCodeAdapter, findClaude } from '../../adapters/claude-code/index.ts';
import { fakeAdapter } from '../../adapters/fake/index.ts';
import { leakIn } from '../../starter/src/leaks.ts';
import { REPO } from '../../starter/src/materialize.ts';
import { CONDITIONS } from '../src/conditions.ts';
import { walk } from '../src/files.ts';
import { renderPrompt } from '../src/prompt.ts';
import { exportReview } from '../src/review.ts';
import { runEval, type Manifest } from '../src/run.ts';

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
const sandboxTest = process.platform === 'darwin' ? test : test.skip;

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

sandboxTest('a full fake run: isolated, built, tested in every project, screenshotted, recorded, cleaned up', async () => {
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
  const review = exportReview(root, join(root, 'review-packet'), [m.runId]);
  const evidence = readFileSync(join(review.packet, 'sample-1/evidence.json'), 'utf8');
  assert.ok(!evidence.includes(m.runId) && !evidence.includes(m.condition));
  assert.equal(walk(review.packet).filter((file) => file.endsWith('.png')).length, 24);
  assert.ok(!existsSync(join(review.packet, 'manifest.json')));
  assert.match(readFileSync(review.mapping, 'utf8'), new RegExp(m.runId));
});

sandboxTest('a failed build is recorded as is: no fix, no tests, workspace deleted', async () => {
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

sandboxTest('a run that reads the canary is invalid and goes no further', async () => {
  const root = resultsRoot();
  const m = await runEval({ brief: 'asset-library', condition: 'plain', adapter: fakeAdapter('leaky'), resultsRoot: root, log: quiet });
  assert.equal(m.status, 'invalid');
  assert.deepEqual(failed(m), ['fake.canary-unread']);
  assert.equal(m.build, null);
  assert.ok(existsSync(join(root, m.runId, 'manifest.json')));
  assert.ok(!existsSync(m.workspace!));
});

sandboxTest('each skill lands in the assigned project directory with its hash and the same starter', async () => {
  const root = resultsRoot();
  const plain = await runEval({ brief: 'asset-library', condition: 'plain', adapter: fakeAdapter('broken-build'), resultsRoot: root, log: quiet });
  for (const condition of ['my-skill', 'frontend-design']) {
    const skilled = await runEval({ brief: 'asset-library', condition, adapter: fakeAdapter('broken-build'), resultsRoot: root, log: quiet });
    assert.match(skilled.hashes.skill ?? '', /^[0-9a-f]{64}$/);
    assert.equal(skilled.hashes.starter, plain.hashes.starter, 'the same starter in both conditions');
    assert.equal(skilled.prompt, plain.prompt, 'the same prompt in both conditions');
    assert.equal(skilled.tokenLint.status, condition === 'my-skill' ? 'not-run' : 'not-applicable');
    assert.deepEqual(failed(skilled), []);
  }
});

const bin = findClaude();
sandboxTest('all three conditions through the real Claude Code CLI against the local stub', { skip: bin ? false : 'set CLAUDE_CODE_BIN to run' }, async () => {
  const root = resultsRoot();
  const runs: Manifest[] = [];
  for (const condition of Object.values(CONDITIONS)) {
    const m = await runEval({
      brief: 'asset-library', condition: condition.name, adapter: claudeCodeAdapter({ stubModel: true }),
      projects: ['desktop-light'], resultsRoot: root, log: quiet,
    });
    assert.equal(m.status, 'complete', `${m.error}\n${JSON.stringify(m.isolation.checks.filter((c) => !c.ok), null, 2)}`);
    assert.deepEqual(failed(m), []);
    assert.equal(m.isolation.checks.find((c) => c.id === 'claude-code.probe-skill-content')?.ok, condition.skill ? true : undefined);
    assert.equal(m.build?.ok, true);
    assert.deepEqual(m.tests?.failures, []);
    assert.deepEqual(m.screenshots?.missing, []);
    assert.equal(m.tokenLint.status, condition.tokenLint ? 'passed' : 'not-applicable');
    assert.ok(!existsSync(m.workspace!));
    runs.push(m);
  }
  const { packet, mapping } = exportReview(root, join(root, 'blinded'), runs.map((run) => run.runId));
  const files = walk(packet);
  assert.equal(files.filter((file) => file.endsWith('.png')).length, 18);
  assert.equal(files.filter((file) => file.endsWith('evidence.json')).length, 3);
  assert.equal(files.filter((file) => /manifest|invocation|transcript|token-lint|mapping/.test(file)).length, 0);
  for (const file of files.filter((path) => path.endsWith('.json'))) {
    const content = readFileSync(join(packet, file), 'utf8');
    for (const run of runs) assert.ok(!content.includes(run.runId) && !content.includes(run.condition));
  }
  assert.match(readFileSync(mapping, 'utf8'), new RegExp(runs[0]!.runId));
});

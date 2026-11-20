import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MOCK_ADMIN_HEADER } from '../../tests/mock-admin.ts';
import { serveBuild } from '../src/serve.ts';
import { requireReport, summarizeReport } from '../src/report.ts';
import { lintTokens } from '../src/token-lint.ts';
import { exportReview } from '../src/review.ts';
import type { Manifest } from '../src/run.ts';

function scratch(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('preview uses trusted fixtures and refuses browser access to log and reset controls', async (t) => {
  const root = scratch(t);
  mkdirSync(join(root, 'api'));
  writeFileSync(join(root, 'index.html'), '<h1>Built</h1>');
  writeFileSync(join(root, 'api/assets'), 'forged assets');
  const preview = await serveBuild(root, { copied: ['index.html', 'api/assets'], links: [], refused: [] });
  t.after(preview.stop);
  const request = (path: string, init?: RequestInit) => fetch(preview.url + path, init);
  assert.equal(await (await request('/')).text(), '<h1>Built</h1>');
  const reset = await request('/__mock/reset', {
    method: 'POST', body: JSON.stringify({ scenario: 'large' }), headers: { [MOCK_ADMIN_HEADER]: preview.admin },
  });
  assert.equal(reset.status, 200);
  const cookieHeader = reset.headers.get('set-cookie')!;
  assert.match(cookieHeader, /HttpOnly/);
  const cookie = cookieHeader.split(';')[0]!;
  const assets = await (await request('/api/assets?limit=1', { headers: { cookie } })).json() as { total: number };
  assert.equal(assets.total, 10_000);
  assert.equal((await request('/__mock/reset?scenario=empty', { headers: { cookie } })).status, 403);
  assert.equal((await request('/__mock/log', { headers: { cookie } })).status, 403);
  const log = await (await request('/__mock/log', { headers: { cookie, [MOCK_ADMIN_HEADER]: preview.admin } })).json() as {
    entries: Array<{ path: string; returnedIds: string[] }>;
  };
  assert.equal(log.entries[0]?.path, '/api/assets');
  assert.equal(log.entries[0]?.returnedIds.length, 1);
});

test('missing or empty Playwright evidence is an infrastructure error', (t) => {
  const path = join(scratch(t), 'report.json');
  assert.throws(() => requireReport(summarizeReport(path), 'behavior tests', 1, ['desktop-light']), /did not write a Playwright report/);
  writeFileSync(path, JSON.stringify({ suites: [] }));
  assert.throws(() => requireReport(summarizeReport(path), 'screenshots', 0, ['desktop-light']), /missing project results/);
  writeFileSync(path, JSON.stringify({ errors: [{ message: 'browser unavailable' }] }));
  assert.throws(() => requireReport(summarizeReport(path), 'screenshots', 1, ['desktop-light']), /browser unavailable/);
});

test('token lint reports authored CSS and code violations under the trusted rules', async (t) => {
  const root = scratch(t);
  const output = join(root, 'output');
  mkdirSync(output);
  writeFileSync(join(output, '.oxlintrc.json'), '{"rules":{"ds/no-inline-style":"off"}}');
  const files = ['app.css', 'screen.tsx'];
  writeFileSync(join(output, files[0]!), '.page { color: var(--color-text-primary); }');
  writeFileSync(join(output, files[1]!), 'export const title = <h1 className="page">Assets</h1>;');
  const valid = await lintTokens(output, files, output, root, '.claude/skills/design-system');
  assert.equal(valid.status, 'passed');
  rmSync(join(output, 'token-lint.json'));
  writeFileSync(join(output, files[0]!), '/* stylelint-disable */ .page { color: #abc; }');
  writeFileSync(join(output, files[1]!), 'export const title = <h1 style={{color: "#fff"}}>Assets</h1>;');
  const invalid = await lintTokens(output, files, output, root, '.claude/skills/design-system');
  assert.equal(invalid.status, 'failed');
  const report = join(output, 'token-lint.json');
  assert.ok(existsSync(report));
  const details = readFileSync(report, 'utf8');
  assert.match(details, /ds\/token-values/);
  assert.match(details, /ds\/no-inline-style/);
  assert.match(details, /ds\/no-raw-color/);
});

test('token lint ignores disable and config comments in the scripts it checks, and keeps their lines', async (t) => {
  const root = scratch(t);
  const output = join(root, 'output');
  mkdirSync(join(output, 'src'), { recursive: true });
  const file = 'src/Screen.tsx';
  writeFileSync(
    join(output, file),
    [
      '/* eslint-disable */',
      '/* eslint ds/no-raw-color: off */',
      '// oxlint-disable-next-line ds/no-inline-style',
      'export const a = <h1 style={{ color: "#fff" }}>Assets</h1>;',
      '// eslint-disable-next-line',
      'export const b = <h2 style={{ color: "#000" }}>Uploads</h2>;',
    ].join('\n'),
  );
  const result = await lintTokens(output, [file], output, root, '.claude/skills/design-system');
  assert.equal(result.status, 'failed');
  const report = JSON.parse(readFileSync(join(output, 'token-lint.json'), 'utf8')) as {
    findings: Array<{ rule: string; line?: number }>;
    ignoredDirectives: Array<{ file: string; count: number }>;
  };
  const found = (rule: string) => report.findings.filter((f) => f.rule === rule).map((f) => f.line).sort();
  assert.deepEqual(found('ds/no-inline-style'), [4, 6]);
  assert.deepEqual(found('ds/no-raw-color'), [4, 6]);
  assert.deepEqual(report.ignoredDirectives, [{ file, count: 4 }]);
  assert.match(readFileSync(join(output, file), 'utf8'), /eslint-disable-next-line/, 'the authored file is never changed');
});

test('token lint checks CSS blocks and style attributes in authored HTML', async (t) => {
  const root = scratch(t);
  const file = 'index.html';
  const path = join(root, file);
  const lint = () => lintTokens(root, [file], root, root, '.claude/skills/design-system');
  writeFileSync(path, '<style>.page { color: var(--color-text-primary); }</style><main class="page">Assets</main>');
  assert.equal((await lint()).status, 'passed');
  writeFileSync(path, [
    '<!-- <p style="color: red">comment</p> -->',
    '<script type="text/plain"><style>.page { color: red; }</style></script>',
    '<style>/* stylelint-disable */ .page { color: #abc; }</style>',
    '<style>',
    '.title { margin: 13px; }',
    '</style>',
    "<main STYLE = 'color: &#35;fff'>Assets</main>",
    '<template><p style=color:red>example</p></template>',
  ].join('\n'));
  const result = await lint();
  assert.equal(result.status, 'failed');
  if (result.status !== 'failed') return;
  assert.deepEqual(result.checked, { stylesheets: 2, scripts: 0, html: 1 });
  const { findings } = JSON.parse(readFileSync(join(root, result.report), 'utf8')) as {
    findings: Array<{ file: string; rule: string; line: number; column: number }>;
  };
  assert.deepEqual(findings.map(({ file, rule, line }) => [file, rule, line]), [
    [file, 'ds/token-values', 3],
    [file, 'ds/token-values', 5],
    [file, 'ds/no-inline-style', 7],
    [file, 'ds/no-inline-style', 8],
  ]);
  assert.equal(findings[2]?.column, 7);
  assert.ok((findings[0]?.column ?? 0) > 7, 'same-line CSS offsets include the opening tag');
});

test('blinded export rejects mismatched and missing scoring fingerprints', (t) => {
  const root = scratch(t);
  const first = '000000000001';
  const second = '000000000002';
  const writeRun = (runId: string, scoring?: string) => {
    mkdirSync(join(root, runId), { recursive: true });
    const manifest = {
      runId, status: 'complete', isolation: { ok: true }, generation: { ok: true },
      build: { ok: false }, projects: ['desktop-light'],
      hashes: { scoring },
    } satisfies Pick<Manifest, 'runId' | 'status' | 'projects'> & Record<string, unknown>;
    writeFileSync(join(root, runId, 'manifest.json'), JSON.stringify(manifest));
  };
  const out = join(root, 'packet');
  writeRun(first, 'a'.repeat(64));
  writeRun(second, 'b'.repeat(64));
  assert.throws(() => exportReview(root, out, [first, second]), /different comparison inputs/);
  writeRun(second);
  assert.throws(() => exportReview(root, out, [first, second]), /no scoring source fingerprint/);
  assert.ok(!existsSync(out));
});

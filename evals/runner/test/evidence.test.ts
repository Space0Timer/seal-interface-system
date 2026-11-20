import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MOCK_ADMIN_HEADER } from '../../tests/mock-admin.ts';
import { buildSandbox, collectBundle } from '../src/build.ts';
import { startEvalPreview } from '../src/preview.ts';
import { requireReport, summarizeReport } from '../src/report.ts';
import { lintTokens } from '../src/token-lint.ts';

function scratch(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the build cannot read or write outside its directories or reach the network', { skip: process.platform !== 'darwin' }, async (t) => {
  const root = scratch(t);
  const workspace = join(root, 'app');
  const state = join(root, 'state');
  mkdirSync(workspace);
  const sentinel = join(root, 'outside.txt');
  writeFileSync(sentinel, 'private');
  symlinkSync(sentinel, join(workspace, 'linked.txt'));
  let requests = 0;
  const listener = createServer((_req, res) => { requests++; res.end('outside'); });
  await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
  t.after(() => { listener.close(); listener.closeAllConnections(); });
  const { port } = listener.address() as AddressInfo;
  const sandbox = buildSandbox(workspace, state);
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({
    name: 'proof', scripts: { build: 'node check.mjs' },
  }));
  writeFileSync(join(workspace, 'check.mjs'), `
    import assert from 'node:assert/strict';
    import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    assert.throws(() => readFileSync('../outside.txt'));
    assert.throws(() => readFileSync('linked.txt'));
    assert.throws(() => writeFileSync('../outside.txt', 'modified'));
    await assert.rejects(fetch('http://127.0.0.1:${port}'));
    assert.equal(process.env.HOME, ${JSON.stringify(sandbox.env.HOME)});
    mkdirSync('dist');
    writeFileSync('dist/index.html', '<h1>Built</h1>');
  `);
  execFileSync(sandbox.command, sandbox.args, { cwd: workspace, env: sandbox.env });
  assert.equal(requests, 0);
  assert.equal(readFileSync(sentinel, 'utf8'), 'private');
  const bundle = await collectBundle(workspace, sandbox);
  assert.equal(bundle.get('/index.html')?.toString(), '<h1>Built</h1>');
  symlinkSync('../linked.txt', join(workspace, 'dist', 'asset.txt'));
  await assert.rejects(collectBundle(workspace, sandbox), /unsupported build output/);
});

test('preview uses trusted fixtures and refuses browser access to log and reset controls', async (t) => {
  const preview = await startEvalPreview(new Map([
    ['/index.html', Buffer.from('<h1>Built</h1>')],
    ['/api/assets', Buffer.from('forged assets')],
  ]));
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

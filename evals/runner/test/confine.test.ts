// The confinement of the generated app's build: an allowlisted environment
// everywhere, and on macOS a sandbox that reads nothing it wasn't given and
// blocks outbound network access and from other processes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { toolchain } from '../../starter/src/toolchain.ts';
import { confine, confinedEnv, readable, sandboxAvailable, seatbeltProfile, SYSTEM_READ, type ConfineInput } from '../src/confine.ts';

const root = mkdtempSync(join(realpathSync(tmpdir()), 'confine-'));
after(() => rmSync(root, { recursive: true, force: true }));
const workspace = join(root, 'app');
// A folder nobody named, like a mounted volume or a shared folder: unreadable by default.
const unnamedDir = join(root, 'shared');
// A toolchain folder with a forbidden folder inside it.
const tools = join(root, 'tools');
const forbiddenDir = join(tools, 'checkout');
for (const dir of [workspace, unnamedDir, forbiddenDir]) mkdirSync(dir, { recursive: true });
writeFileSync(join(workspace, 'index.html'), 'the app');
writeFileSync(join(unnamedDir, 'notes.txt'), 'a host file');
writeFileSync(join(tools, 'tool.txt'), 'a tool');
writeFileSync(join(forbiddenDir, 'package.json'), '{}');
const realHome = realpathSync(homedir());
const base = toolchain();
const input: ConfineInput = { workspace, stateDir: join(root, 'build'), forbidden: [forbiddenDir, forbiddenDir], toolchain: { ...base, roots: [...base.roots, tools] } };

test('the environment is an allowlist: a fresh home and temp folder, the toolchain, nothing inherited', () => {
  const saved = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-secret';
  try {
    const env = confinedEnv(input);
    const allowed = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'COREPACK_HOME', 'COREPACK_ENABLE_NETWORK', 'COREPACK_ENABLE_DOWNLOAD_PROMPT', 'pnpm_config_verify_deps_before_run'];
    assert.deepEqual(Object.keys(env).filter((k) => !allowed.includes(k)), []);
    assert.equal(env['HOME'], join(input.stateDir, 'home'));
    assert.equal(env['TMPDIR'], join(input.stateDir, 'tmp'));
    assert.ok(env['PATH']?.startsWith(input.toolchain.binDirs[0]!));
    assert.ok(!Object.values(env).some((v) => v.includes('test-secret')));
  } finally {
    if (saved === undefined) delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    else process.env['CLAUDE_CODE_OAUTH_TOKEN'] = saved;
  }
});

test('the profile reads nothing by default, then only the runtime, the toolchain, the workspace and its state, never a forbidden path', () => {
  const profile = seatbeltProfile(input);
  const lines = profile.split('\n');
  const index = (start: string) => lines.findIndex((l) => l.startsWith(start));
  assert.ok(lines.includes('(deny file-read*)'), 'reads are denied by default');
  const allowed = lines[index('(allow file-read* (literal')] ?? '';
  for (const dir of [...SYSTEM_READ, workspace, input.stateDir, ...input.toolchain.roots]) assert.ok(allowed.includes(`(subpath ${JSON.stringify(dir)})`), dir);
  assert.ok(!allowed.includes(`(subpath ${JSON.stringify(realHome)})`) && !allowed.includes(`(subpath ${JSON.stringify(root)})`), 'no home or temp folder as a whole');
  assert.deepEqual(readable(input), [...new Set(readable(input))]);
  const forbidden = index(`(deny file-read* (subpath ${JSON.stringify(forbiddenDir)}))`);
  assert.ok(forbidden > index('(allow file-read* (literal'), 'the forbidden deny comes after the allows, so it wins');
  assert.equal(lines[forbidden + 1], `(allow file-read* (subpath ${JSON.stringify(workspace)}) (subpath ${JSON.stringify(input.stateDir)}))`);
  const writable = lines[index('(allow file-write*')] ?? '';
  assert.ok(writable.includes(JSON.stringify(workspace)) && writable.includes(JSON.stringify(input.stateDir)));
  assert.ok(!input.toolchain.roots.some((dir) => writable.includes(JSON.stringify(dir))), 'the toolchain is read-only');
});

test('without a sandbox, only the environment is confined, and the record says so', () => {
  const c = confine(input, { sandbox: false });
  assert.deepEqual(c.wrap('pnpm', ['build']), ['pnpm', ['build']]);
  assert.equal(c.record.sandbox, 'none');
  assert.equal(c.record.profile, undefined);
  assert.ok(existsSync(join(input.stateDir, 'home')) && existsSync(join(input.stateDir, 'tmp')));
});

const probe = `
const fs = require('node:fs'), net = require('node:net'), http = require('node:http'), os = require('node:os');
const out = {};
const attempt = (what, fn) => { try { out[what] = fn(); } catch (error) { out[what] = error.code; } };
attempt('readUnnamed', () => fs.readFileSync(${JSON.stringify(join(unnamedDir, 'notes.txt'))}, 'utf8'));
attempt('listUnnamed', () => fs.readdirSync(${JSON.stringify(unnamedDir)}).join(','));
attempt('listShared', () => fs.readdirSync('/Users/Shared').length);
attempt('listHome', () => fs.readdirSync(${JSON.stringify(realHome)}).length);
attempt('readTool', () => fs.readFileSync(${JSON.stringify(join(tools, 'tool.txt'))}, 'utf8'));
attempt('readForbidden', () => fs.readFileSync(${JSON.stringify(join(forbiddenDir, 'package.json'))}, 'utf8'));
attempt('readHosts', () => typeof fs.readFileSync('/etc/hosts', 'utf8'));
attempt('readWorkspace', () => fs.readFileSync('index.html', 'utf8'));
attempt('writeOutside', () => (fs.writeFileSync(${JSON.stringify(join(root, 'outside.txt'))}, 'x'), 'written'));
attempt('writeWorkspace', () => (fs.writeFileSync('built.txt', 'x'), 'written'));
out.token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? 'unset';
out.home = os.homedir();
const remote = new Promise((done) => {
  const socket = net.connect(80, '192.0.2.1');
  socket.on('connect', () => { socket.destroy(); done('connected'); });
  socket.on('error', (error) => done(error.code));
  setTimeout(() => { socket.destroy(); done('timeout'); }, 3000);
});
const socket = new Promise((done) => {
  const agent = net.connect(${JSON.stringify(join(workspace, 'agent.sock'))});
  agent.on('connect', () => { agent.destroy(); done('connected'); });
  agent.on('error', (error) => done(error.code));
});
const local = new Promise((done) => {
  const server = http.createServer((req, res) => res.end('served')).listen(0, 'localhost', () => {
    http.get('http://localhost:' + server.address().port, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => { server.close(); done(body); });
    }).on('error', (error) => { server.close(); done(error.code); });
  });
});
Promise.all([remote, socket, local]).then(([remote, socket, local]) => {
  console.log(JSON.stringify({ ...out, remote, socket, local }));
  process.exit(0);
});
`;

test('sandboxed: nothing unnamed or forbidden is readable, no writes outside, no outbound network access, no other process', { skip: sandboxAvailable() ? false : 'needs macOS sandbox-exec' }, async () => {
  // A Unix socket like an SSH agent's, listening outside the sandbox. Connecting needs no accept, so a blocked test process can host it.
  const agent = createServer();
  await new Promise<void>((resolve) => agent.listen(join(workspace, 'agent.sock'), resolve));
  after(() => agent.close());
  const c = confine(input);
  assert.equal(c.record.sandbox, 'sandbox-exec');
  const run = (command: string, args: string[]) => {
    const [cmd, argv] = c.wrap(command, args);
    return spawnSync(cmd, argv, { cwd: workspace, env: c.env, encoding: 'utf8', timeout: 20_000 });
  };
  const result = run(process.execPath, ['-e', probe]);
  assert.equal(result.status, 0, result.stderr);
  const seen = JSON.parse(result.stdout) as Record<string, string | number>;
  assert.deepEqual(
    { ...seen, home: undefined },
    {
      readUnnamed: 'EPERM',
      listUnnamed: 'EPERM',
      listShared: 'EPERM',
      listHome: 'EPERM',
      readTool: 'a tool',
      readForbidden: 'EPERM',
      readHosts: 'string',
      readWorkspace: 'the app',
      writeOutside: 'EPERM',
      writeWorkspace: 'written',
      token: 'unset',
      home: undefined,
      remote: 'EPERM',
      socket: 'EPERM',
      local: 'EPERM',
    },
  );
  assert.equal(seen['home'], join(input.stateDir, 'home'));
  assert.ok(!existsSync(join(root, 'outside.txt')));

  // The runner deletes the workspace's dist/ this way before the build. Through a link to a host folder, as if a
  // process left running had replaced the workspace folder with one, it deletes nothing there.
  mkdirSync(join(unnamedDir, 'dist'));
  writeFileSync(join(unnamedDir, 'dist', 'index.html'), 'a host file');
  symlinkSync(unnamedDir, join(workspace, 'replaced'));
  const cleared = run('rm', ['-rf', join(workspace, 'replaced', 'dist')]);
  assert.notEqual(cleared.status, 0);
  assert.match(cleared.stderr, /Operation not permitted/);
  assert.ok(existsSync(join(unnamedDir, 'dist', 'index.html')));

  // Another process's arguments and environment (here, this test's) stay out of reach.
  const ps = run('/bin/ps', ['-E', '-o', 'command=', '-p', String(process.pid)]);
  assert.notEqual(ps.status, 0);
  assert.equal(ps.stdout, '');
});

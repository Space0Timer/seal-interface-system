// The confinement of the generated app's build and preview server: an
// allowlisted environment everywhere, and on macOS a sandbox that keeps it
// from the host's files, the network beyond localhost and other processes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { toolchain } from '../../starter/src/toolchain.ts';
import { confine, confinedEnv, sandboxAvailable, seatbeltProfile, type ConfineInput } from '../src/confine.ts';

const root = mkdtempSync(join(realpathSync(tmpdir()), 'confine-'));
after(() => rmSync(root, { recursive: true, force: true }));
const workspace = join(root, 'app');
const hiddenDir = join(root, 'shared');
mkdirSync(workspace);
mkdirSync(hiddenDir);
writeFileSync(join(workspace, 'index.html'), 'the app');
writeFileSync(join(hiddenDir, 'notes.txt'), 'a host file');
const realHome = realpathSync(homedir());
const input: ConfineInput = { workspace, stateDir: join(root, 'build'), hidden: [realHome, root, root], toolchain: toolchain() };

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

test('the profile hides every hidden folder once and opens only the workspace, its state and the toolchain', () => {
  const profile = seatbeltProfile(input);
  const line = (start: string) => profile.split('\n').find((l) => l.startsWith(start)) ?? '';
  const denied = line('(deny file-read*');
  for (const dir of [realHome, root]) assert.ok(denied.includes(`(subpath ${JSON.stringify(dir)})`), dir);
  assert.equal(denied.split(JSON.stringify(root)).length, 2, 'each hidden folder once');
  const readable = line('(allow file-read*');
  for (const dir of [workspace, input.stateDir, ...input.toolchain.roots]) assert.ok(readable.includes(JSON.stringify(dir)), dir);
  const writable = line('(allow file-write*');
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
attempt('readHidden', () => fs.readFileSync(${JSON.stringify(join(hiddenDir, 'notes.txt'))}, 'utf8'));
attempt('listHidden', () => fs.readdirSync(${JSON.stringify(hiddenDir)}).join(','));
attempt('listHome', () => fs.readdirSync(${JSON.stringify(realHome)}).length);
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

test('sandboxed: no host files, no writes outside, no network beyond localhost, no other process', { skip: sandboxAvailable() ? false : 'needs macOS sandbox-exec' }, async () => {
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
      readHidden: 'EPERM',
      listHidden: 'EPERM',
      listHome: 'EPERM',
      readWorkspace: 'the app',
      writeOutside: 'EPERM',
      writeWorkspace: 'written',
      token: 'unset',
      home: undefined,
      remote: 'EPERM',
      socket: 'EPERM',
      local: 'served',
    },
  );
  assert.equal(seen['home'], join(input.stateDir, 'home'));
  assert.ok(!existsSync(join(root, 'outside.txt')));

  // Another process's arguments and environment (here, this test's) stay out of reach.
  const ps = run('/bin/ps', ['-E', '-o', 'command=', '-p', String(process.pid)]);
  assert.notEqual(ps.status, 0);
  assert.equal(ps.stdout, '');
});

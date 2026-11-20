// The runner's own server for a build: a confined copy of dist/ with links
// left out, nothing outside it, a single-page-app fallback, and the
// canonical mock API.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { toolchain } from '../../starter/src/toolchain.ts';
import { confineCopy, sandboxAvailable } from '../src/confine.ts';
import { copyBuild, serveBuild } from '../src/serve.ts';

const root = mkdtempSync(join(realpathSync(tmpdir()), 'serve-'));
after(() => rmSync(root, { recursive: true, force: true }));
const { nodeRoot } = toolchain();
/** Copies from into to the way the runner does: confined to those two folders where the OS allows it. */
const copy = (from: string, to: string, options?: { sandbox?: boolean }) => copyBuild(from, to, confineCopy({ from, to, nodeRoot, forbidden: [] }, options));

test('a build is copied without its links, served from the copy, and backed by the canonical mock API', async () => {
  const dist = join(root, 'app', 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(root, 'host-secret.txt'), 'a host file');
  symlinkSync(join(root, 'host-secret.txt'), join(dist, 'secret.txt'));
  symlinkSync(root, join(dist, 'host'));

  const built = copy(dist, join(root, 'served'));
  assert.equal(built.missing, undefined);
  assert.deepEqual(built.copied, ['assets/app.js', 'index.html']);
  assert.deepEqual(built.links, [
    { path: 'host', target: root },
    { path: 'secret.txt', target: join(root, 'host-secret.txt') },
  ]);
  assert.deepEqual(built.refused, []);

  // Whatever happens to dist/ afterwards, the copy is what's served.
  writeFileSync(join(dist, 'assets', 'app.js'), 'changed later');
  const server = await serveBuild(join(root, 'served'), built);
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const get = async (path: string, init?: RequestInit) => {
      const res = await fetch(`${server.url}${path}`, init);
      return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() };
    };
    assert.deepEqual(await get('/'), { status: 200, type: 'text/html; charset=utf-8', body: '<!doctype html><title>app</title>' });
    assert.deepEqual(await get('/assets/app.js'), { status: 200, type: 'text/javascript; charset=utf-8', body: 'console.log(1)' });
    assert.equal((await get('/library/item-7')).body, '<!doctype html><title>app</title>', 'a route without an extension gets the app');
    assert.equal((await get('/missing.js')).status, 404);
    assert.equal((await get('/secret.txt')).status, 404, 'a link is never followed');
    assert.equal((await get('/host/host-secret.txt')).status, 404);
    assert.equal((await get('/%2e%2e/host-secret.txt')).status, 404, 'no path leaves the copy');
    assert.equal((await get('/..%2f..%2fhost-secret.txt')).status, 404);
    assert.equal((await get('/index.html', { method: 'POST' })).status, 405);
    const assets = JSON.parse((await get('/api/assets?limit=1')).body) as { total: number; items: unknown[] };
    assert.equal(assets.items.length, 1);
    assert.ok(assets.total > 1);
    assert.match(server.output(), /not served: host is a link/);
    assert.equal(server.gone(), false);
  } finally {
    server.stop();
  }
});

test('a build with no dist/index.html, or a dist/ that is a link, has nothing to serve', () => {
  const empty = join(root, 'empty', 'dist');
  mkdirSync(empty, { recursive: true });
  writeFileSync(join(empty, 'main.js'), '');
  assert.equal(copy(empty, join(root, 'served-empty')).missing, 'the build wrote no dist/index.html');
  assert.equal(copy(join(root, 'nowhere', 'dist'), join(root, 'served-none')).missing, 'the build wrote no dist/ folder');
  const linked = join(root, 'linked');
  mkdirSync(linked);
  symlinkSync(join(root, 'app', 'dist'), join(linked, 'dist'));
  assert.equal(copy(join(linked, 'dist'), join(root, 'served-linked')).missing, 'the build wrote no dist/ folder');
});

test('the copy reads nothing outside dist/, even when a folder in its path turns into a link to the host', { skip: sandboxAvailable() ? false : 'needs macOS sandbox-exec' }, () => {
  // What a build process left running could do between two steps of the copy: swap a folder for a link to a host
  // folder. Here dist/ is reached through such a link from the start; the copy is confined to the path it was given.
  const host = join(root, 'host-folder');
  mkdirSync(join(host, 'dist'), { recursive: true });
  writeFileSync(join(host, 'dist', 'index.html'), 'host secret');
  const swapped = join(root, 'swapped');
  symlinkSync(host, swapped);

  const confined = copy(join(swapped, 'dist'), join(root, 'served-swapped'));
  assert.equal(confined.missing, 'the build wrote no dist/index.html');
  assert.deepEqual(confined.copied, []);
  assert.deepEqual(confined.refused, [{ path: '.', reason: 'EPERM' }]);
  assert.deepEqual(readdirSync(join(root, 'served-swapped')), []);

  // The sandbox is what stops it: unconfined, the same copy takes the host file.
  const unconfined = copy(join(swapped, 'dist'), join(root, 'served-unconfined'), { sandbox: false });
  assert.deepEqual(unconfined.copied, ['index.html']);
  assert.equal(readFileSync(join(root, 'served-unconfined', 'index.html'), 'utf8'), 'host secret');
});

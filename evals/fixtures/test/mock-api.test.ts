import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { DEFAULT_ASSETS, NO_RESULTS_QUERY, OVERSIZED_FILENAME, TRANSIENT_FAILURE_FILENAME, UPLOAD_LIMIT_BYTES } from '../src/data.ts';
import { createMockApi, type LogEntry } from '../src/mock-api.ts';

let server: Server;
let base: string;

before(async () => {
  server = createServer(createMockApi());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** A client with its own mock session. */
async function client(scenario: string) {
  const res = await fetch(`${base}/__mock/reset`, { method: 'POST', body: JSON.stringify({ scenario }) });
  assert.equal(res.status, 200);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { ...init.headers, cookie } });
  return {
    call,
    json: async (path: string, init?: RequestInit) => {
      const r = await call(path, init);
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    },
    upload: (filename: string, bytes: number) =>
      call(`/api/uploads?filename=${encodeURIComponent(filename)}`, { method: 'POST', body: new Uint8Array(bytes) }),
    log: async () => ((await (await call('/__mock/log')).json()) as { entries: LogEntry[] }).entries,
  };
}

test('scenarios serve the expected totals, newest first, with a capped page size', async () => {
  const d = await client('default');
  const def = await d.json('/api/assets');
  assert.equal(def.body['total'], DEFAULT_ASSETS.length);
  assert.equal((def.body['items'] as unknown[]).length, DEFAULT_ASSETS.length);

  const e = await client('empty');
  assert.equal((await e.json('/api/assets')).body['total'], 0);

  const l = await client('large');
  const large = await l.json('/api/assets?limit=5000&offset=100');
  assert.equal(large.body['total'], 10_000);
  assert.equal(large.body['limit'], 200);
  assert.equal((large.body['items'] as unknown[]).length, 200);
});

test('search matches filenames case-insensitively and the no-results query matches nothing', async () => {
  const c = await client('large');
  assert.equal((await c.json(`/api/assets?q=${NO_RESULTS_QUERY}`)).body['total'], 0);
  assert.equal((await c.json('/api/assets?q=INVOICE')).body['total'], 2);
});

test('the transient file fails once with connection_interrupted, then uploads', async () => {
  const c = await client('default');
  const first = await c.upload(TRANSIENT_FAILURE_FILENAME, 1000);
  assert.equal(first.status, 503);
  assert.deepEqual(await first.json(), { error: { code: 'connection_interrupted' } });
  const second = await c.upload(TRANSIENT_FAILURE_FILENAME, 1000);
  assert.equal(second.status, 201);
  const list = await c.json(`/api/assets?q=${TRANSIENT_FAILURE_FILENAME}`);
  assert.equal(list.body['total'], 1);
});

test('files over 100 MB fail validation every time and are never stored', async () => {
  const c = await client('default');
  for (let i = 0; i < 2; i++) {
    const res = await c.upload(OVERSIZED_FILENAME, UPLOAD_LIMIT_BYTES + 1);
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: { code: 'file_too_large', limitBytes: UPLOAD_LIMIT_BYTES } });
  }
  assert.equal((await c.json(`/api/assets?q=${OVERSIZED_FILENAME}`)).body['total'], 0);
});

test('uploads appear first; delete removes assets; the log records both', async () => {
  const c = await client('default');
  const created = (await (await c.upload('new-file.png', 2048)).json()) as { id: string; thumbnailUrl: string | null };
  assert.ok(created.thumbnailUrl);
  const first = ((await c.json('/api/assets?limit=1')).body['items'] as Array<{ id: string }>)[0];
  assert.equal(first?.id, created.id);

  const ids = [created.id, DEFAULT_ASSETS[0]!.id, 'does-not-exist'];
  const del = await c.json('/api/assets/delete', { method: 'POST', body: JSON.stringify({ ids }) });
  assert.equal(del.body['deleted'], 2);
  assert.equal((await c.json('/api/assets')).body['total'], DEFAULT_ASSETS.length - 1);

  const log = await c.log();
  const upload = log.find((e) => e.path === '/api/uploads');
  assert.equal(upload?.filename, 'new-file.png');
  assert.equal(upload?.sizeBytes, 2048);
  assert.equal(upload?.status, 201);
  assert.deepEqual(log.find((e) => e.path === '/api/assets/delete')?.ids, ids);
});

test('sessions are isolated from each other', async () => {
  const a = await client('default');
  const b = await client('default');
  await a.upload(TRANSIENT_FAILURE_FILENAME, 10);
  assert.equal((await b.upload(TRANSIENT_FAILURE_FILENAME, 10)).status, 503);
  assert.equal((await a.log()).length, 1);
});

test('GET reset sets the session cookie and redirects for previewing states in a browser', async () => {
  const res = await fetch(`${base}/__mock/reset?scenario=empty&to=/library`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/library');
  assert.match(res.headers.get('set-cookie') ?? '', /^mock-session=[\w-]+; Path=\//);
  assert.equal((await fetch(`${base}/__mock/reset?scenario=nope`)).status, 400);
});

test('thumbnails are deterministic SVG', async () => {
  const one = await (await fetch(`${base}/api/thumbnails/a-002.svg`)).text();
  const two = await (await fetch(`${base}/api/thumbnails/a-002.svg`)).text();
  assert.equal(one, two);
  assert.match(one, /^<svg /);
});

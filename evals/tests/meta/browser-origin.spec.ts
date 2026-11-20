// The browser flags used in runner runs hold the page to the app's own
// origin. The other origins here are the same server under another host
// name, and another local server, so a request that got through would be
// answered.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Browser } from '@playwright/test';
import { holdToOrigin } from '../browser.ts';

let other: Server;
test.beforeAll(async () => {
  other = createServer((_req, res) => res.end('another local server'));
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
});
test.afterAll(() => new Promise<void>((resolve) => other.close(() => resolve())));

/** From a page and from the test code: each origin's status, 0 for an opaque cross-origin answer, or "blocked". */
async function reachFrom(browser: Browser, baseURL: string) {
  const origin = new URL(baseURL).origin;
  const targets = [`${origin}/`, `${origin.replace('127.0.0.1', 'localhost')}/`, `http://127.0.0.1:${(other.address() as AddressInfo).port}/`];
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await page.goto('/');
    const fromPage = await page.evaluate(
      (urls) => Promise.all(urls.map((url) => fetch(url, { mode: 'no-cors' }).then((res) => res.status, () => 'blocked' as const))),
      targets,
    );
    const fromTests = await Promise.all(targets.map((url) => page.request.get(url).then((res) => res.status(), () => 'blocked' as const)));
    return { fromPage, fromTests };
  } finally {
    await context.close();
  }
}

/**
 * Servers that try to listen at the flags' proxy port on all interfaces and
 * would answer as the proxy. On macOS they can listen there; connections to
 * 127.0.0.1 must still reach only the holder. Flags without a proxy leave
 * nothing to squat.
 */
async function squat(args: string[]) {
  const proxy = args.find((arg) => arg.startsWith('--proxy-server='))?.slice('--proxy-server='.length);
  const seen: string[] = [];
  const servers = await Promise.all(
    (proxy ? ['0.0.0.0', '::'] : []).map(
      (host) =>
        new Promise<Server | undefined>((resolve) => {
          const server = createServer((req, res) => {
            seen.push(`${req.method} ${req.url}`);
            res.end('from the squatter');
          });
          server.on('connect', (req, socket) => {
            seen.push(`CONNECT ${req.url}`);
            socket.end('HTTP/1.1 200 OK\r\n\r\n');
          });
          server.once('error', () => resolve(undefined));
          server.listen(Number(new URL(proxy!).port), host, () => resolve(server));
        }),
    ),
  );
  const close = () => Promise.all(servers.map((server) => server && new Promise((resolve) => server.close(resolve))));
  return { seen, close };
}

test('without the flags, the other origins answer', async ({ browser, baseURL }) => {
  expect((await reachFrom(browser, baseURL!)).fromPage).toEqual([200, 0, 0]);
});

test('with them, the page reaches only its origin, not even another local port; the test code is unaffected', async ({ playwright, baseURL }) => {
  expect(baseURL).toContain('127.0.0.1');
  const hold = await holdToOrigin(new URL(baseURL!).origin);
  const squatter = await squat(hold.args);
  const browser = await playwright.chromium.launch({ args: hold.args });
  try {
    const reached = await reachFrom(browser, baseURL!);
    expect({ ...reached, squatter: squatter.seen }).toEqual({ fromPage: [200, 'blocked', 'blocked'], fromTests: [200, 200, 200], squatter: [] });
  } finally {
    await browser.close();
    await squatter.close();
    await hold.release();
  }
});

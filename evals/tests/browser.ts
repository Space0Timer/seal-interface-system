import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { test as base } from '@playwright/test';

/**
 * Chromium flags that let pages reach one origin only, and the proxy they
 * need. Requests to the origin's host and port go direct. Every other
 * request, WebSockets and other local ports included, goes to a proxy that
 * this process listens on and that closes every connection, so it fails.
 * The browser enforces this itself, so the app's own traffic, including
 * uploads of more than 100 MB, is never paused for Playwright to inspect.
 * These are browser flags, not Playwright's proxy option, so the test
 * code's own requests (mock reset and log) still go direct.
 *
 * The proxy's port is held, not merely unused: on macOS any process can
 * listen on a low port such as 9 on all interfaces, and would then receive
 * every request as the proxy. Connections to 127.0.0.1 at a port held
 * there reach only the holder.
 */
export async function holdToOrigin(origin: string): Promise<{ args: string[]; release: () => Promise<void> }> {
  const proxy = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => proxy.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = proxy.address() as AddressInfo;
  return {
    // <-loopback> sends localhost and 127.0.0.1 through the proxy too. It must come first: placed after the allowed
    // host and port, it cancels that entry as well.
    args: [`--proxy-server=http://127.0.0.1:${port}`, `--proxy-bypass-list=<-loopback>;${new URL(origin).host}`],
    release: () => new Promise<void>((resolve) => proxy.close(() => resolve())),
  };
}

/** In runner runs (with the mock admin token), the browser may reach only the app's origin. */
export const test = base.extend({
  launchOptions: [
    async ({ launchOptions }, use) => {
      const app = process.env['EVAL_BASE_URL'];
      if (!process.env['EVAL_MOCK_ADMIN_TOKEN'] || !app) return use(launchOptions);
      const hold = await holdToOrigin(app);
      try {
        await use({ ...launchOptions, args: [...(launchOptions.args ?? []), ...hold.args] });
      } finally {
        await hold.release();
      }
    },
    { scope: 'worker' },
  ],
});

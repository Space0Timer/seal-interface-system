import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname } from 'node:path';
import { createMockApi } from '../../fixtures/src/mock-api.ts';
import { MOCK_ADMIN_HEADER } from '../../tests/mock-admin.ts';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** Serve inert bundle files and the runner's own mock API on one local origin. */
export async function startEvalPreview(bundle: ReadonlyMap<string, Buffer>) {
  if (!bundle.has('/index.html')) throw new Error('build output is missing dist/index.html');
  const mock = createMockApi();
  const admin = randomBytes(32).toString('hex');
  const server = createServer((req, res) => {
    let path: string;
    try {
      path = new URL(req.url ?? '/', 'http://preview.local').pathname;
      if (path.startsWith('/__mock/') && req.headers[MOCK_ADMIN_HEADER] !== admin) {
        res.writeHead(403).end();
        return;
      }
    } catch {
      res.writeHead(400).end();
      return;
    }
    mock(req, res, () => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      try {
        path = decodeURIComponent(path);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const fallback = !extname(path) && req.headers.accept?.includes('text/html');
      if (path.endsWith('/')) path += 'index.html';
      const asset = bundle.get(path);
      const file = asset ?? (fallback ? bundle.get('/index.html') : undefined);
      if (!file) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[asset ? extname(path) : '.html'] ?? 'application/octet-stream',
        'Content-Length': file.length,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "connect-src 'self'; form-action 'self'; base-uri 'self'",
      }).end(req.method === 'HEAD' ? undefined : file);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    admin,
    stop() {
      server.close();
      server.closeAllConnections();
    },
  };
}

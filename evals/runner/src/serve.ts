// Serves a generated app's build for scoring, in this process: a copy of its
// dist/ as static files, and the runner's own mock API from
// evals/fixtures/src. The generator could have edited its workspace's Vite
// config and its copy of the mock API, so its own preview server could
// score it against different upload failures or a different request log.
// Here every condition is judged against the same API, and no generated
// code runs outside the browser.
//
// dist/ is copied into a runner-owned folder first, regular files only: a
// link is recorded and never followed, so a build can't point the server at
// a host file, and nothing left running from the build can change what's
// served.
import { createReadStream, existsSync, lstatSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { createMockApi } from '../../fixtures/src/mock-api.ts';
import type { Preview } from '../../starter/src/preview.ts';
import { copyFiles, walk, type CopyResult } from './files.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
};

/** Copies dist into root, regular files only. Returns why not when there's no app to serve. */
export function copyBuild(dist: string, root: string): CopyResult | { missing: string } {
  if (!existsSync(dist) || !lstatSync(dist).isDirectory()) return { missing: 'the build wrote no dist/ folder' };
  const copy = copyFiles(dist, root, walk(dist));
  if (!copy.copied.includes('index.html')) return { missing: 'the build wrote no dist/index.html' };
  return copy;
}

/** The file a request path maps to inside root, or undefined. Never leaves root. */
function fileFor(root: string, pathname: string): string | undefined {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (rel.includes('\0')) return undefined;
  const path = join(root, normalize(`/${rel}`));
  if (path !== root && !path.startsWith(`${root}${sep}`)) return undefined;
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (stat.isDirectory()) return fileFor(root, `${rel.replace(/\/$/, '')}/index.html`);
  return stat.isFile() ? path : undefined;
}

/**
 * Serves a copied build with the canonical mock API on a free localhost
 * port. Paths without an extension that match no file get index.html, as
 * Vite's preview does for a single-page app.
 */
export async function serveBuild(root: string, copy: CopyResult): Promise<Preview> {
  let output = copy.links.map((l) => `not served: ${l.path} is a link to ${l.target}\n`).join('');
  const api = createMockApi();
  const server: Server = createServer((req, res) => {
    api(req, res, () => {
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('method not allowed');
        return;
      }
      const { pathname } = new URL(req.url ?? '/', 'http://localhost');
      const file = fileFor(root, pathname) ?? (extname(pathname) ? undefined : fileFor(root, '/index.html'));
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      if (method === 'HEAD') res.end();
      else createReadStream(file).pipe(res);
    });
  });
  server.on('clientError', (error, socket) => socket.destroy(error));
  let closed = false;
  server.on('close', () => (closed = true));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  server.on('error', (error) => (output += `server error: ${error.message}\n`));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    gone: () => closed,
    output: () => output,
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

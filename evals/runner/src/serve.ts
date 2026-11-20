// Serves a generated app's build for scoring, in this process: a copy of its
// dist/ as static files, and the runner's own mock API from
// evals/fixtures/src. The generator could have edited its workspace's Vite
// config and its copy of the mock API, so its own preview server could
// score it against different upload failures or a different request log.
// Here every condition is judged against the same API, and no generated
// code runs outside the browser.
//
// dist/ is first copied into a runner-owned folder, by a separate helper
// process confined like the build (see confineCopy): it can read only
// dist/, the Node install and the OS runtime, and write only that folder.
// The runner never reads the workspace with its own permissions, so a build
// process left running that swaps a file or folder in dist/ for a link
// between two steps of the copy gets nothing from the host. The helper also
// opens each file without following links and checks the type of what it
// opened. Links are recorded, never copied or followed, and the server then
// reads only the runner-owned copy.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { createMockApi } from '../../fixtures/src/mock-api.ts';
import { MOCK_ADMIN_HEADER } from '../../tests/mock-admin.ts';
import type { Launch } from './confine.ts';

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
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export interface BuildCopy {
  copied: string[];
  /** Links in dist/, recorded and never followed. */
  links: Array<{ path: string; target: string }>;
  /** Entries the copy couldn't or wouldn't take, and why (a sandbox refusal shows as EPERM). */
  refused: Array<{ path: string; reason: string }>;
  /** Set when there's no app to serve, and why. */
  missing?: string | undefined;
}

/** The copy helper, run as `node -e HELPER <from> <to>`. Self-contained, so it reads nothing of the repo. */
export const COPY_HELPER = `
const fs = require('node:fs');
const path = require('node:path');
const [from, to] = process.argv.slice(1);
const out = { copied: [], links: [], refused: [] };
const reason = (error) => (error && error.code) || String(error);
const copyFile = (rel) => {
  let fd;
  try {
    // Never through a link at the last step, and the type checked on what was opened, so nothing can swap in between.
    fd = fs.openSync(path.join(from, rel), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) return out.refused.push({ path: rel, reason: 'not a regular file' });
    const data = fs.readFileSync(fd);
    const target = path.join(to, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { flag: 'wx' });
    out.copied.push(rel);
  } catch (error) {
    out.refused.push({ path: rel, reason: reason(error) });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
};
const visit = (rel, depth) => {
  if (depth > 32) return out.refused.push({ path: rel, reason: 'nested too deep' });
  let entries;
  try {
    entries = fs.readdirSync(path.join(from, rel), { withFileTypes: true });
  } catch (error) {
    return out.refused.push({ path: rel || '.', reason: reason(error) });
  }
  for (const entry of entries) {
    if (out.copied.length + out.links.length + out.refused.length >= 20000) return out.refused.push({ path: rel || '.', reason: 'too many files' });
    const child = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) {
      let target = '';
      try {
        target = fs.readlinkSync(path.join(from, child));
      } catch {}
      out.links.push({ path: child, target });
    } else if (entry.isDirectory()) visit(child, depth + 1);
    else if (entry.isFile()) copyFile(child);
    else out.refused.push({ path: child, reason: 'not a regular file' });
  }
};
const copyAll = () => {
  let top;
  try {
    top = fs.lstatSync(from);
  } catch {}
  if (!top || !top.isDirectory()) return 'the build wrote no dist/ folder';
  visit('', 0);
  return out.copied.includes('index.html') ? undefined : 'the build wrote no dist/index.html';
};
const missing = copyAll();
out.copied.sort();
out.links.sort((a, b) => (a.path < b.path ? -1 : 1));
out.refused.sort((a, b) => (a.path < b.path ? -1 : 1));
// No process.exit: a report larger than the pipe's buffer is still being written. Node exits once it's flushed.
process.stdout.write(JSON.stringify(missing ? { missing, ...out } : out));
`;

/** Copies dist into root, which must not exist yet, with the confined helper. */
export function copyBuild(dist: string, root: string, launch: Launch): BuildCopy {
  mkdirSync(root);
  const [command, args] = launch.wrap(process.execPath, ['-e', COPY_HELPER, dist, root]);
  const result = spawnSync(command, args, { env: launch.env, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`copying the build failed (exit ${result.status ?? result.signal}): ${result.stderr || result.error?.message || ''}`);
  return JSON.parse(result.stdout) as BuildCopy;
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
export async function serveBuild(root: string, copy: BuildCopy) {
  let output = [
    ...copy.links.map((l) => `not served: ${l.path} is a link to ${l.target}\n`),
    ...copy.refused.map((r) => `not served: ${r.path} (${r.reason})\n`),
  ].join('');
  const api = createMockApi();
  const admin = randomBytes(32).toString('hex');
  const server: Server = createServer((req, res) => {
    let pathname: string;
    try {
      ({ pathname } = new URL(req.url ?? '/', 'http://localhost'));
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (pathname.startsWith('/__mock/') && req.headers[MOCK_ADMIN_HEADER] !== admin) {
      res.writeHead(403).end();
      return;
    }
    api(req, res, () => {
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('method not allowed');
        return;
      }
      const file = fileFor(root, pathname) ?? (extname(pathname) ? undefined : fileFor(root, '/index.html'));
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "connect-src 'self'; form-action 'self'; base-uri 'self'",
      });
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
    admin,
    gone: () => closed,
    output: () => output,
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

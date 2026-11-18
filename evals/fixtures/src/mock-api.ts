// Mock asset API shared by every eval condition and the behavior tests.
// A plain Node (req, res, next) handler, so it runs as Vite dev/preview
// middleware or in any Node server.
//
// State is per session (cookie "mock-session"), so parallel test runs don't
// interfere. Requests without the cookie share a "default" session.
//
// Product endpoints (documented in evals/briefs/asset-library.md):
//   GET  /api/assets?q=&offset=&limit=
//   GET  /api/assets/:id
//   POST /api/assets/delete           { "ids": [...] }
//   POST /api/uploads?filename=...    raw file bytes as the body
//   GET  /api/thumbnails/:id.svg
// Control endpoints (for generators previewing states, and for tests):
//   GET  /__mock/reset?scenario=default|empty|large[&to=/path]
//   POST /__mock/reset                { "scenario": "..." }
//   GET  /__mock/log
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  assetsFor,
  mimeFor,
  NOW,
  SCENARIOS,
  thumbnailUrlFor,
  TRANSIENT_FAILURE_FILENAME,
  UPLOAD_LIMIT_BYTES,
  type Asset,
  type Scenario,
} from './data.ts';
import { thumbnailSvg } from './thumbnails.ts';

export interface LogEntry {
  seq: number;
  method: string;
  path: string;
  query: Record<string, string>;
  status: number;
  filename?: string;
  sizeBytes?: number;
  ids?: string[];
  error?: string;
}

interface Session {
  scenario: Scenario;
  deleted: Set<string>;
  uploaded: Asset[];
  attempts: Map<string, number>;
  log: LogEntry[];
  nextUpload: number;
}

export type Next = (error?: unknown) => void;
export type Handler = (req: IncomingMessage, res: ServerResponse, next?: Next) => void;

const COOKIE = 'mock-session';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const PREVIEWABLE = /^image\/(?:png|jpeg|webp|gif|svg\+xml)$/;

function newSession(scenario: Scenario): Session {
  return { scenario, deleted: new Set(), uploaded: [], attempts: new Map(), log: [], nextUpload: 1 };
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, code: string, extra: Record<string, unknown> = {}): void {
  sendJson(res, status, { error: { code, ...extra } });
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

/** Counts body bytes without buffering them; the oversized upload is 112 MB. */
function countBytes(req: IncomingMessage): Promise<number> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    req.on('end', () => resolve(bytes));
    req.on('error', reject);
  });
}

function isScenario(value: unknown): value is Scenario {
  return typeof value === 'string' && (SCENARIOS as readonly string[]).includes(value);
}

function intParam(value: string | null, fallback: number, min: number, max: number): number {
  const n = value === null ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

export function createMockApi(): Handler {
  const sessions = new Map<string, Session>();

  const sessionFor = (req: IncomingMessage): Session => {
    const match = /(?:^|;\s*)mock-session=([\w-]+)/.exec(req.headers.cookie ?? '');
    const id = match?.[1] ?? 'default';
    let session = sessions.get(id);
    if (!session) {
      session = newSession('default');
      sessions.set(id, session);
    }
    return session;
  };

  const startSession = (scenario: Scenario): string => {
    const id = randomUUID();
    sessions.set(id, newSession(scenario));
    return id;
  };

  const visibleAssets = (session: Session): Asset[] => [
    ...session.uploaded,
    ...assetsFor(session.scenario).filter((a) => !session.deleted.has(a.id)),
  ];

  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://mock.local');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (!path.startsWith('/api/') && !path.startsWith('/__mock/')) {
      if (next) next();
      else sendError(res, 404, 'not_found');
      return;
    }

    void (async () => {
      // Thumbnails: no session, no log.
      const thumb = /^\/api\/thumbnails\/([\w-]+)\.svg$/.exec(path);
      if (thumb && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' });
        res.end(thumbnailSvg(thumb[1] ?? ''));
        return;
      }

      if (path === '/__mock/reset') {
        const scenario = method === 'POST' ? ((await readJson(req)) as { scenario?: unknown } | undefined)?.scenario : url.searchParams.get('scenario');
        const chosen = scenario ?? 'default';
        if (!isScenario(chosen)) return sendError(res, 400, 'unknown_scenario', { scenarios: SCENARIOS });
        const cookie = `${COOKIE}=${startSession(chosen)}; Path=/; SameSite=Lax`;
        if (method === 'POST') return sendJson(res, 200, { scenario: chosen }, { 'Set-Cookie': cookie });
        const to = url.searchParams.get('to') ?? '/';
        res.writeHead(302, { Location: to.startsWith('/') ? to : '/', 'Set-Cookie': cookie, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }

      const session = sessionFor(req);

      if (path === '/__mock/log' && method === 'GET') {
        return sendJson(res, 200, { scenario: session.scenario, now: NOW, entries: session.log });
      }

      const entry: LogEntry = { seq: session.log.length + 1, method, path, query: Object.fromEntries(url.searchParams), status: 0 };
      session.log.push(entry);
      const reply = (status: number, body: unknown) => {
        entry.status = status;
        const code = (body as { error?: { code?: string } }).error?.code;
        if (code) entry.error = code;
        sendJson(res, status, body);
      };

      if (path === '/api/assets' && method === 'GET') {
        const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
        const offset = intParam(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
        const limit = intParam(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
        const matches = visibleAssets(session).filter((a) => !q || a.filename.toLowerCase().includes(q));
        return reply(200, { total: matches.length, offset, limit, items: matches.slice(offset, offset + limit) });
      }

      const one = /^\/api\/assets\/([\w-]+)$/.exec(path);
      if (one && method === 'GET') {
        const asset = visibleAssets(session).find((a) => a.id === one[1]);
        return asset ? reply(200, asset) : reply(404, { error: { code: 'not_found' } });
      }

      if (path === '/api/assets/delete' && method === 'POST') {
        const body = (await readJson(req)) as { ids?: unknown } | undefined;
        const ids = body?.ids;
        if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
          return reply(400, { error: { code: 'ids_required' } });
        }
        entry.ids = ids;
        const existing = new Set(visibleAssets(session).map((a) => a.id));
        const deleted = ids.filter((id) => existing.has(id));
        session.uploaded = session.uploaded.filter((a) => !deleted.includes(a.id));
        for (const id of deleted) session.deleted.add(id);
        return reply(200, { deleted: deleted.length });
      }

      if (path === '/api/uploads' && method === 'POST') {
        // Log the filename as soon as the request starts; status stays 0
        // until the body has arrived and the response is sent.
        const filename = url.searchParams.get('filename')?.trim() ?? '';
        entry.filename = filename;
        const sizeBytes = await countBytes(req);
        entry.sizeBytes = sizeBytes;
        if (!filename) return reply(400, { error: { code: 'filename_required' } });

        const attempt = (session.attempts.get(filename) ?? 0) + 1;
        session.attempts.set(filename, attempt);
        if (filename === TRANSIENT_FAILURE_FILENAME && attempt === 1) {
          return reply(503, { error: { code: 'connection_interrupted' } });
        }
        if (sizeBytes > UPLOAD_LIMIT_BYTES) {
          return reply(413, { error: { code: 'file_too_large', limitBytes: UPLOAD_LIMIT_BYTES } });
        }
        const id = `upload-${session.nextUpload++}`;
        const header = req.headers['content-type'];
        const mimeType = header && header !== 'application/octet-stream' ? header.split(';')[0]!.trim() : mimeFor(filename);
        const asset: Asset = {
          id,
          filename,
          mimeType,
          sizeBytes,
          createdAt: NOW,
          updatedAt: NOW,
          thumbnailUrl: PREVIEWABLE.test(mimeType) ? thumbnailUrlFor(id) : null,
          dimensions: null,
          durationSeconds: null,
        };
        session.uploaded.unshift(asset);
        return reply(201, asset);
      }

      return reply(404, { error: { code: 'not_found' } });
    })().catch((error: unknown) => {
      if (!res.headersSent) sendError(res, 500, 'mock_error', { message: String(error) });
      else res.destroy();
    });
  };
}

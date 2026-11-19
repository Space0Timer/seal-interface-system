// A local stand-in for the Messages API, so the real Claude Code CLI can run
// without calling a model or spending anything. The session is pointed at it
// with ANTHROPIC_BASE_URL. It replays a fixed script of assistant turns
// (tool calls, then a final message) and records every request it receives,
// which shows exactly what a session sends: the system prompt, the tools and
// the messages.
//
// The script step is the number of assistant turns already in the request,
// so retries and side requests never shift it. Requests that don't carry the
// session's tools (for example a title or quota check) get a short text reply.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type ScriptTurn = { text: string } | { tool: string; input: Record<string, unknown> };

export interface RecordedRequest {
  method: string;
  path: string;
  /** Request body, parsed. Headers aren't kept, so no credential is ever recorded. */
  body: unknown;
}

export interface StubModel {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

interface MessagesBody {
  model?: string;
  stream?: boolean;
  tools?: Array<{ name?: string }>;
  messages?: Array<{ role: string; content: unknown }>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

let ids = 0;
const id = (prefix: string) => `${prefix}_stub${(++ids).toString().padStart(6, '0')}`;

function blockFor(turn: ScriptTurn): Record<string, unknown> {
  return 'tool' in turn ? { type: 'tool_use', id: id('toolu'), name: turn.tool, input: turn.input } : { type: 'text', text: turn.text };
}

function message(model: string, turn: ScriptTurn) {
  return {
    id: id('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content: [blockFor(turn)],
    stop_reason: 'tool' in turn ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

function sendStream(res: ServerResponse, model: string, turn: ScriptTurn): void {
  const full = message(model, turn);
  const block = full.content[0] as Record<string, unknown>;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { ...full, content: [], stop_reason: null } });
  if (block['type'] === 'tool_use') {
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { ...block, input: {} } });
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block['input']) } });
  } else {
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block['text'] } });
  }
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: full.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

/** Starts the stub on a free local port. `toolNames` identifies the session's own requests. */
export function startStubModel(script: ScriptTurn[], toolNames: string[]): Promise<StubModel> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer(async (req, res) => {
    const raw = await readBody(req).catch(() => '');
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      // Keep the raw text.
    }
    const path = (req.url ?? '').split('?')[0] ?? '';
    requests.push({ method: req.method ?? '', path, body });

    if (path.endsWith('/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    if (!path.endsWith('/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'stub' } }));
      return;
    }
    const messages = body as MessagesBody;
    const model = messages.model ?? 'stub';
    const isSession = toolNames.length > 0 && (messages.tools ?? []).some((t) => t.name && toolNames.includes(t.name));
    const step = (messages.messages ?? []).filter((m) => m.role === 'assistant').length;
    const turn: ScriptTurn = isSession ? (script[step] ?? { text: 'Done.' }) : { text: 'ok' };
    if (messages.stream) sendStream(res, model, turn);
    else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message(model, turn)));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

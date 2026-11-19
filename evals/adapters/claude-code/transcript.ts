// Reads a Claude Code stream-json transcript and checks, from the session's
// own record, that it stayed isolated: what it loaded at start (init event),
// every path it touched, and everything it received back from its tools.
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { IsolationCheck } from '../types.ts';

export interface InitEvent {
  type: 'system';
  subtype: 'init';
  cwd?: string;
  model?: string;
  tools?: string[];
  mcp_servers?: Array<{ name: string; status?: string }>;
  plugins?: Array<{ name: string; path?: string }>;
  skills?: string[];
  slash_commands?: string[];
  agents?: string[];
  permissionMode?: string;
  apiKeySource?: string;
  claude_code_version?: string;
  output_style?: string;
  [key: string]: unknown;
}

export interface ResultEvent {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  permission_denials?: Array<{ tool_name?: string; tool_use_id?: string; tool_input?: unknown }>;
  errors?: unknown[];
  [key: string]: unknown;
}

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  isError: boolean;
  text: string;
}

export interface Transcript {
  init?: InitEvent | undefined;
  result?: ResultEvent | undefined;
  toolUses: ToolUse[];
  results: Map<string, ToolResult>;
  unparsed: number;
}

type Block = { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean; text?: string };

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: Block) => (typeof c === 'string' ? c : (c.text ?? JSON.stringify(c)))).join('\n');
  return content === undefined ? '' : JSON.stringify(content);
};

export function parseTranscript(jsonl: string): Transcript {
  const transcript: Transcript = { toolUses: [], results: new Map(), unparsed: 0 };
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let event: { type?: string; subtype?: string; message?: { content?: unknown } };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      transcript.unparsed++;
      continue;
    }
    if (event.type === 'system' && event.subtype === 'init') transcript.init = event as InitEvent;
    if (event.type === 'result') transcript.result = event as ResultEvent;
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Block[]) {
      if (event.type === 'assistant' && block.type === 'tool_use' && block.id && block.name) {
        transcript.toolUses.push({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
      }
      if (event.type === 'user' && block.type === 'tool_result' && block.tool_use_id) {
        transcript.results.set(block.tool_use_id, { isError: block.is_error === true, text: textOf(block.content) });
      }
    }
  }
  return transcript;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const show = (xs: readonly string[] | undefined) => (xs && xs.length ? xs.join(', ') : 'none');

export interface InitExpectation {
  model: string;
  tools: string[];
  /** Skills the session may list: the condition's skill, plus any that ship inside Claude Code itself. */
  skills: string[];
  cwd: string;
  version?: string | undefined;
}

/** What the session loaded at start, from its init event. */
export function checkInit(init: InitEvent | undefined, expected: InitExpectation): IsolationCheck[] {
  if (!init) return [{ id: 'claude-code.init', ok: false, detail: 'the session never reported its init event' }];
  const mcp = (init.mcp_servers ?? []).map((s) => s.name);
  const plugins = (init.plugins ?? []).map((p) => p.name);
  const skills = init.skills ?? [];
  const checks: IsolationCheck[] = [
    { id: 'claude-code.init-model', ok: init.model === expected.model, detail: `model ${init.model ?? 'unknown'} (expected ${expected.model})` },
    { id: 'claude-code.init-tools', ok: sameSet(init.tools ?? [], expected.tools), detail: `tools: ${show(init.tools)} (expected ${show(expected.tools)})` },
    { id: 'claude-code.init-mcp', ok: mcp.length === 0, detail: `MCP servers: ${show(mcp)}` },
    { id: 'claude-code.init-plugins', ok: plugins.length === 0, detail: `plugins: ${show(plugins)}` },
    { id: 'claude-code.init-skills', ok: sameSet(skills, expected.skills), detail: `skills: ${show(skills)} (expected ${show(expected.skills)})` },
    { id: 'claude-code.init-cwd', ok: init.cwd === expected.cwd, detail: `working directory ${init.cwd ?? 'unknown'}` },
    { id: 'claude-code.init-permission-mode', ok: init.permissionMode === 'dontAsk', detail: `permission mode ${init.permissionMode ?? 'unknown'}` },
  ];
  if (expected.version) {
    const version = init.claude_code_version;
    checks.push({ id: 'claude-code.init-version', ok: version === expected.version, detail: `Claude Code ${version ?? 'unknown'} (expected ${expected.version})` });
  }
  return checks;
}

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** System folders a shell command may name without leaving the workspace in any way that matters. */
const SYSTEM = ['/dev/', '/bin/', '/usr/bin/', '/usr/sbin/', '/sbin/', '/usr/lib/', '/usr/share/'];

/**
 * Paths in a shell command that point outside the workspace and exist on
 * disk. Absolute, home (~) and parent (..) paths are resolved; URLs and
 * strings that aren't real paths (such as "/api/assets") are ignored.
 */
export function outsidePaths(command: string, workspace: string, home: string, exists: (p: string) => boolean = existsSync): string[] {
  const found = new Set<string>();
  for (const match of command.matchAll(/(?:^|[\s'"`=:(<>|;&])((?:~|\.\.|\/)[^\s'"`|;&<>()]*)/g)) {
    const token = match[1]!;
    if (token.includes('://')) continue;
    const path = token.startsWith('~') ? join(home, token.slice(1)) : isAbsolute(token) ? resolve(token) : resolve(workspace, token);
    if (inside(path, workspace) || SYSTEM.some((s) => path.startsWith(s) || `${path}/` === s)) continue;
    if (exists(path)) found.add(path);
  }
  return [...found];
}

const FILE_FIELDS: Record<string, string[]> = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['path', 'pattern'],
  Grep: ['path'],
};

export interface PathAccess {
  tool: string;
  path: string;
  /** The tool call was refused or failed, so nothing was read or written. */
  denied: boolean;
}

/** Every path outside the workspace that a tool call named. */
export function outsideAccesses(transcript: Transcript, workspace: string, home: string, exists: (p: string) => boolean = existsSync): PathAccess[] {
  const accesses: PathAccess[] = [];
  for (const use of transcript.toolUses) {
    const denied = transcript.results.get(use.id)?.isError ?? true;
    const paths: string[] = [];
    if (use.name === 'Bash') {
      paths.push(...outsidePaths(String(use.input['command'] ?? ''), workspace, home, exists));
    } else {
      for (const field of FILE_FIELDS[use.name] ?? []) {
        const value = use.input[field];
        if (typeof value !== 'string' || !value) continue;
        if (field === 'pattern' && !isAbsolute(value) && !value.startsWith('~') && !value.startsWith('..')) continue;
        const path = value.startsWith('~') ? join(home, value.slice(1)) : resolve(workspace, value);
        if (!inside(path, workspace)) paths.push(path);
      }
    }
    for (const path of paths) accesses.push({ tool: use.name, path, denied });
  }
  return accesses;
}

/** Every path the session read or wrote is inside the workspace. Refused attempts are listed, not failed. */
export function checkPaths(transcript: Transcript, workspace: string, home: string, exists: (p: string) => boolean = existsSync): IsolationCheck {
  const accesses = outsideAccesses(transcript, workspace, home, exists);
  const succeeded = accesses.filter((a) => !a.denied);
  const refused = accesses.filter((a) => a.denied);
  const list = (as: PathAccess[]) => as.map((a) => `${a.tool} ${a.path}`).join('; ');
  return {
    id: 'claude-code.paths-inside-workspace',
    ok: succeeded.length === 0,
    detail: succeeded.length
      ? `tool calls reached outside the workspace: ${list(succeeded)}`
      : `${transcript.toolUses.length} tool calls stayed inside the workspace${refused.length ? `; refused attempts outside it: ${list(refused)}` : ''}`,
  };
}

/** Nothing the session received from its tools contains the canary's token or a forbidden path. */
export function checkReceived(transcript: Transcript, canaryToken: string, forbiddenPaths: string[]): IsolationCheck[] {
  const texts = [...transcript.results.entries()].map(([id, r]) => ({ id, text: r.text }));
  if (transcript.init) texts.push({ id: 'init', text: JSON.stringify(transcript.init) });
  const withCanary = texts.filter((t) => t.text.includes(canaryToken)).map((t) => t.id);
  const withPaths = texts.flatMap((t) => forbiddenPaths.filter((p) => t.text.includes(p)).map((p) => `${t.id} (${p})`));
  return [
    {
      id: 'claude-code.canary-unread',
      ok: withCanary.length === 0,
      detail: withCanary.length ? `the canary's token came back in ${withCanary.join(', ')}` : `the canary's token is in none of ${texts.length} tool results`,
    },
    {
      id: 'claude-code.no-forbidden-paths',
      ok: withPaths.length === 0,
      detail: withPaths.length ? `forbidden paths came back in ${withPaths.join(', ')}` : 'no tool result or init field names the repo, the results or ~/.claude',
    },
  ];
}

/** The session finished on its own: no crash, timeout, budget stop or error result. */
export function sessionOutcome(transcript: Transcript, exitCode: number | null, timedOut: boolean): { ok: boolean; error?: string } {
  if (timedOut) return { ok: false, error: 'the session hit the time limit' };
  const result = transcript.result;
  if (!result) return { ok: false, error: `the session ended without a result (exit code ${exitCode})` };
  if (result.is_error || (result.subtype && result.subtype !== 'success')) {
    return { ok: false, error: `the session ended with ${result.subtype ?? 'an error'}${result.result ? `: ${String(result.result).slice(0, 300)}` : ''}` };
  }
  return exitCode === 0 ? { ok: true } : { ok: false, error: `exit code ${exitCode}` };
}

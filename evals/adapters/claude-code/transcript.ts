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
 * A command without its here-document bodies. A body is the content of a
 * file the command writes, such as source code, not paths it reaches.
 */
export function withoutHeredocs(command: string): string {
  const kept: string[] = [];
  let end: string | undefined;
  let tabs = false;
  for (const line of command.split('\n')) {
    if (end !== undefined) {
      if ((tabs ? line.replace(/^\t+/, '') : line) === end) {
        end = undefined;
        kept.push(line);
      }
      continue;
    }
    kept.push(line);
    const start = /(?<!<)<<(?!<)(-?)\s*(['"]?)([A-Za-z_]\w*)\2/.exec(line);
    if (start) {
      end = start[3];
      tabs = start[1] === '-';
    }
  }
  return kept.join('\n');
}

/**
 * A command split into simple commands at ;, &&, ||, | and line breaks
 * outside quotes, with a leading "(" or "{" of a group dropped.
 */
export function simpleCommands(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      current += c;
      if (c === '\\' && quote === '"' && i + 1 < command.length) current += command[++i];
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    if (c === ';' || c === '\n' || c === '|' || (c === '&' && command[i + 1] === '&')) {
      parts.push(current);
      current = '';
      if ((c === '|' || c === '&') && command[i + 1] === c) i++;
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts.map((part) => part.trim().replace(/^[({]\s*/, '')).filter(Boolean);
}

const unquote = (word: string) => word.replace(/^(['"])(.*)\1$/, '$2');

/**
 * Where a cd sends the shell. A bare cd or ~ is the home folder; "cd -" or
 * a target that uses a variable can't be followed, so the shell is taken
 * to stay where it was.
 */
function cdTarget(segment: string, cwd: string, home: string): string | undefined {
  const match = /^(?:cd|pushd)(?:\s+(\S+))?\s*\)?$/.exec(segment);
  if (!match) return undefined;
  const target = match[1] === undefined ? '~' : unquote(match[1]);
  if (target === '-' || target.includes('$')) return cwd;
  if (target === '~' || target.startsWith('~/')) return join(home, target.slice(1));
  return resolve(cwd, target);
}

/**
 * Paths a shell command names outside the workspace and the session's own
 * folders, which exist on disk, and the folder the shell is left in.
 *
 * The command runs from cwd and follows its cd's, so "cd src && cat
 * ../package.json" names the workspace's own file. A cd's own target is
 * where the shell moves, not something it reads; once it's outside the
 * workspace, plain names count as paths there. Absolute, home (~) and
 * parent (..) paths are resolved; URLs and strings that aren't real paths
 * (such as "/api/assets") are ignored, and so are here-document bodies. A
 * lone "/" is nearly always division in code, and the root holds only the
 * system's top-level folders, so it isn't counted either.
 */
export function shellAccesses(
  command: string,
  cwd: string,
  workspace: string,
  home: string,
  exists: (p: string) => boolean = existsSync,
  own: readonly string[] = [],
): { paths: string[]; cwd: string } {
  const found = new Set<string>();
  for (const segment of simpleCommands(withoutHeredocs(command))) {
    const moved = cdTarget(segment, cwd, home);
    if (moved !== undefined) {
      cwd = moved;
      continue;
    }
    // Outside the workspace and the session's folders, a plain name is a path there too.
    if (![workspace, ...own].some((root) => inside(cwd, root))) {
      for (const word of segment.split(/\s+/).slice(1).map(unquote)) {
        if (!word || word.startsWith('-') || /[$~*?=:<>]|^\.\.|^\//.test(word)) continue;
        const path = resolve(cwd, word);
        if (exists(path)) found.add(path);
      }
    }
    for (const match of segment.matchAll(/(?:^|[\s'"`=:(<>|;&])((?:~|\.\.|\/)[^\s'"`|;&<>()]*)/g)) {
      const token = match[1]!;
      if (token.includes('://')) continue;
      const path = token.startsWith('~') ? join(home, token.slice(1)) : isAbsolute(token) ? resolve(token) : resolve(cwd, token);
      if (path === '/' || [workspace, ...own].some((root) => inside(path, root))) continue;
      if (SYSTEM.some((s) => path.startsWith(s) || `${path}/` === s)) continue;
      if (exists(path)) found.add(path);
    }
  }
  return { paths: [...found], cwd };
}

/** Paths a shell command run from the workspace names outside it and the session's own folders (see shellAccesses). */
export function outsidePaths(command: string, workspace: string, home: string, exists: (p: string) => boolean = existsSync, own: readonly string[] = []): string[] {
  return shellAccesses(command, workspace, workspace, home, exists, own).paths;
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

/** Every path outside the workspace and the session's own folders that a tool call named. */
export function outsideAccesses(
  transcript: Transcript,
  workspace: string,
  home: string,
  exists: (p: string) => boolean = existsSync,
  own: readonly string[] = [],
): PathAccess[] {
  const accesses: PathAccess[] = [];
  // Claude Code keeps the shell's folder from one command to the next while it stays in the workspace.
  let cwd = workspace;
  for (const use of transcript.toolUses) {
    const denied = transcript.results.get(use.id)?.isError ?? true;
    const paths: string[] = [];
    if (use.name === 'Bash') {
      const shell = shellAccesses(String(use.input['command'] ?? ''), cwd, workspace, home, exists, own);
      paths.push(...shell.paths);
      cwd = inside(shell.cwd, workspace) ? shell.cwd : workspace;
    } else {
      for (const field of FILE_FIELDS[use.name] ?? []) {
        const value = use.input[field];
        if (typeof value !== 'string' || !value) continue;
        if (field === 'pattern' && !isAbsolute(value) && !value.startsWith('~') && !value.startsWith('..')) continue;
        const path = value.startsWith('~') ? join(home, value.slice(1)) : resolve(workspace, value);
        if (![workspace, ...own].some((root) => inside(path, root))) paths.push(path);
      }
    }
    for (const path of paths) accesses.push({ tool: use.name, path, denied });
  }
  return accesses;
}

/**
 * Every path the session read or wrote is inside the workspace or its own
 * folders (own, such as its temp folder). Refused attempts are listed, not
 * failed. A Bash path the sandbox denies (sandbox.deny, unless
 * sandbox.allow re-allows it) counts as refused even when the command as a
 * whole succeeded, as "ls /Applications | grep chrome; which chromium"
 * does: the sandbox refused the ls, which the probe proves before every
 * session. Paths it doesn't deny still need the command to have failed.
 */
export function checkPaths(
  transcript: Transcript,
  workspace: string,
  home: string,
  exists: (p: string) => boolean = existsSync,
  own: readonly string[] = [],
  sandbox: { deny: readonly string[]; allow: readonly string[] } = { deny: [], allow: [] },
): IsolationCheck {
  const sandboxed = (path: string) =>
    sandbox.deny.some((root) => inside(path, root)) && !sandbox.allow.some((root) => inside(path, root));
  const accesses = outsideAccesses(transcript, workspace, home, exists, own).map((a) =>
    a.tool === 'Bash' && sandboxed(a.path) ? { ...a, denied: true } : a,
  );
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

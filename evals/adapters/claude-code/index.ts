// The Claude Code adapter: one fresh, isolated, headless session per run.
//
// Before the real session, a probe session runs with the same command,
// settings and workspace, but against a local stub model, so it costs
// nothing. The stub makes the session try to read the canary, the repo and
// the owner's home, write outside the workspace and reach the network, and
// then do the ordinary things a generator needs (read a workspace file, run
// node and pnpm). Every forbidden attempt must fail and every ordinary one
// must work, or the run stops before any model is called. The probe also
// records the system prompt and first message the session sends, so they
// can be checked for the repo path and for words about the eval.
//
// The claude-code-stub variant then runs the generation itself against the
// stub too (it writes the conformance app), proving the whole pipeline with
// the real CLI for free.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leakIn } from '../../starter/src/leaks.ts';
import type { Adapter, GenerateOptions, GenerateResult, IsolationCheck } from '../types.ts';
import { buildInvocation, redacted, sessionPaths, TOOLS, type Invocation, type InvocationInput } from './invocation.ts';
import { startStubModel, type RecordedRequest, type ScriptTurn } from './stub-model.ts';
import { checkInit, checkPaths, checkReceived, parseTranscript, sessionOutcome, type Transcript } from './transcript.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The model the claude-code-stub adapter asks for when none is given. Any ID works; nothing is called. */
export const STUB_MODEL = 'claude-stub';

/**
 * Skills Claude Code still reports with bundled skills turned off. `doctor`
 * is a user-only command (/doctor): the probe confirms it never appears in
 * what the model is sent. Anything else in the init event's skill list
 * fails the isolation check.
 */
export const BUNDLED_SKILLS = ['doctor'];

/**
 * Lines of Claude Code's own system prompt that contain a word from the
 * leak list. They're the same in every condition and say nothing about the
 * eval. A new match fails the check until someone reviews it and adds the
 * exact line here.
 */
export const SYSTEM_PROMPT_LINES_ALLOWED = ['# Harness'];

export interface ClaudeCodeOptions {
  /** Run the generation against the local stub model instead of the API. */
  stubModel?: boolean;
  /** The CLI to run. Default: $CLAUDE_CODE_BIN, else `claude` on PATH. */
  bin?: string;
}

function onPath(name: string): string | undefined {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    const candidate = join(dir, name);
    if (dir && existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function findClaude(bin?: string): string | undefined {
  return bin ?? process.env['CLAUDE_CODE_BIN'] ?? onPath('claude');
}

/** The CLI's version, read with an empty home so no config is touched. */
function readVersion(bin: string): string | undefined {
  const home = mkdtempSync(join(tmpdir(), 'cc-version-'));
  try {
    const out = execFileSync(bin, ['--version'], { env: { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') }, encoding: 'utf8' });
    return /^(\d+\.\d+\.\d+)/.exec(out.trim())?.[1];
  } catch {
    return undefined;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

interface SessionRun {
  transcript: Transcript;
  exitCode: number | null;
  timedOut: boolean;
}

/** Runs one session, streaming its transcript and stderr into the log folder. */
function runSession(
  bin: string,
  invocation: Invocation,
  workspace: string,
  prompt: string,
  files: { transcript: string; stderr: string },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SessionRun> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, invocation.args, { cwd: workspace, env: invocation.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      writeFileSync(files.transcript, stdout);
    });
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      writeFileSync(files.transcript, stdout);
      writeFileSync(files.stderr, stderr);
      resolvePromise({ transcript: parseTranscript(stdout), exitCode: code, timedOut });
    });
    child.stdin?.end(prompt);
  });
}

/** What a session sent in its first request: the system prompt and every message, as text. */
export function firstRequestText(
  requests: RecordedRequest[],
): { system: string; messages: string; tools: string[]; params: Record<string, unknown> } | undefined {
  type Body = { system?: unknown; tools?: Array<{ name?: string }>; messages?: Array<{ role: string; content: unknown }>; [key: string]: unknown };
  const session = requests.map((r) => r.body as Body).find((b) => b && (b.tools ?? []).some((t) => t.name === 'Bash'));
  if (!session) return undefined;
  const text = (v: unknown): string =>
    typeof v === 'string' ? v : Array.isArray(v) ? v.map((x: { text?: string }) => (typeof x === 'string' ? x : (x.text ?? ''))).join('\n') : '';
  return {
    system: text(session.system),
    messages: (session.messages ?? []).map((m) => `[${m.role}]\n${text(m.content)}`).join('\n\n'),
    tools: (session.tools ?? []).map((t) => t.name ?? ''),
    // The request settings the session sends (model, thinking, effort, output cap), for the record.
    params: Object.fromEntries(['model', 'max_tokens', 'thinking', 'output_config', 'context_management'].map((k) => [k, session[k]])),
  };
}

/**
 * The first request names no forbidden path and carries no eval words or
 * owner copy, apart from reviewed lines of Claude Code's own system prompt.
 * (The sandbox description in it lists the owner's home as a denied folder,
 * which is expected.)
 */
export function checkFirstRequest(first: ReturnType<typeof firstRequestText>, prompt: string, forbiddenPaths: string[]): IsolationCheck[] {
  if (!first) return [{ id: 'claude-code.first-request', ok: false, detail: 'the probe recorded no session request' }];
  const system = first.system
    .split('\n')
    .filter((line) => !SYSTEM_PROMPT_LINES_ALLOWED.includes(line.trim()))
    .join('\n');
  const all = `${system}\n${first.messages}`;
  const paths = forbiddenPaths.filter((p) => all.includes(p));
  const leak = leakIn(all);
  return [
    {
      id: 'claude-code.first-request-paths',
      ok: paths.length === 0,
      detail: paths.length ? `the session was sent ${paths.join(', ')}` : 'the system prompt and messages name neither the repo, the results nor ~/.claude',
    },
    {
      id: 'claude-code.first-request-neutral',
      ok: !leak,
      detail: leak
        ? `what the session was sent ${leak}`
        : `the system prompt and messages carry no eval words or owner copy (reviewed system prompt lines: ${SYSTEM_PROMPT_LINES_ALLOWED.join(', ')})`,
    },
    {
      id: 'claude-code.first-request-no-bundled-skills',
      ok: !BUNDLED_SKILLS.some((name) => all.includes(name)),
      detail: BUNDLED_SKILLS.some((name) => all.includes(name))
        ? `the model was shown ${BUNDLED_SKILLS.filter((name) => all.includes(name)).join(', ')}`
        : `the model is never shown ${BUNDLED_SKILLS.join(', ')}`,
    },
    {
      id: 'claude-code.first-request-prompt',
      ok: first.messages.includes(prompt),
      detail: first.messages.includes(prompt) ? 'the first message carries the prompt unchanged' : 'the prompt is missing from the first message',
    },
  ];
}

interface ProbeTargets {
  canaryFile: string;
  canaryToken: string;
  canaryDir: string;
  repoFile: string;
  repoDir: string;
  realHome: string;
  /** Claude Code's shared temp folder, which holds other sessions' files. */
  agentTemp: string;
  workspace: string;
  skill?: string | undefined;
}

/** The probe's script: forbidden attempts first, then ordinary work. */
export function probeScript(t: ProbeTargets): ScriptTurn[] {
  const q = (p: string) => `'${p.replaceAll("'", "'\\''")}'`;
  return [
    { tool: 'Read', input: { file_path: t.canaryFile } },
    { tool: 'Read', input: { file_path: t.repoFile } },
    { tool: 'Bash', input: { command: `cat ${q(t.canaryFile)}`, description: 'Show a file' } },
    { tool: 'Bash', input: { command: `ls ${q(t.repoDir)}`, description: 'List a folder' } },
    { tool: 'Bash', input: { command: `ls ${q(t.realHome)}`, description: 'List a folder' } },
    { tool: 'Bash', input: { command: `ls ${q(t.agentTemp)}`, description: 'List a folder' } },
    { tool: 'Write', input: { file_path: join(t.canaryDir, 'from-write.txt'), content: 'x' } },
    { tool: 'Bash', input: { command: `echo x > ${q(join(t.canaryDir, 'from-shell.txt'))}`, description: 'Write a file' } },
    { tool: 'Bash', input: { command: "curl -sS -m 5 -o /dev/null -w '%{http_code}' https://example.com", description: 'Fetch a page' } },
    { tool: 'Bash', input: { command: 'node --version && pnpm --version', description: 'Show versions' } },
    { tool: 'Read', input: { file_path: join(t.workspace, 'README.md') } },
    ...(t.skill ? [{ tool: 'Skill', input: { skill: t.skill } }] : []),
    { text: 'Done.' },
  ];
}

/** Judges the probe: every forbidden attempt failed, every ordinary step worked. */
export function judgeProbe(transcript: Transcript, t: ProbeTargets, versions: { node: string; pnpm: string }): IsolationCheck[] {
  const result = (i: number) => {
    const use = transcript.toolUses[i];
    return use ? transcript.results.get(use.id) : undefined;
  };
  const entries = (dir: string) => {
    if (!existsSync(dir)) return [];
    const workspaceEntries = new Set(readdirSync(t.workspace));
    return readdirSync(dir).filter((e) => !workspaceEntries.has(e) && e.length > 3 && !e.startsWith('.'));
  };
  const shows = (i: number, names: string[]) => names.filter((n) => result(i)?.text.includes(n));
  const repoEntries = shows(3, entries(t.repoDir));
  const homeEntries = shows(4, entries(t.realHome));
  const tempEntries = shows(5, entries(t.agentTemp));
  const curl = result(8);
  const reached = curl && /^\s*[1-5]\d\d\s*$/m.test(curl.text);
  const tools = result(9);
  const readme = result(10);
  // [id, tool call index, passed, what it shows]
  const probes: Array<[string, number, boolean, string]> = [
    ['read-canary', 0, !!result(0) && !result(0)!.text.includes(t.canaryToken), 'Read of the canary returned nothing of it'],
    ['read-repo', 1, !!result(1)?.isError, 'Read of a repo file was refused'],
    ['shell-canary', 2, !!result(2) && !result(2)!.text.includes(t.canaryToken), 'cat of the canary returned nothing of it'],
    ['shell-repo', 3, !!result(3) && repoEntries.length === 0, `ls of the repo listed nothing${repoEntries.length ? ` (it listed ${repoEntries.join(', ')})` : ''}`],
    ['shell-home', 4, !!result(4) && homeEntries.length === 0, `ls of the owner's home listed nothing${homeEntries.length ? ` (it listed ${homeEntries.join(', ')})` : ''}`],
    ['shell-agent-temp', 5, !!result(5) && tempEntries.length === 0, `ls of Claude Code's shared temp folder listed nothing${tempEntries.length ? ` (it listed ${tempEntries.join(', ')})` : ''}`],
    ['write-outside', 6, !!result(6) && !existsSync(join(t.canaryDir, 'from-write.txt')), 'Write outside the workspace created nothing'],
    ['shell-write-outside', 7, !!result(7) && !existsSync(join(t.canaryDir, 'from-shell.txt')), 'a shell write outside the workspace created nothing'],
    ['network', 8, !!curl && !reached, 'the shell has no network'],
    ['shell-works', 9, !!tools && !tools.isError && tools.text.includes(versions.node) && tools.text.includes(versions.pnpm), `the shell runs node ${versions.node} and pnpm ${versions.pnpm}`],
    ['read-workspace', 10, !!readme && !readme.isError && readme.text.includes('Starter'), 'Read of a workspace file worked'],
  ];
  if (t.skill) probes.push(['skill-call', 11, !!result(11) && !result(11)?.isError, `the ${t.skill} Skill call succeeded`]);
  return probes.map(([id, index, ok, detail]) => ({
    id: `claude-code.probe-${id}`,
    ok,
    detail: ok ? detail : `FAILED: ${detail}. Result: ${JSON.stringify(result(index)?.text ?? 'none').slice(0, 300)}`,
  }));
}

/** The stub generation: writes the conformance app and builds it, like a generator would. */
function stubGenerationScript(workspace: string, skill?: GenerateOptions['skill']): ScriptTurn[] {
  const app = join(REPO, 'evals', 'tests', 'conformance-app');
  const tokens = skill && existsSync(join(workspace, skill.dir, 'tokens.resolver.json')) ? "import './src/design-tokens.css';\n" : '';
  return [
    { tool: 'Read', input: { file_path: join(workspace, 'README.md') } },
    { tool: 'Write', input: { file_path: join(workspace, 'index.html'), content: readFileSync(join(app, 'index.html'), 'utf8') } },
    { tool: 'Write', input: { file_path: join(workspace, 'main.ts'), content: tokens + readFileSync(join(app, 'main.ts'), 'utf8') } },
    { tool: 'Bash', input: { command: 'pnpm build', description: 'Build the app' } },
    { text: 'The screen is built.' },
  ];
}

export function claudeCodeAdapter(options: ClaudeCodeOptions = {}): Adapter {
  const stub = options.stubModel === true;
  const bin = findClaude(options.bin);
  let version: string | undefined;
  const getVersion = () => (version ??= bin ? readVersion(bin) : undefined);

  return {
    name: stub ? 'claude-code-stub' : 'claude-code',
    live: !stub,
    skillDir: (name) => join('.claude', 'skills', name),
    version: getVersion,
    check() {
      if (!bin) throw new Error('Claude Code not found: put `claude` on PATH or set CLAUDE_CODE_BIN');
      if (!getVersion()) throw new Error(`couldn't read the version of ${bin}`);
      if (!stub && !process.env['CLAUDE_CODE_OAUTH_TOKEN']) throw new Error('set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) in the shell that starts the run');
    },
    async generate(workspace: string, prompt: string, opts: GenerateOptions): Promise<GenerateResult> {
      if (!bin) throw new Error('Claude Code not found');
      // The probe asks for the same model as the session, so the CLI's handling of
      // the exact ID (and the effort and thinking it sends) is checked before any cost.
      const model = stub ? (opts.model ?? STUB_MODEL) : opts.model;
      if (!model) throw new Error('the claude-code adapter needs an exact model ID');
      const cliVersion = getVersion();
      const realHome = homedir();
      const scratch = dirname(workspace);
      const canaryDir = dirname(opts.canary.file);
      const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
      const pnpmBin = onPath('pnpm');
      const pnpmRoot = pnpmBin ? dirname(dirname(realpathSync(pnpmBin))) : undefined;
      // A corepack pnpm shim needs corepack's cache of the pinned pnpm, which lives under the real home.
      const corepackHome = process.env['COREPACK_HOME'] ?? join(realHome, '.cache', 'node', 'corepack');
      const corepack = existsSync(corepackHome) ? corepackHome : undefined;
      const sharedTemp = `/tmp/claude-${process.getuid?.() ?? 0}`;
      const agentTemp = existsSync(sharedTemp) ? realpathSync(sharedTemp) : join('/private', sharedTemp);
      const repoDir = opts.forbiddenPaths[0]!;
      const versions = {
        node: process.version,
        pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(),
      };

      const base = (stateDir: string, auth: InvocationInput['auth']): InvocationInput => ({
        workspace,
        stateDir,
        scratch,
        canaryDir,
        model,
        effort: opts.effort,
        maxBudgetUsd: stub ? undefined : opts.maxBudgetUsd,
        hiddenRoots: [realHome, realpathSync(tmpdir()), agentTemp],
        toolRoots: [...new Set([nodeRoot, ...(pnpmRoot ? [pnpmRoot] : []), ...(corepack ? [corepack] : [])])],
        binDirs: [...new Set([dirname(process.execPath), ...(pnpmBin ? [dirname(pnpmBin)] : [])])],
        auth,
        user: userInfo().username,
        toolEnv: corepack ? { COREPACK_HOME: corepack, COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' } : undefined,
      });
      const prepare = (stateDir: string) => {
        const paths = sessionPaths(stateDir);
        for (const dir of [paths.home, paths.config, paths.tmp, paths.agentTmp]) mkdirSync(dir, { recursive: true });
      };
      const log = (name: string) => join(opts.logDir, name);
      const expectedInit = (m: string) => ({
        model: m,
        tools: TOOLS,
        skills: [...BUNDLED_SKILLS, ...(opts.skill ? [opts.skill.name] : [])],
        cwd: workspace,
        version: cliVersion,
      });
      const checks: IsolationCheck[] = [];

      // 1. The probe, against the stub model.
      const probeTargets: ProbeTargets = {
        canaryFile: opts.canary.file,
        canaryToken: opts.canary.token,
        canaryDir,
        repoFile: join(repoDir, 'package.json'),
        repoDir,
        realHome,
        agentTemp,
        workspace,
        skill: opts.skill?.name,
      };
      const probeState = join(opts.stateDir, 'probe');
      prepare(probeState);
      const probeStub = await startStubModel(probeScript(probeTargets), TOOLS);
      let probeRun: SessionRun;
      try {
        const invocation = buildInvocation(base(probeState, { stubUrl: probeStub.url }));
        writeFileSync(log('probe-invocation.json'), `${JSON.stringify(redacted(invocation), null, 2)}\n`);
        probeRun = await runSession(bin, invocation, workspace, prompt, { transcript: log('probe-transcript.jsonl'), stderr: log('probe-stderr.log') }, 5 * 60_000, opts.signal);
      } finally {
        await probeStub.close();
      }
      writeFileSync(log('probe-requests.json'), `${JSON.stringify(probeStub.requests, null, 2)}\n`);
      const first = firstRequestText(probeStub.requests);
      if (first) writeFileSync(log('probe-system-prompt.txt'), `${first.system}\n\n---- messages ----\n\n${first.messages}\n`);
      checks.push(
        ...checkInit(probeRun.transcript.init, expectedInit(model)).map((c) => ({ ...c, id: c.id.replace('claude-code.', 'claude-code.probe-') })),
        ...judgeProbe(probeRun.transcript, probeTargets, versions),
        ...checkFirstRequest(first, prompt, opts.forbiddenPaths),
      );
      if (opts.skill) {
        const skillBody = readFileSync(join(workspace, opts.skill.dir, 'SKILL.md'), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
        const encodedBody = JSON.stringify(skillBody).slice(1, -1);
        const receivedSkill = skillBody.length > 0 && probeStub.requests.some(({ body }) => JSON.stringify(body)?.includes(encodedBody));
        checks.push({
          id: 'claude-code.probe-skill-content',
          ok: receivedSkill,
          detail: receivedSkill ? 'the Skill call sent the assigned guidance to the stub model' : 'the stub model did not receive the assigned skill body',
        });
      }
      const logs = ['probe-invocation.json', 'probe-transcript.jsonl', 'probe-stderr.log', 'probe-requests.json', ...(first ? ['probe-system-prompt.txt'] : [])];
      if (!checks.every((c) => c.ok)) {
        return { ok: false, error: 'the isolation probe failed; the session was not started', logs, isolation: checks, settings: redacted(buildInvocation(base(probeState, { stubUrl: 'http://127.0.0.1:0' }))) };
      }

      // 2. The session.
      const sessionState = join(opts.stateDir, 'session');
      prepare(sessionState);
      const sessionStub = stub ? await startStubModel(stubGenerationScript(workspace, opts.skill), TOOLS) : undefined;
      const auth: InvocationInput['auth'] = sessionStub ? { stubUrl: sessionStub.url } : { oauthToken: process.env['CLAUDE_CODE_OAUTH_TOKEN']! };
      const invocation = buildInvocation(base(sessionState, auth));
      writeFileSync(log('invocation.json'), `${JSON.stringify(redacted(invocation), null, 2)}\n`);
      let run: SessionRun;
      try {
        run = await runSession(bin, invocation, workspace, prompt, { transcript: log('transcript.jsonl'), stderr: log('stderr.log') }, opts.timeoutMs, opts.signal);
      } finally {
        await sessionStub?.close();
      }
      logs.push('invocation.json', 'transcript.jsonl', 'stderr.log');

      const { transcript } = run;
      checks.push(
        ...checkInit(transcript.init, expectedInit(model)),
        checkPaths(transcript, workspace, sessionPaths(sessionState).home),
        ...checkReceived(transcript, opts.canary.token, opts.forbiddenPaths),
      );
      const outcome = sessionOutcome(transcript, run.exitCode, run.timedOut);
      const result = transcript.result;
      return {
        ok: outcome.ok,
        error: outcome.error,
        model: transcript.init?.model,
        logs,
        isolation: checks,
        usage: result
          ? {
              costUsd: result.total_cost_usd,
              turns: result.num_turns,
              durationMs: result.duration_ms,
              inputTokens: result.usage?.input_tokens,
              outputTokens: result.usage?.output_tokens,
              cacheReadTokens: result.usage?.cache_read_input_tokens,
              cacheCreationTokens: result.usage?.cache_creation_input_tokens,
            }
          : undefined,
        settings: {
          ...redacted(invocation),
          claudeCodeVersion: cliVersion,
          init: transcript.init,
          probeRequest: first?.params,
          permissionDenials: result?.permission_denials ?? [],
        },
      };
    },
  };
}

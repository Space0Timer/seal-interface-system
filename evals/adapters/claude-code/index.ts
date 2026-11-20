// The Claude Code adapter: one fresh, isolated, headless session per run.
//
// Before the real session, a probe session runs with the same command,
// settings and workspace, but against a local stub model, so it costs
// nothing. The stub makes the session try to read the canary and the
// runner's harmless files in the forbidden paths, glob and list every
// forbidden path (each repo checkout, the results, ~/.claude) and the
// owner's home, write outside the workspace and reach the network, and then
// do the ordinary things a generator needs (read a workspace file, run node
// and pnpm). Every forbidden attempt must fail, provably (a network attempt
// passes only on the sandbox's own denial), and every ordinary one must
// work, or the run stops before any model is called. The probe also
// records the system prompt and first message the session sends, so they
// can be checked for the repo path and for words about the eval.
//
// The claude-code-stub variant then runs the generation itself against the
// stub too (it writes the conformance app), proving the whole pipeline with
// the real CLI for free.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leakIn } from '../../starter/src/leaks.ts';
import { onPath, toolchain } from '../../starter/src/toolchain.ts';
import type { Adapter, GenerateOptions, GenerateResult, IsolationCheck, ReadProbe } from '../types.ts';
import { buildInvocation, coverFor, redacted, sessionPaths, TOOLS, type Invocation, type InvocationInput } from './invocation.ts';
import { startStubModel, type RecordedRequest, type ScriptTurn } from './stub-model.ts';
import { checkInit, checkPaths, checkReceived, parseTranscript, sessionOutcome, type ToolResult, type Transcript } from './transcript.ts';

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
 * (The sandbox description in it lists the owner's home and the folders that
 * cover the forbidden paths, such as /private/tmp, as denied, which is
 * expected.)
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

export interface ProbeTargets {
  canaryFile: string;
  canaryToken: string;
  canaryDir: string;
  /** Every path the session must never reach: each repo checkout, the results, ~/.claude. */
  forbidden: string[];
  /** The only files in them the probe may try to read (see GenerateOptions.readProbes). */
  readProbes: ReadProbe[];
  realHome: string;
  /** Claude Code's shared temp folder, which holds other sessions' files. */
  agentTemp: string;
  workspace: string;
  skill?: string | undefined;
}

type ToolTurn = Extract<ScriptTurn, { tool: string }>;

/** One forbidden or ordinary attempt the probe session makes, and how its result is judged. */
export interface ProbeStep {
  id: string;
  turn: ToolTurn;
  judge(result: ToolResult | undefined): { ok: boolean; detail: string };
}

/**
 * The network attempts. One goes through the sandbox's proxy; the other
 * bypasses it, so only the OS sandbox can stop it. The direct one targets a
 * documentation address (TEST-NET-1) that never answers, so it can pass
 * only on a denial, never by reaching anything. Its curl is verbose so the
 * OS's reason for refusing the connection shows. (Claude Code refuses to
 * run a command with "=" in curl's -w format, so the marker is "status ".)
 */
export const NETWORK_PROBES = {
  proxy: { command: "curl -sS -m 5 -o /dev/null -w 'status %{http_code}' https://example.com", target: 'example.com:443' },
  direct: { command: "curl -v -sS -m 5 --noproxy 192.0.2.1 -o /dev/null -w 'status %{http_code}' http://192.0.2.1", target: '192.0.2.1' },
};

/**
 * Judges a network attempt at target. Blocked only on proof of a denial:
 * the sandbox's own violation report naming the target (its proxy answers a
 * plain HTTP request with 403 itself), or the OS refusing the connection to
 * the target with EPERM, which only a sandbox or an OS-level filter does.
 * Any other HTTP status, even 404 or 500, means the network answered. Any
 * other failure (no curl, no route, a DNS error, a timeout) proves nothing.
 */
export function judgeNetwork(result: ToolResult | undefined, target: string): { verdict: 'blocked' | 'reached' | 'inconclusive'; detail: string } {
  if (!result) return { verdict: 'inconclusive', detail: 'the attempt has no result' };
  const status = /status (\d{3})/.exec(result.text)?.[1];
  const lines = result.text.split('\n').map((line) => line.trim());
  const violations = /<sandbox_violations>([\s\S]*?)<\/sandbox_violations>/.exec(result.text)?.[1] ?? '';
  const reported = violations
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('deny network-outbound') && line.includes(target));
  if (reported && (status === undefined || status === '000' || status === '403')) {
    return { verdict: 'blocked', detail: `the sandbox denied it (${reported})` };
  }
  const refused = lines.find((line) => line.includes(target) && line.includes('Operation not permitted'));
  if (refused && result.isError && (status === undefined || status === '000')) {
    return { verdict: 'blocked', detail: `the OS refused the connection (${refused})` };
  }
  if (!result.isError || (status !== undefined && status !== '000')) {
    return { verdict: 'reached', detail: `the network answered${status ? ` (HTTP ${status})` : ''}` };
  }
  return { verdict: 'inconclusive', detail: 'it failed without a denial, which proves nothing' };
}

/** The probe: forbidden attempts first, then ordinary work. */
export function probeSteps(t: ProbeTargets, versions: { node: string; pnpm: string }): ProbeStep[] {
  const q = (p: string) => `'${p.replaceAll("'", "'\\''")}'`;
  const ls = (dir: string): ToolTurn => ({ tool: 'Bash', input: { command: `ls ${q(dir)}`, description: 'List a folder' } });
  // Entries a listing could only have got from that folder.
  const entries = (dir: string) => {
    if (!existsSync(dir)) return [];
    const workspaceEntries = new Set(readdirSync(t.workspace));
    return readdirSync(dir).filter((e) => !workspaceEntries.has(e) && e.length > 3 && !e.startsWith('.'));
  };
  const listsNothing =
    (dir: string, what: string): ProbeStep['judge'] =>
    (r) => {
      const shown = entries(dir).filter((e) => r?.text.includes(e));
      return { ok: !!r && shown.length === 0, detail: `${what} listed nothing${shown.length ? ` (it listed ${shown.join(', ')})` : ''}` };
    };
  const withoutCanary =
    (what: string): ProbeStep['judge'] =>
    (r) => ({ ok: !!r && !r.text.includes(t.canaryToken), detail: `${what} returned nothing of it` });
  const createdNothing =
    (file: string, what: string): ProbeStep['judge'] =>
    (r) => ({ ok: !!r && !existsSync(file), detail: `${what} created nothing` });
  const network =
    (what: string, target: string): ProbeStep['judge'] =>
    (r) => {
      const { verdict, detail } = judgeNetwork(r, target);
      return { ok: verdict === 'blocked', detail: `${what}: ${verdict === 'blocked' ? detail : `${verdict}, ${detail}`}` };
    };

  // Numbered by position in the forbidden list, so a missing folder never renumbers the others. Only a harmless
  // file the runner named is ever read; a folder without one is only globbed and listed, which return names, never
  // contents, so a failed check can't put a secret in the logs.
  const forbidden = t.forbidden.flatMap((dir, i): ProbeStep[] => {
    if (!existsSync(dir)) return [];
    const n = i + 1;
    const probe = t.readProbes.find((p) => p.file.startsWith(`${dir}/`) && existsSync(p.file));
    return [
      ...(probe
        ? [
            {
              id: `read-forbidden-${n}`,
              turn: { tool: 'Read', input: { file_path: probe.file } },
              judge: (r: ToolResult | undefined) => ({
                ok: !!r?.isError && !(probe.token && r.text.includes(probe.token)),
                detail: `Read of ${probe.file} was refused`,
              }),
            },
          ]
        : []),
      { id: `glob-forbidden-${n}`, turn: { tool: 'Glob', input: { pattern: '*', path: dir } }, judge: listsNothing(dir, `Glob in ${dir}`) },
      { id: `shell-forbidden-${n}`, turn: ls(dir), judge: listsNothing(dir, `ls of ${dir}`) },
    ];
  });

  const fromWrite = join(t.canaryDir, 'from-write.txt');
  const fromShell = join(t.canaryDir, 'from-shell.txt');
  return [
    { id: 'read-canary', turn: { tool: 'Read', input: { file_path: t.canaryFile } }, judge: withoutCanary('Read of the canary') },
    { id: 'shell-canary', turn: { tool: 'Bash', input: { command: `cat ${q(t.canaryFile)}`, description: 'Show a file' } }, judge: withoutCanary('cat of the canary') },
    ...forbidden,
    { id: 'shell-home', turn: ls(t.realHome), judge: listsNothing(t.realHome, "ls of the owner's home") },
    { id: 'shell-agent-temp', turn: ls(t.agentTemp), judge: listsNothing(t.agentTemp, "ls of Claude Code's shared temp folder") },
    { id: 'write-outside', turn: { tool: 'Write', input: { file_path: fromWrite, content: 'x' } }, judge: createdNothing(fromWrite, 'Write outside the workspace') },
    {
      id: 'shell-write-outside',
      turn: { tool: 'Bash', input: { command: `echo x > ${q(fromShell)}`, description: 'Write a file' } },
      judge: createdNothing(fromShell, 'a shell write outside the workspace'),
    },
    ...(['proxy', 'direct'] as const).map((how) => ({
      id: `network-${how}`,
      turn: { tool: 'Bash', input: { command: NETWORK_PROBES[how].command, description: 'Fetch a page' } },
      judge: network(how === 'proxy' ? 'a request through the proxy' : 'a direct request', NETWORK_PROBES[how].target),
    })),
    {
      id: 'shell-works',
      turn: { tool: 'Bash', input: { command: 'node --version && pnpm --version', description: 'Show versions' } },
      judge: (r) => ({
        ok: !!r && !r.isError && r.text.includes(versions.node) && r.text.includes(versions.pnpm),
        detail: `the shell runs node ${versions.node} and pnpm ${versions.pnpm}`,
      }),
    },
    {
      id: 'read-workspace',
      turn: { tool: 'Read', input: { file_path: join(t.workspace, 'README.md') } },
      judge: (r) => ({ ok: !!r && !r.isError && r.text.includes('Starter'), detail: 'Read of a workspace file worked' }),
    },
    ...(t.skill ? [{
      id: 'skill-call',
      turn: { tool: 'Skill', input: { skill: t.skill } },
      judge: (r: ToolResult | undefined) => ({ ok: !!r && !r.isError, detail: `the ${t.skill} Skill call succeeded` }),
    }] : []),
  ];
}

/** The stub model's script for the probe session. */
export function probeScript(steps: ProbeStep[]): ScriptTurn[] {
  return [...steps.map((step) => step.turn), { text: 'Done.' }];
}

/** Judges the probe: every forbidden attempt failed, every ordinary step worked, each in the order scripted. */
export function judgeProbe(transcript: Transcript, steps: ProbeStep[]): IsolationCheck[] {
  return steps.map((step, i) => {
    const use = transcript.toolUses[i];
    const result = use?.name === step.turn.tool ? transcript.results.get(use.id) : undefined;
    const { ok, detail } = step.judge(result);
    return {
      id: `claude-code.probe-${step.id}`,
      ok: ok && !!result,
      detail: ok && result ? detail : `FAILED: ${result ? detail : `the session made no ${step.turn.tool} call here`}. Result: ${JSON.stringify(result?.text ?? 'none').slice(0, 300)}`,
    };
  });
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
      const tools = toolchain();
      const sharedTemp = `/tmp/claude-${process.getuid?.() ?? 0}`;
      const agentTemp = existsSync(sharedTemp) ? realpathSync(sharedTemp) : join('/private', sharedTemp);
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
        agentTemp,
        forbidden: opts.forbiddenPaths,
        toolRoots: tools.roots,
        binDirs: tools.binDirs,
        auth,
        user: userInfo().username,
        toolEnv: Object.keys(tools.env).length ? tools.env : undefined,
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
      // 0. Every forbidden path must be hidden without being named in the settings the model is shown.
      const probeState = join(opts.stateDir, 'probe');
      const cover = coverFor(base(probeState, { stubUrl: 'http://127.0.0.1:0' }));
      const named = opts.forbiddenPaths.filter((p) => cover.includes(p));
      const checks: IsolationCheck[] = [
        {
          id: 'claude-code.forbidden-hidden',
          ok: named.length === 0,
          detail: named.length
            ? `${named.join(', ')} can only be hidden from the session by naming it in the sandbox settings the model is shown, since every folder above it holds something the session needs. Move it into a folder of its own.`
            : `every forbidden path is hidden under ${cover.join(', ')}`,
        },
      ];
      if (named.length) return { ok: false, error: 'a forbidden path would be shown to the model; no session was started', logs: [], isolation: checks };

      // 1. The probe, against the stub model.
      const probe = probeSteps(
        { canaryFile: opts.canary.file, canaryToken: opts.canary.token, canaryDir, forbidden: opts.forbiddenPaths, readProbes: opts.readProbes, realHome, agentTemp, workspace, skill: opts.skill?.name },
        versions,
      );
      prepare(probeState);
      const probeStub = await startStubModel(probeScript(probe), TOOLS);
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
        ...judgeProbe(probeRun.transcript, probe),
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

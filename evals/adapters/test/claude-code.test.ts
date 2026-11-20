// The Claude Code adapter's isolation checks, each shown to fail on the
// evidence it exists to catch, plus the invocation and the stub model.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { leakIn } from '../../starter/src/leaks.ts';
import {
  checkFirstRequest,
  firstRequestText,
  judgeNetwork,
  judgeProbe,
  NETWORK_PROBES,
  probeScript,
  probeSteps,
  runSession,
  SYSTEM_PROMPT_LINES_ALLOWED,
  type ProbeStep,
  type ProbeTargets,
} from '../claude-code/index.ts';
import { buildInvocation, redacted, sandboxCover, TOOLS, type InvocationInput } from '../claude-code/invocation.ts';
import { startStubModel } from '../claude-code/stub-model.ts';
import { checkInit, checkPaths, checkReceived, outsidePaths, parseTranscript, sessionOutcome, type InitEvent } from '../claude-code/transcript.ts';

const WS = '/private/var/folders/aa/T/work-x/app';
const HOME = '/private/var/folders/aa/T/work-x/state/session/home';
const REPO = '/Users/someone/projects/repo';
const CANARY = 'note-0123456789abcdef';

const input: InvocationInput = {
  workspace: WS,
  stateDir: '/private/var/folders/aa/T/work-x/state/session',
  scratch: '/private/var/folders/aa/T/work-x',
  canaryDir: '/private/var/folders/aa/T/work-x/shared',
  model: 'claude-model-id',
  maxBudgetUsd: 5,
  hiddenRoots: ['/Users/someone', '/private/var/folders/aa/T', '/private/tmp/claude-501'],
  agentTemp: '/private/tmp/claude-501',
  // A review checkout under /private/tmp is outside every hidden root; results in the temp folder share it with the workspace.
  forbidden: ['/private/tmp/review/repo', '/private/tmp/review/results', '/Users/someone/.claude', '/private/var/folders/aa/T/runner-results-x'],
  toolRoots: ['/Users/someone/.nvm/versions/node/v24.19.0'],
  binDirs: ['/Users/someone/.nvm/versions/node/v24.19.0/bin'],
  auth: { oauthToken: 'secret-token' },
  user: 'someone',
};

test('the invocation fixes the model, tools, setting sources, MCP and permission mode', () => {
  const { args, settings } = buildInvocation(input);
  const flag = (name: string) => args[args.indexOf(name) + 1];
  assert.equal(flag('--model'), 'claude-model-id');
  assert.equal(flag('--tools'), TOOLS.join(','));
  assert.equal(flag('--setting-sources'), 'project');
  assert.equal(flag('--permission-mode'), 'dontAsk');
  assert.equal(flag('--max-budget-usd'), '5');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.some((a) => a === input.workspace), 'the prompt and paths go through stdin and cwd, not argv');
  const sandbox = settings['sandbox'] as { enabled: boolean; allowUnsandboxedCommands: boolean; filesystem: { denyRead: string[]; allowRead: string[] } };
  assert.equal(sandbox.enabled, true);
  assert.equal(sandbox.allowUnsandboxedCommands, false);
  for (const hidden of input.hiddenRoots) assert.ok(sandbox.filesystem.denyRead.includes(hidden), hidden);
  assert.ok(sandbox.filesystem.allowRead.includes(WS));
  assert.ok(!sandbox.filesystem.allowRead.includes(input.canaryDir));
});

test('every forbidden root is denied to the sandbox and the file tools, even outside the hidden roots, without being named', () => {
  const { settings } = buildInvocation(input);
  const denyRead = (settings['sandbox'] as { filesystem: { denyRead: string[] } }).filesystem.denyRead;
  const deny = (settings['permissions'] as { deny: string[] }).deny;
  // The review checkout and its results are covered by /private/tmp/review: /private/tmp holds Claude Code's shared temp folder.
  assert.ok(denyRead.includes('/private/tmp/review'));
  assert.ok(deny.includes('Read(//private/tmp/review/**)') && deny.includes('Edit(//private/tmp/review/**)'));
  for (const dir of ['/Users/someone', '/private/var/folders/aa/T']) assert.ok(denyRead.includes(dir), `sandbox denyRead: ${dir}`);
  // A permission rule can't re-allow the workspace or the toolchain inside a folder it denies.
  for (const rule of deny.filter((r) => r.startsWith('Read('))) {
    const dir = rule.slice('Read(/'.length, -'/**)'.length);
    for (const kept of [WS, input.stateDir, ...input.toolRoots]) assert.ok(!`${kept}/`.startsWith(`${dir}/`), `${rule} would deny ${kept}`);
  }
  // Claude Code shows the model its sandbox settings and Read rules: no forbidden path may appear in them.
  const shown = JSON.stringify({ denyRead, deny });
  for (const root of input.forbidden) assert.ok(!shown.includes(root), root);
  assert.equal(new Set(denyRead).size, denyRead.length, 'no duplicates');
});

test('cover: a hidden root, else the highest ancestor that holds nothing needed, else the path itself', () => {
  const hidden = ['/Users/someone', '/private/var/folders/aa/T'];
  const needed = ['/private/var/folders/aa/T/work-x/app', '/opt/node/v24'];
  assert.deepEqual(sandboxCover(['/Users/someone/projects/repo', '/Users/someone/.claude'], hidden, needed), ['/Users/someone']);
  assert.deepEqual(sandboxCover(['/private/tmp/review/repo', '/private/tmp/review/results'], hidden, needed), ['/private/tmp']);
  const withAgentTemp = [...needed, '/private/tmp/claude-501'];
  assert.deepEqual(sandboxCover(['/private/tmp/review/repo'], hidden, withAgentTemp), ['/private/tmp/review'], "the shell writes into Claude Code's shared temp folder");
  assert.deepEqual(sandboxCover(['/private/tmp/repo'], hidden, withAgentTemp), ['/private/tmp/repo'], 'directly in /private/tmp, only its own name hides it');
  assert.deepEqual(sandboxCover(['/private/var/tmp/results-x'], hidden, needed), ['/private/var/tmp'], '/private/var holds the workspace');
  assert.deepEqual(sandboxCover(['/opt/review'], hidden, needed), ['/opt/review'], '/opt holds the toolchain');
  assert.deepEqual(sandboxCover(['/opt/node'], hidden, needed), ['/opt/node'], 'a path that holds something needed is named, and the probe catches it');
});

test('the session environment is built from scratch: fresh home, no repo path, no eval words', () => {
  const { env } = buildInvocation(input);
  assert.equal(env['HOME'], `${input.stateDir}/home`);
  assert.equal(env['CLAUDE_CONFIG_DIR'], `${input.stateDir}/home/.claude`);
  assert.equal(env['CLAUDE_CODE_OAUTH_TOKEN'], 'secret-token');
  assert.equal(env['ANTHROPIC_API_KEY'], undefined, 'an API key would override the subscription token');
  assert.equal(env['ANTHROPIC_BASE_URL'], undefined);
  const text = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
  assert.equal(leakIn(text), null);
  assert.ok(!text.includes(REPO));
  assert.equal(env['PATH'], `${input.binDirs[0]}:/usr/bin:/bin:/usr/sbin:/sbin`);
});

test('the recorded invocation never contains the token', () => {
  const record = JSON.stringify(redacted(buildInvocation(input)));
  assert.ok(!record.includes('secret-token'));
  assert.ok(record.includes('<redacted>'));
});

test('shell commands: real paths outside the workspace are caught; URLs, API routes and system paths are not', () => {
  const exists = (p: string) => p.startsWith('/Users/someone') || p === '/private/var/folders/aa/T/work-x' || p === HOME || p === `${HOME}/.zshrc`;
  assert.deepEqual(outsidePaths(`cat ${REPO}/AGENTS.md`, WS, HOME, exists), [`${REPO}/AGENTS.md`]);
  assert.deepEqual(outsidePaths('ls ..', WS, HOME, exists), ['/private/var/folders/aa/T/work-x']);
  assert.deepEqual(outsidePaths('cat ~/.zshrc', WS, HOME, exists), [`${HOME}/.zshrc`]);
  assert.deepEqual(outsidePaths('curl -s http://localhost:4173/api/assets > /dev/null', WS, HOME, exists), []);
  assert.deepEqual(outsidePaths(`grep -rn "/api/assets" src && cat ${WS}/README.md && /usr/bin/env node -v`, WS, HOME, exists), []);
});

const event = (type: string, content: unknown[]) => JSON.stringify({ type, message: { content } });
const init: InitEvent = {
  type: 'system',
  subtype: 'init',
  cwd: WS,
  model: 'claude-model-id',
  tools: [...TOOLS].reverse(),
  mcp_servers: [],
  plugins: [],
  skills: ['doctor'],
  permissionMode: 'dontAsk',
  claude_code_version: '2.1.326',
};
const expected = { model: 'claude-model-id', tools: TOOLS, skills: ['doctor'], cwd: WS, version: '2.1.326' };

test('init: the expected model, tools and skills pass; any MCP server, plugin, extra skill or tool fails', () => {
  assert.ok(checkInit(init, expected).every((c) => c.ok));
  const failing = (patch: Partial<InitEvent>) =>
    checkInit({ ...init, ...patch }, expected)
      .filter((c) => !c.ok)
      .map((c) => c.id);
  assert.deepEqual(failing({ mcp_servers: [{ name: 'github' }] }), ['claude-code.init-mcp']);
  assert.deepEqual(failing({ plugins: [{ name: 'frontend-design' }] }), ['claude-code.init-plugins']);
  assert.deepEqual(failing({ skills: ['doctor', 'dataviz'] }), ['claude-code.init-skills']);
  assert.deepEqual(failing({ tools: [...TOOLS, 'WebFetch'] }), ['claude-code.init-tools']);
  assert.deepEqual(failing({ model: 'claude-other' }), ['claude-code.init-model']);
  assert.deepEqual(failing({ permissionMode: 'bypassPermissions' }), ['claude-code.init-permission-mode']);
  assert.deepEqual(checkInit(undefined, expected).map((c) => c.ok), [false]);
});

test('paths: a successful read outside the workspace fails the run; a refused one is only listed', () => {
  const exists = () => true;
  const read = (isError: boolean) =>
    parseTranscript(
      [
        event('assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${REPO}/AGENTS.md` } }]),
        event('user', [{ type: 'tool_result', tool_use_id: 't1', is_error: isError, content: isError ? 'denied' : 'secrets' }]),
        event('assistant', [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'src/App.tsx', content: 'x' } }]),
        event('user', [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }]),
      ].join('\n'),
    );
  const failed = checkPaths(read(false), WS, HOME, exists);
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /Read \/Users\/someone\/projects\/repo\/AGENTS\.md/);
  const refused = checkPaths(read(true), WS, HOME, exists);
  assert.equal(refused.ok, true);
  assert.match(refused.detail, /refused attempts outside it: Read/);
});

test('received: the canary token or a forbidden path in any tool result fails the run', () => {
  const transcript = (text: string) =>
    parseTranscript(
      [
        event('assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
        event('user', [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text }] }]),
      ].join('\n'),
    );
  assert.ok(checkReceived(transcript('README.md src'), CANARY, [REPO]).every((c) => c.ok));
  assert.deepEqual(checkReceived(transcript(`x ${CANARY}`), CANARY, [REPO]).map((c) => c.ok), [false, true]);
  assert.deepEqual(checkReceived(transcript(`see ${REPO}/README.md`), CANARY, [REPO]).map((c) => c.ok), [true, false]);
});

test('outcome: a budget stop, an error result or a missing result is not a finished session', () => {
  const result = (r: Record<string, unknown>) => parseTranscript(JSON.stringify({ type: 'result', ...r }));
  assert.deepEqual(sessionOutcome(result({ subtype: 'success', is_error: false }), 0, false), { ok: true });
  assert.equal(sessionOutcome(result({ subtype: 'error_max_budget_usd', is_error: true }), 1, false).ok, false);
  assert.equal(sessionOutcome(parseTranscript(''), 1, false).ok, false);
  assert.equal(sessionOutcome(result({ subtype: 'success' }), 0, true).ok, false);
});

test('first request: eval words, owner copy and forbidden paths fail; reviewed system prompt lines pass', () => {
  const prompt = 'Build the screen described in asset-library.md.';
  const request = (system: string, message: string) => [{ method: 'POST', path: '/v1/messages', body: { system, tools: [{ name: 'Bash' }], messages: [{ role: 'user', content: message }] } }];
  const ok = checkFirstRequest(firstRequestText(request(`You are an agent.\n${SYSTEM_PROMPT_LINES_ALLOWED[0]}\n - Tools run`, prompt)), prompt, [REPO]);
  assert.ok(ok.every((c) => c.ok), JSON.stringify(ok));
  const failing = (system: string, message: string) =>
    checkFirstRequest(firstRequestText(request(system, message)), prompt, [REPO])
      .filter((c) => !c.ok)
      .map((c) => c.id);
  assert.deepEqual(failing('You are an agent.', `${prompt}\nThis is the plain condition.`), ['claude-code.first-request-neutral']);
  assert.deepEqual(failing('You are an agent.', `${prompt}\nNo assets yet`), ['claude-code.first-request-neutral']);
  assert.deepEqual(failing(`Working in ${REPO}`, prompt), ['claude-code.first-request-paths']);
  assert.deepEqual(failing('You are an agent.', 'Build something.'), ['claude-code.first-request-prompt']);
  assert.deepEqual(failing('Harness notes', prompt), ['claude-code.first-request-neutral'], 'only the exact reviewed line is allowed');
});

const versions = { node: 'v24.19.0', pnpm: '12.21.0' };
// Results as Claude Code 2.1.326 reports them.
const proxyDenied: [string, boolean] = [
  'Exit code 56\ncurl: (56) CONNECT tunnel failed, response 403\nstatus 000\n<sandbox_violations>\ndeny network-outbound example.com:443 (user denied)\n</sandbox_violations>',
  true,
];
const directRefused: [string, boolean] = [
  "Exit code 7\n*   Trying 192.0.2.1:80...\n* Immediate connect fail for 192.0.2.1: Operation not permitted\n* Failed to connect to 192.0.2.1 port 80 after 1 ms: Couldn't connect to server\n* Closing connection\ncurl: (7) Failed to connect\nstatus 000",
  true,
];
/** Results for a probe that went as it should: everything forbidden refused, everything ordinary worked. */
const GOOD: Record<string, [string, boolean]> = {
  'network-proxy': proxyDenied,
  'network-direct': directRefused,
  'shell-works': ['v24.19.0\n12.21.0', false],
  'read-workspace': ['# Starter', false],
};
/** A transcript in which each scripted step got the given result (default: refused). */
const probeRun = (steps: ProbeStep[], texts: Record<string, [string, boolean]>, tools: Record<string, string> = {}) =>
  parseTranscript(
    steps
      .flatMap((step, i) => [
        event('assistant', [{ type: 'tool_use', id: `t${i}`, name: tools[step.id] ?? step.turn.tool, input: step.turn.input }]),
        event('user', [{ type: 'tool_result', tool_use_id: `t${i}`, is_error: texts[step.id]?.[1] ?? true, content: texts[step.id]?.[0] ?? 'denied' }]),
      ])
      .join('\n'),
  );
const failedIds = (checks: Array<{ id: string; ok: boolean }>) => checks.filter((c) => !c.ok).map((c) => c.id);
const targets = (overrides: Partial<ProbeTargets> = {}): ProbeTargets => ({
  canaryFile: '/x/shared/notes.txt',
  canaryToken: CANARY,
  canaryDir: '/x/shared/missing-dir',
  forbidden: ['/nonexistent-repo'],
  readProbes: [],
  realHome: '/nonexistent-home',
  agentTemp: '/nonexistent-temp',
  workspace: process.cwd(),
  ...overrides,
});

test('probe: a forbidden read that returns the canary, or a shell that cannot run pnpm, fails', () => {
  const steps = probeSteps(targets(), versions);
  assert.deepEqual(probeScript(steps).slice(0, -1), steps.map((s) => s.turn));
  assert.deepEqual(failedIds(judgeProbe(probeRun(steps, GOOD), steps)), []);
  assert.deepEqual(failedIds(judgeProbe(probeRun(steps, { ...GOOD, 'read-canary': [CANARY, false] }), steps)), ['claude-code.probe-read-canary']);
  assert.deepEqual(failedIds(judgeProbe(probeRun(steps, { ...GOOD, 'shell-works': ['command not found: pnpm', true] }), steps)), ['claude-code.probe-shell-works']);
  assert.deepEqual(
    failedIds(judgeProbe(probeRun(steps, GOOD, { 'read-canary': 'Glob' }), steps)),
    ['claude-code.probe-read-canary'],
    'a result for a call the probe never scripted there counts for nothing',
  );
});

test('probe: every forbidden root is globbed and listed; only a harmless file the runner named is ever read', () => {
  const root = mkdtempSync(join(tmpdir(), 'probe-roots-'));
  try {
    const repo = join(root, 'repo');
    const results = join(root, 'results');
    const config = join(root, 'config');
    mkdirSync(repo);
    mkdirSync(join(results, 'a1b2c3d4e5f6'), { recursive: true });
    mkdirSync(config);
    writeFileSync(join(repo, 'package.json'), '{}');
    writeFileSync(join(repo, 'private-notes.md'), 'x');
    const marker = { file: join(results, 'a1b2c3d4e5f6', 'isolation-marker.txt'), token: 'marker-0123456789abcdef' };
    writeFileSync(marker.file, marker.token);
    writeFileSync(join(results, 'mapping.jsonl'), '{}');
    // A config folder like ~/.claude: its first plain file holds credentials, and nothing in it was named as harmless.
    writeFileSync(join(config, 'credentials.json'), 'secret');
    const readProbes = [marker, { file: join(repo, 'package.json') }, { file: join(root, 'elsewhere.txt') }];
    const steps = probeSteps(targets({ forbidden: [repo, results, config, join(root, 'missing')], readProbes }), versions);
    const byId = new Map(steps.map((s) => [s.id, s.turn]));
    assert.deepEqual(byId.get('read-forbidden-1')?.input, { file_path: join(repo, 'package.json') });
    assert.deepEqual(byId.get('read-forbidden-2')?.input, { file_path: marker.file });
    assert.deepEqual(byId.get('glob-forbidden-2')?.input, { pattern: '*', path: results });
    assert.deepEqual(byId.get('shell-forbidden-2')?.input, { command: `ls '${results}'`, description: 'List a folder' });
    assert.ok(!byId.has('read-forbidden-3'), 'a folder with no harmless file is never read from');
    assert.ok(byId.has('glob-forbidden-3') && byId.has('shell-forbidden-3'), 'only globbed and listed, which return names, not contents');
    assert.ok(![...byId.keys()].some((id) => id.endsWith('-4')), 'a missing root has nothing to probe');
    const reads = steps.filter((s) => s.turn.tool === 'Read').map((s) => s.turn.input['file_path']);
    assert.deepEqual(reads.filter((f) => f !== '/x/shared/notes.txt' && !String(f).endsWith('README.md')), [join(repo, 'package.json'), marker.file]);

    assert.deepEqual(failedIds(judgeProbe(probeRun(steps, GOOD), steps)), []);
    const failing = (id: string, result: [string, boolean]) => failedIds(judgeProbe(probeRun(steps, { ...GOOD, [id]: result }), steps));
    assert.deepEqual(failing('shell-forbidden-2', ['a1b2c3d4e5f6\nmapping.jsonl', false]), ['claude-code.probe-shell-forbidden-2']);
    assert.deepEqual(failing('glob-forbidden-2', [join(results, 'mapping.jsonl'), false]), ['claude-code.probe-glob-forbidden-2']);
    assert.deepEqual(failing('read-forbidden-2', [marker.token, false]), ['claude-code.probe-read-forbidden-2']);
    assert.deepEqual(failing('read-forbidden-2', [`refused, but ${marker.token}`, true]), ['claude-code.probe-read-forbidden-2'], 'the token must never come back');
    assert.deepEqual(failing('shell-forbidden-1', ['package.json\nprivate-notes.md', false]), ['claude-code.probe-shell-forbidden-1']);
    assert.deepEqual(failing('glob-forbidden-3', [join(config, 'credentials.json'), false]), ['claude-code.probe-glob-forbidden-3']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('network: only a reported or OS-level denial passes; any HTTP status, a missing curl or an unexplained failure fails', () => {
  const steps = probeSteps(targets(), versions);
  const verdict = (target: string, [text, isError]: [string, boolean]) => judgeNetwork({ text, isError }, target).verdict;
  assert.equal(verdict('example.com:443', proxyDenied), 'blocked');
  assert.equal(verdict('192.0.2.1', directRefused), 'blocked');
  assert.equal(
    verdict('192.0.2.1', ['status 403\n<sandbox_violations>\ndeny network-outbound 192.0.2.1:80 (user denied)\n</sandbox_violations>', false]),
    'blocked',
    "the proxy's own 403 for a plain HTTP request, reported as a violation",
  );
  assert.equal(verdict('example.com:443', ['status 200', false]), 'reached');
  assert.equal(verdict('example.com:443', ['status 404', false]), 'reached', 'an error page is still an answer from the network');
  assert.equal(verdict('example.com:443', ['status 500', false]), 'reached');
  assert.equal(verdict('example.com:443', ['status 403', false]), 'reached', 'a 403 with no violation came from the server');
  assert.equal(verdict('example.com:443', ['Exit code 22\ncurl: (22) The requested URL returned error: 404\nstatus 404', true]), 'reached');
  assert.equal(verdict('example.com:443', ['Exit code 127\nzsh: command not found: curl', true]), 'inconclusive', 'no curl proves nothing');
  assert.equal(verdict('example.com:443', ['Exit code 6\ncurl: (6) Could not resolve host: example.com\nstatus 000', true]), 'inconclusive');
  assert.equal(verdict('192.0.2.1', ['Exit code 28\ncurl: (28) Connection timed out after 5002 milliseconds\nstatus 000', true]), 'inconclusive');
  assert.equal(verdict('192.0.2.1', ["Exit code 7\ncurl: (7) Failed to connect to 192.0.2.1 port 80 after 1 ms: Couldn't connect to server\nstatus 000", true]), 'inconclusive', 'the reason must show');
  assert.equal(
    verdict('example.com:443', ['Exit code 56\nstatus 000\n<sandbox_violations>\ndeny network-outbound other.example:443\n</sandbox_violations>', true]),
    'inconclusive',
    'a violation for another destination proves nothing about this one',
  );
  assert.equal(judgeNetwork(undefined, 'example.com:443').verdict, 'inconclusive');

  for (const id of ['network-proxy', 'network-direct']) {
    for (const result of [['status 404', false], ['Exit code 127\nzsh: command not found: curl', true]] as Array<[string, boolean]>) {
      assert.deepEqual(failedIds(judgeProbe(probeRun(steps, { ...GOOD, [id]: result }), steps)), [`claude-code.probe-${id}`], `${id}: ${result[0]}`);
    }
  }
  assert.ok(!Object.values(NETWORK_PROBES).some((p) => /-w '[^']*=/.test(p.command)), 'Claude Code refuses a curl format with "="');
});

test('the stub model replays its script for the session and records what it was sent', async () => {
  const stub = await startStubModel([{ tool: 'Read', input: { file_path: 'README.md' } }, { text: 'Done.' }], ['Read']);
  try {
    const post = (body: unknown) => fetch(`${stub.url}/v1/messages`, { method: 'POST', body: JSON.stringify(body), headers: { authorization: 'Bearer secret' } });
    const first = await (await post({ model: 'm', tools: [{ name: 'Read' }], messages: [{ role: 'user', content: 'hi' }] })).json();
    assert.equal(first.content[0].type, 'tool_use');
    assert.equal(first.stop_reason, 'tool_use');
    const streamed = await (
      await post({ model: 'm', stream: true, tools: [{ name: 'Read' }], messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [] }, { role: 'user', content: [] }] })
    ).text();
    assert.match(streamed, /event: message_start/);
    assert.match(streamed, /"text":"Done\."/);
    const side = await (await post({ model: 'm', messages: [{ role: 'user', content: 'title?' }] })).json();
    assert.equal(side.content[0].text, 'ok', 'requests without the session tools never advance the script');
    assert.equal(stub.requests.length, 3);
    assert.ok(!JSON.stringify(stub.requests).includes('secret'), 'headers are never recorded');
  } finally {
    await stub.close();
  }
});

test('when the CLI exits, nothing the session started is still running, in its process group or in one of its own', { skip: process.platform === 'darwin' ? false : 'reads other processes with macOS ps and lsof' }, async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'session-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // Starts a command in a new process group, as Claude Code runs each Bash command, holding the CLI's output open.
  const detached = ([command, ...args]: string[], pidFile: string) =>
    `node -e 'const c = require("node:child_process").spawn(${JSON.stringify(command)}, ${JSON.stringify(args)}, { detached: true, stdio: ["ignore", "inherit", "ignore"] }); console.error(c.pid); c.unref()' 2> ${pidFile}`;
  // A stand-in for the CLI, which leaves processes running and exits: one in its own process group, and two in
  // groups of their own. One of those is an Apple binary, whose environment ps doesn't show, in the workspace; the
  // other has the session's HOME, but runs elsewhere. A fourth process runs elsewhere with a HOME that only starts
  // like the session's: it isn't the session's, so it's left running, and the output it holds is cut off.
  const script = [
    'sleep 60 & echo $! > in-group.pid',
    detached(['sleep', '61'], 'in-workspace.pid'),
    `cd / && ${detached([process.execPath, '-e', 'setInterval(() => {}, 1000)'], `${dir}/elsewhere.pid`)}`,
    `HOME=${home}-other ${detached(['sleep', '62'], `${dir}/other.pid`)}`,
  ].join('\n');
  const pid = (file: string) => Number(readFileSync(join(dir, file), 'utf8').trim());
  try {
    const started = Date.now();
    const run = await runSession(
      '/bin/sh',
      { args: ['-c', script], env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home }, settings: {} },
      dir,
      '',
      { transcript: join(dir, 'transcript.jsonl'), stderr: join(dir, 'stderr.log') },
      60_000,
    );
    assert.ok(Date.now() - started < 8_000, `returned after ${Date.now() - started} ms`);
    assert.equal(run.exitCode, 0);
    assert.deepEqual(run.leftovers.remaining, []);
    const gone = ['in-group.pid', 'in-workspace.pid', 'elsewhere.pid'].map(pid);
    for (const p of gone.slice(1)) assert.ok(run.leftovers.stopped.some((s) => s.startsWith(`${p} `)), `${p} in ${run.leftovers.stopped.join('; ')}`);
    for (let i = 0; i < 20 && gone.some(alive); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(gone.filter(alive), [], 'nothing the session started is still running');
    assert.equal(alive(pid('other.pid')), true, 'a process that is not the session\'s is left alone');
  } finally {
    try {
      process.kill(pid('other.pid'), 'SIGKILL');
    } catch {
      // Already gone.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

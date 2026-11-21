// The Claude Code adapter's isolation checks, each shown to fail on the
// evidence it exists to catch, plus the invocation and the stub model.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { leakIn } from '../../starter/src/leaks.ts';
import {
  checkFirstRequest,
  checkStopped,
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
import { watchShells } from '../claude-code/leftovers.ts';
import { startStubModel } from '../claude-code/stub-model.ts';
import { checkInit, checkPaths, checkReceived, outsidePaths, parseTranscript, sessionOutcome, simpleCommands, type InitEvent } from '../claude-code/transcript.ts';

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
  assert.equal(env['CLAUDE_CODE_SHELL'], `${input.stateDir}/shell/zsh`, 'shells start through the wrapper that checks them in');
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

test("shell commands: here-document bodies, division and the session's own folders are not paths it reached", () => {
  const exists = (p: string) => p === '/' || p.startsWith('/Users/someone') || p.startsWith('/private/var/folders/aa/T');
  const heredoc = `cat > src/format.ts <<'EOF'\nconst kb = bytes / 1024;\nconst file = '/Users/someone/notes.txt';\nEOF\ncat ${REPO}/AGENTS.md`;
  assert.deepEqual(outsidePaths(heredoc, WS, HOME, exists), [`${REPO}/AGENTS.md`], 'the body is skipped; a path after it is still caught');
  assert.deepEqual(outsidePaths(`cat <<-"END"\n\t/Users/someone/x\n\tEND\nls /Users/someone`, WS, HOME, exists), ['/Users/someone']);
  assert.deepEqual(outsidePaths('node -e "console.log(6 / 3)"', WS, HOME, exists), [], 'a lone slash is division');
  assert.deepEqual(outsidePaths('cat <<< /Users/someone/x', WS, HOME, exists), ['/Users/someone/x'], 'a here-string is not a here-document');
  const tmp = '/private/var/folders/aa/T/work-x/state/tmp';
  assert.deepEqual(outsidePaths(`cat ${tmp}/preview.log`, WS, HOME, exists, [tmp]), [], "the session's temp folder is its own");
  assert.deepEqual(outsidePaths(`cat ${tmp}/preview.log`, WS, HOME, exists), [`${tmp}/preview.log`]);
  assert.deepEqual(outsidePaths('ls ~ | head -0; ls ~/Library/Caches/ms-playwright', WS, HOME, exists, [HOME, tmp]), [], "and so is its own home");
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

test('shell commands: cd moves where later relative paths start, within a command and across commands', () => {
  const exists = (p: string) => p === '/private/var/folders/aa' || p.startsWith('/Users/someone') || p.startsWith(WS);
  // The command from the frontend-design run that was flagged: it went into a package and came back.
  const back = "cd node_modules/@phosphor-icons/react && ls; for n in X Trash; do ls dist/csr/$n.d.ts >/dev/null 2>&1; done; cd ../../..; sed -n 1,40p tools/mock-api/thumbnails.ts";
  assert.deepEqual(outsidePaths(back, WS, HOME, exists), []);
  assert.deepEqual(outsidePaths('cd src && cat ../package.json', WS, HOME, exists), [], "a parent of src is the workspace");
  assert.deepEqual(outsidePaths(`cd ${REPO} && cat AGENTS.md`, WS, HOME, exists), [`${REPO}/AGENTS.md`], 'a relative path after cd outside is caught');
  assert.deepEqual(outsidePaths('cd ../../.. && ls', WS, HOME, exists), [], 'a cd alone reads nothing');
  assert.deepEqual(outsidePaths('cd .. ; cat ../../../aa', WS, HOME, exists), ['/private/var/folders/aa']);
  assert.deepEqual(simpleCommands('echo "a; cd /elsewhere" && cat x'), ['echo "a; cd /elsewhere"', 'cat x'], 'a cd inside quotes is not a cd');
  assert.deepEqual(simpleCommands('a && b || c | d; (cd x && e)\nf "g; h" \'i && j\''), ['a', 'b', 'c', 'd', 'cd x', 'e)', 'f "g; h" \'i && j\'']);

  const calls = (...commands: string[]) =>
    parseTranscript(
      commands
        .flatMap((command, i) => [
          event('assistant', [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command } }]),
          event('user', [{ type: 'tool_result', tool_use_id: `t${i}`, is_error: false, content: 'ok' }]),
        ])
        .join('\n'),
    );
  assert.equal(checkPaths(calls('cd src', 'cat ../package.json'), WS, HOME, exists).ok, true, 'the folder carries to the next command');
  assert.equal(checkPaths(calls(`cd ${REPO}`, 'cat ../package.json'), WS, HOME, exists).ok, true, 'a folder outside the workspace does not carry over');
  assert.equal(checkPaths(calls(`cd ${REPO} && cat AGENTS.md`), WS, HOME, exists).ok, false);
});

test('paths: a path the sandbox denies counts as refused even when the command as a whole succeeded', () => {
  const exists = () => true;
  const bash = (command: string) =>
    parseTranscript(
      [
        event('assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }]),
        event('user', [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'chromium not found' }]),
      ].join('\n'),
    );
  const sandbox = { deny: ['/Applications', HOME], allow: [`${HOME}/.nvm`] };
  const listed = checkPaths(bash('ls "/Applications" 2>&1 | grep -i chrome; which chromium'), WS, HOME, exists, [], sandbox);
  assert.equal(listed.ok, true, listed.detail);
  assert.match(listed.detail, /refused attempts outside it: Bash \/Applications/);
  assert.equal(checkPaths(bash('ls "/Applications"; true'), WS, HOME, exists).ok, false, 'without the sandbox settings it counts');
  assert.equal(checkPaths(bash(`ls ${HOME}/.nvm/versions; true`), WS, HOME, exists, [], sandbox).ok, false, 'a re-allowed path still counts');
  assert.equal(checkPaths(bash('ls /Library/Fonts; true'), WS, HOME, exists, [], sandbox).ok, false, 'a path the sandbox allows still counts');
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
  'shell-temp': ['heredoc ok\nbackground ok', false],
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
  hostRoots: [],
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
  for (const broken of [
    ["(eval):1: can't create temp file for here document: operation not permitted\nbackground ok", true],
    ['checkin:1: nice(5) failed: operation not permitted\nheredoc ok\nbackground ok', false],
  ] as Array<[string, boolean]>) {
    assert.deepEqual(failedIds(judgeProbe(probeRun(steps, { ...GOOD, 'shell-temp': broken }), steps)), ['claude-code.probe-shell-temp'], broken[0]);
  }
  assert.deepEqual(
    failedIds(judgeProbe(probeRun(steps, GOOD, { 'read-canary': 'Glob' }), steps)),
    ['claude-code.probe-read-canary'],
    'a result for a call the probe never scripted there counts for nothing',
  );
});

test('probe: a host folder such as /Applications must list nothing', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'host-root-'));
  try {
    mkdirSync(join(root, 'Some Browser.app'));
    const steps = probeSteps(targets({ hostRoots: [root] }), versions);
    assert.ok(steps.some((s) => s.id === 'shell-host-1'));
    assert.deepEqual(failedIds(judgeProbe(probeRun(steps, GOOD), steps)), [], 'a refused listing passes');
    const listed = probeRun(steps, { ...GOOD, 'shell-host-1': ['Some Browser.app', false] });
    assert.deepEqual(failedIds(judgeProbe(listed, steps)), ['claude-code.probe-shell-host-1']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test('when the CLI exits, what is shown to be the session\'s is stopped, and only that', { skip: process.platform === 'darwin' ? false : 'reads other processes with macOS ps and lsof' }, async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'session-'));
  const home = join(dir, 'home');
  const shell = join(dir, 'state', 'shell', 'zsh');
  mkdirSync(home);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // start.cjs starts a command in a session (and process group) of its own, as Claude Code starts each shell, and
  // writes its PID. With "wait" it stays until the command exits, as the CLI does for a shell; with "hold" it leaves
  // the command holding the CLI's output open.
  writeFileSync(join(dir, 'start.cjs'), `const [pidFile, how, command, ...args] = process.argv.slice(2);
const c = require('node:child_process').spawn(command, args, { detached: true, stdio: ['ignore', how === 'hold' ? 'inherit' : 'ignore', 'ignore'] });
require('node:fs').writeFileSync(pidFile, String(c.pid));
if (how !== 'wait') c.unref();`);
  // leave.cjs starts an Apple binary, whose environment ps doesn't show, in its own process group, and keeps running.
  writeFileSync(join(dir, 'leave.cjs'), `const c = require('node:child_process').spawn('sleep', ['61'], { stdio: 'ignore' });
require('node:fs').writeFileSync('child.pid', String(c.pid));
require('node:fs').writeFileSync('parent.pid', String(process.pid));
setInterval(() => {}, 1000);`);
  // orphan.cjs waits until its shell has checked in for the last time, starts sleep in its own process group, and
  // exits, so nothing the runner saw is left alive in that group.
  writeFileSync(join(dir, 'orphan.cjs'), `setTimeout(() => {
  const c = require('node:child_process').spawn('sleep', ['64'], { stdio: 'ignore' });
  require('node:fs').writeFileSync('orphan.pid', String(c.pid));
  c.unref();
}, 1000);`);
  const register = join(dir, 'state', 'shell', 'register');
  // A stand-in for the CLI, which leaves processes running and exits:
  // - in-group: in the CLI's own process group
  // - parent and child: left by a command run through the shell, in the shell's process group
  // - orphan: left in another shell's process group, but started after the shell's last check-in, by a process that
  //   has exited since. That group can't be shown to be the same group any more: reported and left running.
  // - diagnostic: started on its own, not through the shell, with the session's HOME, in the workspace, and checked
  //   in as if it were a shell. It isn't shown to be the session's: reported and left running.
  // - outside: another HOME, outside the session's folders, holding the output open. Not the session's: left alone,
  //   and the output it holds is cut off.
  const script = [
    'sleep 60 & echo $! > in-group.pid',
    `node start.cjs shell.pid wait "$CLAUDE_CODE_SHELL" -c 'node leave.cjs > /dev/null 2>&1 &'`,
    'until [ -s child.pid ]; do sleep 0.1; done',
    `node start.cjs orphan-shell.pid wait "$CLAUDE_CODE_SHELL" -c 'node orphan.cjs > /dev/null 2>&1 &'`,
    'until [ -s orphan.pid ]; do sleep 0.1; done',
    `node start.cjs diagnostic.pid - node -e 'setInterval(() => {}, 1000)'`,
    `echo "$(cat diagnostic.pid) $(cat diagnostic.pid)" >> ${register}`,
    `cd / && HOME=${home}-other node ${join(dir, 'start.cjs')} ${join(dir, 'outside.pid')} hold sleep 63`,
  ].join('\n');
  const pid = (file: string) => Number(readFileSync(join(dir, file), 'utf8').trim());
  try {
    const started = Date.now();
    // A time limit the CLI itself stays well within, though the cleanup after it doesn't.
    const run = await runSession(
      '/bin/sh',
      { args: ['-c', script], env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: dir, CLAUDE_CODE_SHELL: shell }, settings: {} },
      dir,
      '',
      { transcript: join(dir, 'transcript.jsonl'), stderr: join(dir, 'stderr.log') },
      5_000,
    );
    assert.ok(Date.now() - started > 5_000 && Date.now() - started < 15_000, `returned after ${Date.now() - started} ms`);
    assert.equal(run.exitCode, 0);
    assert.equal(run.timedOut, false, 'the time limit stops applying when the CLI exits');
    assert.deepEqual(run.leftovers.remaining, []);
    for (const p of [pid('parent.pid'), pid('child.pid')]) assert.ok(run.leftovers.stopped.some((s) => s.startsWith(`${p} `)), `${p} in ${run.leftovers.stopped.join('; ')}`);
    assert.deepEqual(run.leftovers.unverified.sort(), [`${pid('diagnostic.pid')} node -e setInterval(() => {}, 1000)`, `${pid('orphan.pid')} sleep 64`].sort());
    const gone = ['in-group.pid', 'parent.pid', 'child.pid'].map(pid);
    for (let i = 0; i < 20 && gone.some(alive); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(gone.filter(alive), [], 'nothing shown to be the session\'s is still running');
    assert.equal(alive(pid('orphan.pid')), true, 'a process in a group that can\'t be shown to be the same any more is left running');
    assert.equal(alive(pid('diagnostic.pid')), true, 'a process with the session\'s HOME, started elsewhere, is left running');
    assert.equal(alive(pid('outside.pid')), true, 'a process that is not the session\'s is left alone');
    const check = checkStopped('claude-code.session-stopped', run.leftovers);
    assert.equal(check.ok, false, 'a process that may be the session\'s, left running, fails the check');
    assert.match(check.detail, /not shown to be the session's, so left running: /);
  } finally {
    for (const file of ['diagnostic.pid', 'outside.pid', 'orphan.pid']) {
      try {
        process.kill(pid(file), 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the shell wrapper is set up only in a folder of its own, never through one that is already there', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'shells-'));
  try {
    mkdirSync(join(dir, 'host'));
    mkdirSync(join(dir, 'state'));
    symlinkSync(join(dir, 'host'), join(dir, 'state', 'shell'));
    assert.throws(() => watchShells(join(dir, 'state', 'shell', 'zsh'), join(dir, 'state', 'tmp'), () => undefined, () => undefined), /EEXIST/);
    assert.deepEqual(readdirSync(join(dir, 'host')), [], 'nothing is written through the link');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a shell that can\'t be checked in ends the session the usual way: the CLI is stopped and the session fails', { skip: process.platform === 'darwin' ? false : 'checks shells in with macOS ps' }, async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'session-'));
  mkdirSync(join(dir, 'home'));
  mkdirSync(join(dir, 'bin'));
  // A ps that fails, as one that timed out would.
  writeFileSync(join(dir, 'bin', 'ps'), '#!/bin/sh\necho "ps: failed" >&2\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(dir, 'start.cjs'), `const [pidFile, command, ...args] = process.argv.slice(2);
const c = require('node:child_process').spawn(command, args, { detached: true, stdio: 'ignore' });
require('node:fs').writeFileSync(pidFile, String(c.pid));`);
  const pid = (file: string) => Number(readFileSync(join(dir, file), 'utf8').trim());
  const alive = (p: number) => {
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  };
  // A stand-in for the CLI that starts a shell the way Claude Code does, then would go on for a while.
  const script = ['echo $$ > cli.pid', `node start.cjs shell.pid "$CLAUDE_CODE_SHELL" -c true`, 'sleep 30'].join('\n');
  const path = process.env['PATH'];
  process.env['PATH'] = `${join(dir, 'bin')}:${path}`;
  try {
    const started = Date.now();
    await assert.rejects(
      runSession(
        '/bin/sh',
        { args: ['-c', script], env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(dir, 'home'), TMPDIR: dir, CLAUDE_CODE_SHELL: join(dir, 'state', 'shell', 'zsh') }, settings: {} },
        dir,
        '',
        { transcript: join(dir, 'transcript.jsonl'), stderr: join(dir, 'stderr.log') },
        60_000,
      ),
      /could not check a shell in: Command failed: ps/,
    );
    assert.ok(Date.now() - started < 10_000, `failed after ${Date.now() - started} ms`);
    assert.equal(alive(pid('cli.pid')), false, 'the CLI was stopped');
  } finally {
    process.env['PATH'] = path;
    try {
      // The shell itself, in a process group of its own, still waiting to check in.
      process.kill(-pid('shell.pid'), 'SIGKILL');
    } catch {
      // Already gone.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

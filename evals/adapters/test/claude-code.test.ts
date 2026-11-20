// The Claude Code adapter's isolation checks, each shown to fail on the
// evidence it exists to catch, plus the invocation and the stub model.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { leakIn } from '../../starter/src/leaks.ts';
import { checkFirstRequest, firstRequestText, judgeProbe, probeScript, SYSTEM_PROMPT_LINES_ALLOWED } from '../claude-code/index.ts';
import { buildInvocation, redacted, TOOLS, type InvocationInput } from '../claude-code/invocation.ts';
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

test('probe: a forbidden read that returns the canary, or a shell that cannot run pnpm, fails', () => {
  const targets = {
    canaryFile: '/x/shared/notes.txt',
    canaryToken: CANARY,
    canaryDir: '/x/shared/missing-dir',
    repoFile: '/nonexistent/package.json',
    repoDir: '/nonexistent-repo',
    realHome: '/nonexistent-home',
    agentTemp: '/nonexistent-temp',
    workspace: process.cwd(),
  };
  const script = probeScript(targets);
  const results = (texts: Record<number, [string, boolean]>) =>
    parseTranscript(
      script
        .flatMap((turn, i) =>
          'tool' in turn
            ? [
                event('assistant', [{ type: 'tool_use', id: `t${i}`, name: turn.tool, input: turn.input }]),
                event('user', [{ type: 'tool_result', tool_use_id: `t${i}`, is_error: texts[i]?.[1] ?? true, content: texts[i]?.[0] ?? 'denied' }]),
              ]
            : [],
        )
        .join('\n'),
    );
  const versions = { node: 'v24.19.0', pnpm: '12.21.0' };
  const good = { 9: ['v24.19.0\n12.21.0', false], 10: ['# Starter', false] } as Record<number, [string, boolean]>;
  const passing = judgeProbe(results(good), targets, versions);
  assert.ok(passing.every((c) => c.ok), JSON.stringify(passing.filter((c) => !c.ok)));
  const leaked = judgeProbe(results({ ...good, 0: [CANARY, false] }), targets, versions);
  assert.deepEqual(leaked.filter((c) => !c.ok).map((c) => c.id), ['claude-code.probe-read-canary']);
  for (const status of ['200', '403', '503']) {
    const network = judgeProbe(results({ ...good, 8: [status, false] }), targets, versions);
    assert.deepEqual(network.filter((c) => !c.ok).map((c) => c.id), ['claude-code.probe-network']);
  }
  const noShell = judgeProbe(results({ ...good, 9: ['command not found: pnpm', true] }), targets, versions);
  assert.deepEqual(noShell.filter((c) => !c.ok).map((c) => c.id), ['claude-code.probe-shell-works']);
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

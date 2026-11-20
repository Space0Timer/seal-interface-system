// Usage:
//   node src/cli.ts run --brief asset-library --condition plain --adapter <name>
//     [--model <id>] [--effort <level>] [--max-budget-usd <n>] [--timeout-minutes <n>]
//     [--project <name> ...] [--results-dir <dir>]
//
// Adapters:
//   fake               copies the conformance app; no model calls
//   claude-code-stub   the real Claude Code CLI, isolated, against a local stub
//                      model that answers without calling the API; no cost
//   claude-code        the real Claude Code CLI, isolated; calls the model
//                      (needs --model, --max-budget-usd and CLAUDE_CODE_OAUTH_TOKEN)
import { parseArgs } from 'node:util';
import { claudeCodeAdapter } from '../../adapters/claude-code/index.ts';
import { fakeAdapter } from '../../adapters/fake/index.ts';
import type { Adapter } from '../../adapters/types.ts';
import { exportReview } from './review.ts';
import { RESULTS, runEval } from './run.ts';

const ADAPTERS: Record<string, () => Adapter> = {
  fake: () => fakeAdapter(),
  'claude-code-stub': () => claudeCodeAdapter({ stubModel: true }),
  'claude-code': () => claudeCodeAdapter(),
};

const usage = `usage: cli.ts run --brief <name> --condition <name> --adapter <${Object.keys(ADAPTERS).join('|')}> [--model <id>] [--effort <level>] [--max-budget-usd <n>] [--timeout-minutes <n>] [--project <name> ...] [--results-dir <dir>]`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    brief: { type: 'string', default: 'asset-library' },
    condition: { type: 'string' },
    adapter: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    'max-budget-usd': { type: 'string' },
    'timeout-minutes': { type: 'string' },
    project: { type: 'string', multiple: true },
    'results-dir': { type: 'string' },
    out: { type: 'string' },
  },
});

if (positionals[0] === 'export-review') {
  if (!values.out || positionals.length < 2) {
    console.error('usage: cli.ts export-review --out <new-dir> [--results-dir <dir>] <run-id> ...');
    process.exit(2);
  }
  const { packet, mapping } = exportReview(values['results-dir'] ?? RESULTS, values.out, positionals.slice(1));
  console.log(`Reviewer packet: ${packet}\nPrivate alias mapping: ${mapping}`);
  process.exit(0);
}

if (positionals[0] !== 'run' || !values.condition || !values.adapter) {
  console.error(usage);
  process.exit(2);
}
const makeAdapter = ADAPTERS[values.adapter];
if (!makeAdapter) {
  console.error(`unknown adapter "${values.adapter}"\n${usage}`);
  process.exit(2);
}
const number = (flag: string, value: string | undefined) => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`${flag} must be a positive number`);
    process.exit(2);
  }
  return n;
};

const controller = new AbortController();
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.error(`\n${signal}: stopping the run and cleaning up (send again to quit at once)…`);
    controller.abort();
  });
}

const timeout = number('--timeout-minutes', values['timeout-minutes']);
const manifest = await runEval({
  brief: values.brief,
  condition: values.condition,
  adapter: makeAdapter(),
  model: values.model,
  effort: values.effort,
  maxBudgetUsd: number('--max-budget-usd', values['max-budget-usd']),
  timeoutMs: timeout ? timeout * 60_000 : undefined,
  projects: values.project,
  resultsRoot: values['results-dir'],
  signal: controller.signal,
});

const t = manifest.tests;
console.log(
  [
    `run ${manifest.runId}: ${manifest.status}`,
    `isolation: ${manifest.isolation.ok ? 'ok' : 'FAILED'}`,
    `build: ${manifest.build ? (manifest.build.ok ? 'ok' : 'FAILED') : 'not run'}`,
    `tests: ${t ? `${t.passed} passed, ${t.failed} failed, ${t.flaky} flaky, ${t.skipped} skipped` : 'not run'}`,
    `screenshots: ${manifest.screenshots ? `${manifest.screenshots.saved.length} of ${manifest.screenshots.expected.length}` : 'not taken'}`,
  ].join('\n'),
);
process.exit(manifest.status === 'complete' ? 0 : 1);

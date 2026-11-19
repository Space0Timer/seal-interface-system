// Runs one condition end to end: assemble a workspace outside the repo, let
// the adapter's agent build the brief in it, copy the output, build it,
// serve it, run the shared behavior tests, take screenshots, and record
// everything in evals/results/<run-id>/. The temp workspace is deleted
// afterwards, also when a step fails.
//
// Agent-independent: everything agent-specific is in the adapter.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Adapter, GenerateResult, IsolationCheck } from '../../adapters/types.ts';
import { materialize, REPO } from '../../starter/src/materialize.ts';
import { startPreview, type Preview } from '../../starter/src/preview.ts';
import { checkOutside, checkPrompt, checkWorkspacePath, scanWorkspace } from './checks.ts';
import { conditionNamed } from './conditions.ts';
import { copyFiles, diff, hashEntry, hashTree, sha256, snapshot, walk } from './files.ts';
import { PROMPT_FILE, renderPrompt } from './prompt.ts';
import { summarizeReport, type TestSummary } from './report.ts';

export const RESULTS = join(REPO, 'evals', 'results');
const TESTS = join(REPO, 'evals', 'tests');
const RUNNER = join(REPO, 'evals', 'runner');
const BRIEF_STATES: Record<string, string[]> = {
  'asset-library': ['populated', 'large-library', 'empty', 'no-results', 'multi-select', 'partial-upload-failure'],
};
const ALL_PROJECTS = ['desktop-light', 'desktop-dark', 'mobile-light', 'mobile-dark'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** What the workspace snapshot skips: dependencies and build output, which the generator doesn't author. */
const SNAPSHOT_SKIP = { skipAnywhere: ['node_modules', '.git'], skipPaths: ['dist', '.vite'] };

export interface RunOptions {
  brief: string;
  condition: string;
  adapter: Adapter;
  model?: string | undefined;
  /** Reasoning effort, passed to the agent. Unset: the agent's default. */
  effort?: string | undefined;
  maxBudgetUsd?: number | undefined;
  /** Generation time limit. Default 90 minutes. */
  timeoutMs?: number | undefined;
  /** Default evals/results. Tests use a temp folder. */
  resultsRoot?: string | undefined;
  /** Test and screenshot projects. Default all four. */
  projects?: string[] | undefined;
  log?: ((line: string) => void) | undefined;
  /** Aborts the run (for example on Ctrl-C). The temp workspace is still deleted. */
  signal?: AbortSignal | undefined;
}

export type RunStatus = 'complete' | 'invalid' | 'error';

export interface Step {
  startedAt: string;
  ms: number;
}

export interface Manifest {
  runId: string;
  status: RunStatus;
  error?: string | undefined;
  brief: string;
  condition: string;
  adapter: string;
  model: string | null;
  effort: string | null;
  startedAt: string;
  finishedAt?: string;
  versions: { node: string; pnpm: string; playwright: string | null; agent: string | null };
  hashes: { skill: string | null; starter: string | null; brief: string; prompt: string };
  prompt: string;
  /** The temp workspace, deleted after the run. Recorded so its removal can be checked. */
  workspace: string | null;
  timings: Record<string, Step>;
  isolation: { ok: boolean; checks: IsolationCheck[]; settings?: Record<string, unknown> | undefined };
  generation: Omit<GenerateResult, 'isolation' | 'settings'> | null;
  output: { dir: string; copied: string[]; added: string[]; changed: string[]; deleted: string[]; links: Array<{ path: string; target: string }> } | null;
  /** Brief completion: a failed build is recorded, never fixed. */
  build: { ok: boolean; exitCode: number | null; log: string } | null;
  preview: { url: string; log: string } | null;
  tests: (TestSummary & { report: string; log: string; touchTargets: string[] }) | null;
  screenshots: { expected: string[]; saved: string[]; missing: Array<{ file: string; reason: string }>; report: string } | null;
  tokenLint: { status: 'not-applicable' | 'not-built-yet' };
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

function tool(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function playwrightVersion(): string | null {
  try {
    const pkg = join(TESTS, 'node_modules', '@playwright', 'test', 'package.json');
    return (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version;
  } catch {
    return null;
  }
}

/** This checkout and, from a worktree, the main checkout it belongs to. */
function repoRoots(): string[] {
  const roots = [realpathSync(REPO)];
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: REPO, encoding: 'utf8' }).trim();
    roots.push(realpathSync(dirname(common)));
  } catch {
    // Not a git checkout: this folder is the only root.
  }
  return [...new Set(roots)];
}

/** Runs a command to completion, capturing its output in a log file. Aborts with the run. */
function runLogged(
  command: string,
  args: string[],
  { cwd, env, logFile, signal }: { cwd: string; env?: NodeJS.ProcessEnv; logFile: string; signal?: AbortSignal | undefined },
): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    };
    signal?.addEventListener('abort', kill, { once: true });
    child.once('error', reject);
    child.once('close', (code) => {
      signal?.removeEventListener('abort', kill);
      writeFileSync(logFile, output);
      resolvePromise(code);
    });
  });
}

export async function runEval(options: RunOptions): Promise<Manifest> {
  const { brief, adapter, model, effort, maxBudgetUsd, signal } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const projects = options.projects ?? ALL_PROJECTS;

  // Check every input before creating anything.
  const condition = conditionNamed(options.condition);
  const states = BRIEF_STATES[brief];
  if (!states) throw new Error(`no screenshot states for brief "${brief}"`);
  const unknownProjects = projects.filter((p) => !ALL_PROJECTS.includes(p));
  if (unknownProjects.length) throw new Error(`unknown projects: ${unknownProjects.join(', ')}`);
  if (effort && !EFFORTS.includes(effort)) throw new Error(`effort must be one of ${EFFORTS.join(', ')}`);
  if (adapter.live && !model) throw new Error(`the ${adapter.name} adapter calls a model: pass an exact model ID`);
  if (adapter.live && !(maxBudgetUsd && maxBudgetUsd > 0)) throw new Error(`the ${adapter.name} adapter calls a model: pass a spending cap`);
  const briefPath = join(REPO, 'evals', 'briefs', `${brief}.md`);
  if (!existsSync(briefPath)) throw new Error(`no brief named "${brief}"`);
  const prompt = renderPrompt(brief);
  adapter.check?.();

  const resultsRoot = resolve(options.resultsRoot ?? RESULTS);
  mkdirSync(resultsRoot, { recursive: true });
  const runId = randomBytes(6).toString('hex');
  const out = join(resultsRoot, runId);
  mkdirSync(out);
  // The run-ID → condition mapping lives apart from the run folders, so they can be handed out blinded.
  appendFileSync(
    join(resultsRoot, 'mapping.jsonl'),
    `${JSON.stringify({ runId, brief, condition: condition.name, adapter: adapter.name, model: model ?? null, effort: effort ?? null, startedAt: new Date().toISOString() })}\n`,
  );
  writeFileSync(join(out, 'prompt.md'), `${prompt}\n`);

  const manifest: Manifest = {
    runId,
    status: 'error',
    brief,
    condition: condition.name,
    adapter: adapter.name,
    model: model ?? null,
    effort: effort ?? null,
    startedAt: new Date().toISOString(),
    versions: { node: process.version, pnpm: tool('pnpm', ['--version']), playwright: playwrightVersion(), agent: adapter.version() ?? null },
    hashes: {
      skill: condition.skill ? hashTree(join(REPO, condition.skill.from)) : null,
      starter: null,
      brief: hashEntry(briefPath),
      prompt: sha256(readFileSync(PROMPT_FILE)),
    },
    prompt,
    workspace: null,
    timings: {},
    isolation: { ok: false, checks: [] },
    generation: null,
    output: null,
    build: null,
    preview: null,
    tests: null,
    screenshots: null,
    tokenLint: { status: condition.tokenLint ? 'not-built-yet' : 'not-applicable' },
    files: [],
  };

  const step = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
    if (signal?.aborted) throw new Error('the run was aborted');
    log(`[${runId}] ${name}…`);
    const started = Date.now();
    try {
      return await fn();
    } finally {
      manifest.timings[name] = { startedAt: new Date(started).toISOString(), ms: Date.now() - started };
    }
  };

  // The temp folder: the workspace, a canary just outside it, and the adapter's private state.
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'work-'));
  const workspace = join(scratch, 'app');
  manifest.workspace = workspace;
  let server: Preview | undefined;

  try {
    const forbiddenPaths = [...repoRoots(), realpathSync(resultsRoot), join(homedir(), '.claude')];
    const skillDir = condition.skill ? adapter.skillDir(condition.skill.name) : undefined;

    await step('materialize', () =>
      materialize({ out: workspace, brief, guidance: condition.skill && skillDir ? { from: condition.skill.from, to: skillDir } : undefined }),
    );
    manifest.hashes.starter = hashTree(workspace, { skipAnywhere: ['node_modules'], skipPaths: skillDir ? [skillDir] : [] });
    const canary = { file: join(scratch, 'shared', 'notes.txt'), token: `note-${randomBytes(16).toString('hex')}` };
    mkdirSync(dirname(canary.file));
    writeFileSync(canary.file, `${canary.token}\n`);
    const stateDir = join(scratch, 'state');
    mkdirSync(stateDir);

    const checks: IsolationCheck[] = [
      checkOutside(workspace, forbiddenPaths),
      checkWorkspacePath(workspace),
      checkPrompt(prompt, forbiddenPaths),
      scanWorkspace(workspace, { guidanceDir: skillDir, forbiddenPaths }),
    ];
    const before = snapshot(workspace, SNAPSHOT_SKIP);

    // 2. Generate.
    const logDir = join(out, 'generation');
    mkdirSync(logDir);
    const generated = await step('generate', () =>
      adapter.generate(workspace, prompt, {
        model,
        effort,
        logDir,
        stateDir,
        canary,
        forbiddenPaths,
        skill: condition.skill && skillDir ? { name: condition.skill.name, dir: skillDir } : undefined,
        maxBudgetUsd,
        timeoutMs: options.timeoutMs ?? 90 * 60_000,
        signal,
      }),
    );
    const { isolation: adapterChecks, settings, ...generation } = generated;
    manifest.generation = generation;

    // 3. Copy the output exactly as the generator left it.
    const after = snapshot(workspace, SNAPSHOT_SKIP);
    const changes = diff(before, after);
    const toCopy = [...new Set([...[...after.keys()].filter((rel) => rel.startsWith('src/')), ...changes.added, ...changes.changed])].sort();
    const outputDir = join(out, 'output');
    const copied = await step('copy-output', () => copyFiles(workspace, outputDir, toCopy));
    manifest.output = { dir: 'output', ...copied, ...changes };

    // The canary's token must not have travelled into the workspace either.
    const carried = toCopy.filter((rel) => lstatSync(join(workspace, rel)).isFile() && readFileSync(join(workspace, rel)).includes(canary.token));
    checks.push({
      id: 'runner.canary-absent',
      ok: carried.length === 0,
      detail: carried.length ? `the canary's token is in ${carried.join(', ')}` : 'the canary token is in no file the generator wrote',
    });
    checks.push(...adapterChecks);
    manifest.isolation = { ok: checks.every((c) => c.ok), checks, settings };
    if (!manifest.isolation.ok) {
      manifest.status = 'invalid';
      manifest.error = `isolation failed: ${checks.filter((c) => !c.ok).map((c) => c.id).join(', ')}`;
      return manifest;
    }

    // 4. Build. A failure is a brief-completion failure, recorded and never fixed.
    const buildLog = join(out, 'build.log');
    const buildCode = await step('build', () => runLogged('pnpm', ['build'], { cwd: workspace, logFile: buildLog, signal }));
    manifest.build = { ok: buildCode === 0, exitCode: buildCode, log: 'build.log' };

    if (manifest.build.ok) {
      // 5. Serve the build with this workspace's own preview server.
      const preview = await step('serve', () => startPreview(workspace));
      server = preview;
      manifest.preview = { url: preview.url, log: 'preview.log' };
      const serverAlive = (when: string) => {
        if (preview.gone()) throw new Error(`the workspace's vite preview exited ${when}:\n${preview.output()}`);
      };

      // 6. The shared behavior tests.
      const testsDir = join(out, 'tests');
      mkdirSync(testsDir);
      const projectArgs = projects.flatMap((p) => ['--project', p]);
      await step('tests', () =>
        runLogged('pnpm', ['exec', 'playwright', 'test', ...projectArgs, '--reporter=list,json', '--output', join(testsDir, 'artifacts')], {
          cwd: TESTS,
          env: { ...process.env, EVAL_BASE_URL: preview.url, PLAYWRIGHT_JSON_OUTPUT_FILE: join(testsDir, 'report.json') },
          logFile: join(testsDir, 'output.log'),
          signal,
        }),
      );
      serverAlive('during the tests');
      const touchTargets = existsSync(join(testsDir, 'artifacts'))
        ? walk(join(testsDir, 'artifacts'))
            .filter((rel) => rel.endsWith('/touch-targets.json'))
            .map((rel) => `tests/artifacts/${rel}`)
        : [];
      manifest.tests = { ...summarizeReport(join(testsDir, 'report.json')), report: 'tests/report.json', log: 'tests/output.log', touchTargets };

      // 7. Screenshots of every state, in every project.
      const shotsDir = join(out, 'screenshots');
      mkdirSync(shotsDir);
      await step('screenshots', () =>
        runLogged('pnpm', ['exec', 'playwright', 'test', ...projectArgs, '--reporter=list,json', '--output', join(scratch, 'screenshot-artifacts')], {
          cwd: RUNNER,
          env: {
            ...process.env,
            EVAL_BASE_URL: preview.url,
            EVAL_BRIEF: brief,
            EVAL_SCREENSHOT_DIR: shotsDir,
            PLAYWRIGHT_JSON_OUTPUT_FILE: join(shotsDir, 'report.json'),
          },
          logFile: join(shotsDir, 'output.log'),
          signal,
        }),
      );
      serverAlive('during the screenshots');
      const expected = projects.flatMap((p) => states.map((s) => `screenshots/${p}/${s}.png`));
      const saved = expected.filter((rel) => existsSync(join(out, rel)));
      const failures = summarizeReport(join(shotsDir, 'report.json')).failures;
      const missing = expected
        .filter((rel) => !saved.includes(rel))
        .map((file) => {
          const [, project, name] = file.split('/');
          const failure = failures.find((f) => f.project === project && f.title === name?.replace(/\.png$/, ''));
          return { file, reason: failure?.error ?? 'not saved' };
        });
      manifest.screenshots = { expected, saved, missing, report: 'screenshots/report.json' };
      writeFileSync(join(out, 'preview.log'), preview.output());
    }

    // 8. Token lint applies only to conditions with the token contract. Not built yet.
    manifest.status = 'complete';
    return manifest;
  } catch (error) {
    manifest.status = 'error';
    manifest.error = error instanceof Error ? error.message : String(error);
    return manifest;
  } finally {
    server?.stop();
    rmSync(scratch, { recursive: true, force: true });
    // 9. The manifest, with every output file.
    manifest.finishedAt = new Date().toISOString();
    manifest.files = walk(out)
      .filter((rel) => rel !== 'manifest.json')
      .map((rel) => ({ path: rel, bytes: statSync(join(out, rel)).size, sha256: hashEntry(join(out, rel)) }));
    writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    log(`[${runId}] ${manifest.status}${manifest.error ? `: ${manifest.error}` : ''}. Results in ${out}`);
  }
}

// Runs one condition end to end: assemble a workspace outside the repo, let
// the adapter's agent build the brief in it, copy the output, build it,
// serve it, run the shared behavior tests, take screenshots, and record
// everything in evals/results/<run-id>/. The temp workspace is deleted
// afterwards, also when a step fails.
//
// The run stops before the adapter is called if the workspace or prompt
// fails an isolation check, and before the build if generation failed or
// the session wasn't isolated. The build runs the generated code confined
// (see confine.ts). The build output is then served by the runner itself,
// with its own mock API (see serve.ts).
//
// Agent-independent: everything agent-specific is in the adapter.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Adapter, GenerateResult, IsolationCheck } from '../../adapters/types.ts';
import { materialize, REPO } from '../../starter/src/materialize.ts';
import { toolchain } from '../../starter/src/toolchain.ts';
import { checkOutside, checkPrompt, checkWorkspacePath, scanWorkspace } from './checks.ts';
import { conditionNamed } from './conditions.ts';
import { confine, confineCopy, sandboxAvailable, type ConfinementRecord } from './confine.ts';
import { copyFiles, diff, hashEntry, hashTree, sha256, snapshot, walk } from './files.ts';
import { PROMPT_FILE, renderPrompt } from './prompt.ts';
import { requireReport, summarizeReport, type TestSummary } from './report.ts';
import { lintTokens, type TokenLint } from './token-lint.ts';
import { copyBuild, serveBuild } from './serve.ts';

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

/** Fingerprint the checked-out sources that produce the shared review evidence. */
function scoringHash(): string {
  const suites = hashTree(TESTS, {
    skipAnywhere: ['node_modules', 'test-results', 'playwright-report'],
    skipPaths: ['meta', 'conformance-app'],
  });
  const screenshots = hashTree(join(RUNNER, 'screenshots'));
  const fixtures = hashTree(join(REPO, 'evals', 'fixtures', 'src'));
  const evidence = ['playwright.config.ts', 'src/serve.ts', 'src/report.ts'].map((file) => hashEntry(join(RUNNER, file)));
  return sha256([suites, screenshots, fixtures, ...evidence].join('\n'));
}

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

/**
 * complete: every applicable step ran. invalid: an isolation check failed.
 * incomplete: the generation session didn't finish. error: the runner failed.
 */
export type RunStatus = 'complete' | 'invalid' | 'incomplete' | 'error';

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
  projects: string[];
  limits: { timeoutMs: number; maxBudgetUsd: number | null };
  startedAt: string;
  finishedAt?: string;
  versions: { node: string; pnpm: string; playwright: string | null; agent: string | null };
  hashes: { skill: string | null; starter: string | null; brief: string; prompt: string; scoring: string };
  skillRevision: string | null;
  prompt: string;
  /** The temp workspace, deleted after the run. Recorded so its removal can be checked. */
  workspace: string | null;
  timings: Record<string, Step>;
  isolation: { ok: boolean; checks: IsolationCheck[]; settings?: Record<string, unknown> | undefined };
  generation: Omit<GenerateResult, 'isolation' | 'settings'> | null;
  /** How the build was confined. */
  confinement: ConfinementRecord | null;
  output: { dir: string; copied: string[]; added: string[]; changed: string[]; deleted: string[]; links: Array<{ path: string; target: string }> } | null;
  /** Brief completion: a failed build, or one that wrote no dist/index.html, is recorded, never fixed. */
  build: { ok: boolean; exitCode: number | null; log: string; error?: string } | null;
  /** The runner's own server for the build: a confined copy of dist/ (links left out) and the canonical mock API. */
  preview: {
    url: string;
    log: string;
    copiedIn: ConfinementRecord['sandbox'];
    files: number;
    links: Array<{ path: string; target: string }>;
    refused: Array<{ path: string; reason: string }>;
  } | null;
  tests: (TestSummary & { report: string; log: string; touchTargets: string[] }) | null;
  screenshots: { expected: string[]; saved: string[]; missing: Array<{ file: string; reason: string }>; report: string } | null;
  tokenLint: TokenLint;
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

/**
 * Runs a command to completion, capturing its output in a log file. Aborts
 * with the run. When the command exits, whatever it left running in its
 * process group is killed, so nothing from a build keeps changing the
 * workspace; output still pending after a few seconds is cut off.
 */
export function runLogged(
  command: string,
  args: string[],
  { cwd, env, logFile, signal }: { cwd: string; env?: NodeJS.ProcessEnv; logFile: string; signal?: AbortSignal | undefined },
): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    let exitCode: number | null = null;
    let finished = false;
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const killGroup = (signalName: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signalName);
      } catch {
        if (signalName === 'SIGTERM') child.kill('SIGTERM');
      }
    };
    const kill = () => killGroup('SIGTERM');
    const finish = () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', kill);
      writeFileSync(logFile, output);
      resolvePromise(exitCode);
    };
    signal?.addEventListener('abort', kill, { once: true });
    child.once('error', reject);
    child.once('exit', (code) => {
      exitCode = code;
      killGroup('SIGKILL');
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, 5_000).unref();
    });
    child.once('close', finish);
  });
}

export async function runEval(options: RunOptions): Promise<Manifest> {
  const { brief, adapter, model, effort, maxBudgetUsd, signal } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const projects = [...new Set(options.projects ?? ALL_PROJECTS)];
  const timeoutMs = options.timeoutMs ?? 90 * 60_000;

  // Check every input before creating anything.
  const condition = conditionNamed(options.condition);
  const states = BRIEF_STATES[brief];
  if (!states) throw new Error(`no screenshot states for brief "${brief}"`);
  const unknownProjects = projects.filter((p) => !ALL_PROJECTS.includes(p));
  if (unknownProjects.length) throw new Error(`unknown projects: ${unknownProjects.join(', ')}`);
  if (!projects.length) throw new Error('select at least one project');
  if (effort && !EFFORTS.includes(effort)) throw new Error(`effort must be one of ${EFFORTS.join(', ')}`);
  if (adapter.live && !model) throw new Error(`the ${adapter.name} adapter calls a model: pass an exact model ID`);
  if (adapter.live && !(maxBudgetUsd && maxBudgetUsd > 0)) throw new Error(`the ${adapter.name} adapter calls a model: pass a spending cap`);
  if (adapter.live && !sandboxAvailable()) {
    throw new Error(`the ${adapter.name} adapter's output can only be built and served inside sandbox-exec, which needs macOS`);
  }
  const briefPath = join(REPO, 'evals', 'briefs', `${brief}.md`);
  if (!existsSync(briefPath)) throw new Error(`no brief named "${brief}"`);
  const prompt = renderPrompt(brief);
  const skillHash = condition.skill ? hashTree(join(REPO, condition.skill.from)) : null;
  if (condition.skill?.pin && skillHash !== condition.skill.pin.hash) {
    throw new Error(`the ${condition.skill.name} skill differs from its pinned revision ${condition.skill.pin.revision}`);
  }
  adapter.check?.();
  const scoring = scoringHash();

  const resultsRoot = resolve(options.resultsRoot ?? RESULTS);
  mkdirSync(resultsRoot, { recursive: true });
  const runId = randomBytes(6).toString('hex');
  const out = join(resultsRoot, runId);
  mkdirSync(out);
  // Private operator mapping. Reviewer packets use a separate whitelist export.
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
    projects,
    limits: { timeoutMs, maxBudgetUsd: maxBudgetUsd ?? null },
    startedAt: new Date().toISOString(),
    versions: { node: process.version, pnpm: tool('pnpm', ['--version']), playwright: playwrightVersion(), agent: adapter.version() ?? null },
    hashes: {
      skill: skillHash,
      starter: null,
      brief: hashEntry(briefPath),
      prompt: sha256(readFileSync(PROMPT_FILE)),
      scoring,
    },
    skillRevision: condition.skill?.pin?.revision ?? null,
    prompt,
    workspace: null,
    timings: {},
    isolation: { ok: false, checks: [] },
    generation: null,
    confinement: null,
    output: null,
    build: null,
    preview: null,
    tests: null,
    screenshots: null,
    tokenLint: { status: condition.tokenLint ? 'not-run' : 'not-applicable' },
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

  const invalid = (checks: IsolationCheck[], settings?: Record<string, unknown>) => {
    manifest.isolation = { ok: false, checks, settings };
    manifest.status = 'invalid';
    manifest.error = `isolation failed: ${checks.filter((c) => !c.ok).map((c) => c.id).join(', ')}`;
    return manifest;
  };

  // The temp folder: the workspace, a canary just outside it, the adapter's private state and the build's.
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'work-'));
  const workspace = join(scratch, 'app');
  manifest.workspace = workspace;
  let server: Awaited<ReturnType<typeof serveBuild>> | undefined;
  let removeMarker = () => {};

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
    // Files the adapter may try reading to prove the forbidden paths are unreadable: a marker in the results, and
    // each checkout's package.json, which is published with the repo. Never anything else in a forbidden path.
    const marker = { file: join(out, 'isolation-marker.txt'), token: `marker-${randomBytes(16).toString('hex')}` };
    writeFileSync(marker.file, `${marker.token}\n`);
    removeMarker = () => rmSync(marker.file, { force: true });
    const readProbes = [marker, ...repoRoots().map((root) => ({ file: join(root, 'package.json') })).filter((p) => existsSync(p.file))];

    const checks: IsolationCheck[] = [
      checkOutside(workspace, forbiddenPaths),
      checkWorkspacePath(workspace),
      checkPrompt(prompt, forbiddenPaths),
      scanWorkspace(workspace, { guidanceDir: skillDir, forbiddenPaths }),
    ];
    // Nothing reaches the adapter, and nothing is spent, unless these pass.
    if (!checks.every((c) => c.ok)) return invalid(checks);
    const tools = toolchain();
    const confinement = confine({ workspace, stateDir: join(scratch, 'build'), forbidden: forbiddenPaths, toolchain: tools });
    manifest.confinement = confinement.record;
    const sandboxLog = join(out, 'build-sandbox.log');
    const [probeCommand, probeArgs] = confinement.wrap('pnpm', ['--version']);
    const probe = await step('build-sandbox', () => runLogged(probeCommand, probeArgs, {
      cwd: workspace, env: confinement.env, logFile: sandboxLog, signal,
    }));
    if (probe !== 0) throw new Error(`could not start the build sandbox: ${readFileSync(sandboxLog, 'utf8').trim()}`);
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
        readProbes,
        skill: condition.skill && skillDir ? { name: condition.skill.name, dir: skillDir } : undefined,
        maxBudgetUsd,
        timeoutMs,
        signal,
      }),
    );
    removeMarker();
    const { isolation: adapterChecks, settings, ...generation } = generated;
    manifest.generation = generation;

    // 3. Copy the output exactly as the generator left it.
    const after = snapshot(workspace, SNAPSHOT_SKIP);
    const changes = diff(before, after);
    const toCopy = [...new Set([...[...after.keys()].filter((rel) => rel.startsWith('src/')), ...changes.added, ...changes.changed])].sort();
    const outputDir = join(out, 'output');
    const copied = await step('copy-output', () => copyFiles(workspace, outputDir, toCopy));
    manifest.output = { dir: 'output', ...copied, ...changes };

    // Neither the canary's token nor the marker's may have travelled into the workspace either.
    const carried = toCopy.filter((rel) => {
      if (!lstatSync(join(workspace, rel)).isFile()) return false;
      const text = readFileSync(join(workspace, rel));
      return text.includes(canary.token) || text.includes(marker.token);
    });
    checks.push({
      id: 'runner.canary-absent',
      ok: carried.length === 0,
      detail: carried.length ? `the canary's or the marker's token is in ${carried.join(', ')}` : 'the canary and marker tokens are in no file the generator wrote',
    });
    checks.push(...adapterChecks);
    if (!checks.every((c) => c.ok)) return invalid(checks, settings);
    manifest.isolation = { ok: true, checks, settings };
    // A session that stopped early (budget, time limit, error result) left
    // unfinished work. It's recorded, with its output copied above, but not
    // built or scored. Stopping the run itself is a runner error instead.
    if (!generation.ok) {
      if (signal?.aborted) throw new Error('the run was aborted');
      manifest.status = 'incomplete';
      manifest.error = generation.error ?? 'the generation session did not finish';
      return manifest;
    }

    // 4. Build. A failure is a brief-completion failure, recorded and never fixed.
    const buildLog = join(out, 'build.log');
    rmSync(join(workspace, 'dist'), { recursive: true, force: true });
    const [buildCommand, buildArgs] = confinement.wrap('pnpm', ['build']);
    const buildCode = await step('build', () => runLogged(buildCommand, buildArgs, { cwd: workspace, env: confinement.env, logFile: buildLog, signal }));
    if (buildCode === null) throw new Error('the isolated build process was interrupted');
    manifest.build = { ok: buildCode === 0, exitCode: buildCode, log: 'build.log' };
    // The build's output leaves the workspace only through the confined copy, never with the runner's own permissions.
    const servedDir = join(scratch, 'serve');
    const copier = confineCopy({ from: join(workspace, 'dist'), to: servedDir, nodeRoot: tools.nodeRoot, forbidden: forbiddenPaths });
    const built = manifest.build.ok ? await step('copy-build', () => copyBuild(join(workspace, 'dist'), servedDir, copier)) : undefined;
    if (built?.missing) manifest.build = { ...manifest.build, ok: false, error: built.missing };

    if (built && !built.missing) {
      if (scoringHash() !== scoring) throw new Error('the scoring sources changed before scoring');
      // 5. Serve the build: the runner's own server and mock API, never the workspace's.
      const preview = await step('serve', () => serveBuild(servedDir, built));
      server = preview;
      manifest.preview = { url: preview.url, log: 'preview.log', copiedIn: copier.sandbox, files: built.copied.length, links: built.links, refused: built.refused };
      const serverAlive = (when: string) => {
        if (preview.gone()) throw new Error(`the build's server stopped ${when}:\n${preview.output()}`);
      };
      const browserEnv = { ...process.env, EVAL_BASE_URL: preview.url, EVAL_MOCK_ADMIN_TOKEN: preview.admin };

      // 6. The shared behavior tests.
      const testsDir = join(out, 'tests');
      mkdirSync(testsDir);
      const projectArgs = projects.flatMap((p) => ['--project', p]);
      const testsCode = await step('tests', () =>
        runLogged('pnpm', ['exec', 'playwright', 'test', ...projectArgs, '--reporter=list,json', '--output', join(testsDir, 'artifacts')], {
          cwd: TESTS,
          env: { ...browserEnv, PLAYWRIGHT_JSON_OUTPUT_FILE: join(testsDir, 'report.json') },
          logFile: join(testsDir, 'output.log'),
          signal,
        }),
      );
      const touchTargets = existsSync(join(testsDir, 'artifacts'))
        ? walk(join(testsDir, 'artifacts'))
            .filter((rel) => rel.endsWith('/touch-targets.json'))
            .map((rel) => `tests/artifacts/${rel}`)
        : [];
      manifest.tests = { ...summarizeReport(join(testsDir, 'report.json')), report: 'tests/report.json', log: 'tests/output.log', touchTargets };
      serverAlive('during the tests');
      requireReport(manifest.tests, 'behavior tests', testsCode, projects);

      // 7. Screenshots of every state, in every project.
      const shotsDir = join(out, 'screenshots');
      mkdirSync(shotsDir);
      const screenshotsCode = await step('screenshots', () =>
        runLogged('pnpm', ['exec', 'playwright', 'test', ...projectArgs, '--reporter=list,json', '--output', join(scratch, 'screenshot-artifacts')], {
          cwd: RUNNER,
          env: {
            ...browserEnv,
            EVAL_BRIEF: brief,
            EVAL_SCREENSHOT_DIR: shotsDir,
            PLAYWRIGHT_JSON_OUTPUT_FILE: join(shotsDir, 'report.json'),
          },
          logFile: join(shotsDir, 'output.log'),
          signal,
        }),
      );
      serverAlive('during the screenshots');
      if (scoringHash() !== scoring) throw new Error('the scoring sources changed during scoring');
      const expected = projects.flatMap((p) => states.map((s) => `screenshots/${p}/${s}.png`));
      const saved = expected.filter((rel) => existsSync(join(out, rel)));
      const screenshotReport = summarizeReport(join(shotsDir, 'report.json'));
      requireReport(screenshotReport, 'screenshots', screenshotsCode, projects);
      const { failures } = screenshotReport;
      const missing = expected
        .filter((rel) => !saved.includes(rel))
        .map((file) => {
          const [, project, name] = file.split('/');
          const failure = failures.find((f) => f.project === project && f.title === name?.replace(/\.png$/, ''));
          return { file, reason: failure?.error ?? 'not saved' };
        });
      manifest.screenshots = { expected, saved, missing, report: 'screenshots/report.json' };
    }

    // 8. Token lint only applies where the token contract is part of the guidance.
    if (manifest.build.ok && condition.tokenLint && skillDir) {
      manifest.tokenLint = await step('token-lint', () => lintTokens(outputDir, copied.copied, out, scratch, skillDir));
    }
    manifest.status = 'complete';
    return manifest;
  } catch (error) {
    manifest.status = 'error';
    manifest.error = error instanceof Error ? error.message : String(error);
    return manifest;
  } finally {
    if (server) {
      server.stop();
      writeFileSync(join(out, 'preview.log'), server.output());
    }
    removeMarker();
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

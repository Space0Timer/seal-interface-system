import { randomBytes, randomInt } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { REPO } from '../../starter/src/materialize.ts';
import type { TouchTarget } from '../../tests/asset-library/helpers.ts';
import { hashEntry } from './files.ts';
import type { Manifest } from './run.ts';

const RUN_ID = /^[\da-f]{12}$/;
const SCREENSHOT = /^screenshots\/(?:desktop|mobile)-(?:light|dark)\/[a-z0-9-]+\.png$/;
const TOUCH_REPORT = /^tests\/artifacts\/[a-z0-9-]+\/touch-targets\.json$/;
const json = (file: string, data: unknown) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });

function comparisonInputs(run: Manifest): string {
  return JSON.stringify({
    brief: run.brief,
    starter: run.hashes.starter,
    briefHash: run.hashes.brief,
    promptHash: run.hashes.prompt,
    adapter: run.adapter,
    model: run.model,
    effort: run.effort,
    projects: [...run.projects].sort(),
    limits: run.limits,
    versions: run.versions,
  });
}

function readRun(root: string, runId: string): Manifest {
  const run = JSON.parse(readFileSync(join(root, runId, 'manifest.json'), 'utf8')) as Manifest;
  if (run.runId !== runId || run.status !== 'complete' || !run.isolation.ok || !run.generation?.ok || !run.build) {
    throw new Error(`run ${runId} has no completed evaluation evidence`);
  }
  return run;
}

function touchEvidence(root: string, paths: string[]) {
  return paths.filter((path) => TOUCH_REPORT.test(path)).map((path) => {
    const report = JSON.parse(readFileSync(join(root, path), 'utf8')) as {
      project: string; state: string; minimum: number; targets: TouchTarget[];
    };
    return {
      project: report.project,
      state: report.state,
      minimum: report.minimum,
      targets: report.targets.map(({ label, tag, width, height, meetsMinimum }) => ({ label, tag, width, height, meetsMinimum })),
    };
  });
}

/** Export only reviewer evidence. The alias key stays under the operator's results root. */
export function exportReview(resultsRoot: string, destination: string, runIds: string[]) {
  if (!runIds.length || new Set(runIds).size !== runIds.length || runIds.some((id) => !RUN_ID.test(id))) {
    throw new Error('select distinct, valid run IDs');
  }
  const root = resolve(resultsRoot);
  const out = resolve(destination);
  const runs = runIds.map((id) => readRun(root, id));
  const first = runs[0]!;
  if (runs.some((run) => comparisonInputs(run) !== comparisonInputs(first))) {
    throw new Error('selected runs have different comparison inputs');
  }
  if (!/^[a-z0-9-]+$/.test(first.brief)) throw new Error('invalid brief in results');
  const brief = `evals/briefs/${first.brief}.md`;
  if (hashEntry(join(REPO, brief)) !== first.hashes.brief) throw new Error('the brief has changed since these runs');

  // Keep the alias order independent of both run submission order and run ID.
  for (let end = runs.length - 1; end > 0; end--) {
    const pick = randomInt(end + 1);
    [runs[end], runs[pick]] = [runs[pick]!, runs[end]!];
  }
  const aliases = runs.map((run, index) => ({ sample: `sample-${index + 1}`, runId: run.runId }));
  mkdirSync(out);
  try {
    const references = [
      brief, `evals/rubric/${first.brief}.md`,
      'core/design-system/principles.md', 'core/design-system/ban-list.md',
    ];
    for (const file of references) {
      mkdirSync(dirname(join(out, file)), { recursive: true });
      copyFileSync(join(REPO, file), join(out, file));
    }
    for (const [index, run] of runs.entries()) {
      const sample = join(out, aliases[index]!.sample);
      const runDir = join(root, run.runId);
      mkdirSync(sample);
      const screenshots = (run.screenshots?.saved ?? []).filter((path) => SCREENSHOT.test(path));
      for (const file of screenshots) {
        mkdirSync(dirname(join(sample, file)), { recursive: true });
        copyFileSync(join(runDir, file), join(sample, file));
      }
      json(join(sample, 'evidence.json'), {
        build: run.build?.ok ? 'passed' : 'failed',
        tests: run.tests?.outcomes.map(({ title, project, status }) => ({ title, project, status })) ?? [],
        missingScreenshots: run.screenshots?.missing.map(({ file }) => file).filter((path) => SCREENSHOT.test(path)) ?? [],
        touchTargets: touchEvidence(runDir, run.tests?.touchTargets ?? []),
      });
    }
    json(join(out, 'review-order.json'), aliases.map(({ sample }) => sample));
    const mapping = join(root, `review-${randomBytes(8).toString('hex')}.json`);
    json(mapping, { packet: out, samples: aliases });
    return { packet: out, mapping };
  } catch (error) {
    rmSync(out, { recursive: true, force: true });
    throw error;
  }
}

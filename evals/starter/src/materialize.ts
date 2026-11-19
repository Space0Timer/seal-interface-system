// Assembles a generator workspace: the starter template, the tools it needs
// (copied from their single sources in this repo), the brief, the upload
// files, and optionally one condition's design guidance. Then installs the
// template's locked dependencies.
//
// The workspace must live outside this repo for real runs. It gets nothing
// else from the repo: no AGENTS.md or CLAUDE.md, no rubric, no tests, no
// conformance app.
//
// Usage:
//   node src/materialize.ts --out <dir> [--brief asset-library]
//     [--guidance-from <dir> --guidance-to <relative dir>] [--skip-install]
// Example (my-skill condition, Claude Code project skill):
//   --guidance-from core/design-system --guidance-to .claude/skills/design-system
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { writeUploadFiles } from '../../fixtures/src/files.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, '../../..');
export const TEMPLATE = join(here, '..', 'template');

/** Tool files copied into the workspace, from their single source in the repo. */
export const TOOL_SOURCES: Record<string, string[]> = {
  'tools/tokens': ['packages/tokens/src/resolve.ts', 'packages/tokens/src/css.ts'],
  'tools/mock-api': [
    'evals/fixtures/src/data.ts',
    'evals/fixtures/src/mock-api.ts',
    'evals/fixtures/src/thumbnails.ts',
    'evals/fixtures/src/vite-plugin.ts',
    'evals/fixtures/src/files.ts',
  ],
};

export interface Guidance {
  /** Directory to copy, absolute or relative to the repo. */
  from: string;
  /** Destination inside the workspace, relative. */
  to: string;
}

export interface MaterializeOptions {
  out: string;
  brief?: string;
  guidance?: Guidance | undefined;
  install?: boolean;
}

export function materialize({ out, brief = 'asset-library', guidance, install = true }: MaterializeOptions): string {
  const target = resolve(out);
  if (existsSync(target) && readdirSync(target).length > 0) throw new Error(`${target} already exists and isn't empty`);
  mkdirSync(target, { recursive: true });

  cpSync(TEMPLATE, target, { recursive: true, filter: (src) => !src.split(sep).includes('node_modules') });

  for (const [dir, sources] of Object.entries(TOOL_SOURCES)) {
    mkdirSync(join(target, dir), { recursive: true });
    for (const source of sources) copyFileSync(join(REPO, source), join(target, dir, basename(source)));
  }

  copyFileSync(join(REPO, 'evals', 'briefs', `${brief}.md`), join(target, `${brief}.md`));
  writeUploadFiles(target);

  if (guidance) {
    if (isAbsolute(guidance.to) || guidance.to.split(/[\\/]/).includes('..')) throw new Error('guidance.to must stay inside the workspace');
    const from = isAbsolute(guidance.from) ? guidance.from : join(REPO, guidance.from);
    cpSync(from, join(target, guidance.to), { recursive: true });
  }

  if (install) {
    execFileSync('pnpm', ['install', '--frozen-lockfile', '--ignore-workspace', '--prefer-offline'], { cwd: target, stdio: 'pipe' });
  }
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      brief: { type: 'string', default: 'asset-library' },
      'guidance-from': { type: 'string' },
      'guidance-to': { type: 'string' },
      'skip-install': { type: 'boolean', default: false },
    },
  });
  if (!values.out) {
    console.error('usage: materialize.ts --out <dir> [--brief <name>] [--guidance-from <dir> --guidance-to <dir>] [--skip-install]');
    process.exit(1);
  }
  const from = values['guidance-from'];
  const to = values['guidance-to'];
  if (Boolean(from) !== Boolean(to)) {
    console.error('--guidance-from and --guidance-to go together');
    process.exit(1);
  }
  const target = materialize({
    out: values.out,
    brief: values.brief,
    guidance: from && to ? { from, to } : undefined,
    install: !values['skip-install'],
  });
  const inside = !relative(REPO, target).startsWith('..');
  console.log(`Workspace ready at ${target}${inside ? ' (warning: inside the repo; real runs must be outside it)' : ''}.`);
}

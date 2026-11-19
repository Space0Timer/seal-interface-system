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
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { writeUploadFiles } from '../../fixtures/src/files.ts';
import { findResolver, isDiscoverable, MAX_DEPTH, RESOLVER, SKIP } from '../template/tools/find-tokens.ts';

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
  ],
};

/**
 * The starter's files, copied one by one. Nothing else in the template
 * folder (build output, .env files, editor or OS junk) ever reaches a
 * workspace. A test keeps this list equal to the template's tracked files.
 */
export const TEMPLATE_FILES = [
  'README.md',
  'index.html',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'vite.config.ts',
  'src/App.tsx',
  'src/main.tsx',
  'tools/find-tokens.ts',
  'tools/prepare.ts',
];

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
  /** The template folder to copy from. Only tests change it. */
  templateDir?: string;
}

const BRIEF_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A brief is named, never a path: "asset-library" means evals/briefs/asset-library.md. */
function briefSource(brief: string): string {
  if (!BRIEF_NAME.test(brief)) throw new Error(`brief must be a single brief name such as "asset-library", got "${brief}"`);
  const path = join(REPO, 'evals', 'briefs', `${brief}.md`);
  if (!existsSync(path)) throw new Error(`no brief named "${brief}" in evals/briefs`);
  return path;
}

/** True if `path` is `root` or inside it. Handles "..tmp" names and other drives. */
export function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Where guidance lands: strictly inside the workspace, never the workspace root itself. */
function guidanceDestination(target: string, to: string): string {
  const destination = resolve(target, to);
  if (!to || destination === target || !isInside(destination, target)) {
    throw new Error(`guidance.to must be a folder inside the workspace, got "${to}"`);
  }
  return destination;
}

/**
 * Resolves the guidance directory (a link at its root is followed) and
 * rejects any link inside it that points outside the guidance tree, or back
 * at one of its own ancestors. Returns the real path to copy from.
 */
function guidanceSource(guidance: Guidance): string {
  const root = realpathSync(isAbsolute(guidance.from) ? guidance.from : join(REPO, guidance.from));
  if (!statSync(root).isDirectory()) throw new Error(`guidance.from must be a directory: ${guidance.from}`);

  const walk = (dir: string, ancestors: string[]): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const real = realpathSync(path);
        if (!isInside(real, root)) throw new Error(`guidance link ${relative(root, path)} points outside the guidance: ${real}`);
        if (statSync(real).isDirectory()) {
          if (ancestors.some((a) => isInside(a, real))) throw new Error(`guidance link ${relative(root, path)} creates a cycle`);
          walk(real, [...ancestors, real]);
        }
      } else if (entry.isDirectory()) {
        walk(path, [...ancestors, path]);
      }
    }
  };
  walk(root, [root]);
  return root;
}

function assertNoLinks(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (lstatSync(path).isSymbolicLink()) throw new Error(`the copied guidance still contains a link: ${path}`);
    if (entry.isDirectory()) assertNoLinks(path);
  }
}

/** Path of the first tokens.resolver.json in a guidance tree, relative to it, if any. */
function resolverIn(dir: string, base = dir): string | undefined {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  if (entries.some((e) => e.name === RESOLVER && statSync(join(dir, e.name)).isFile())) return relative(base, join(dir, RESOLVER));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (!statSync(path).isDirectory()) continue;
    const found = resolverIn(path, base);
    if (found) return found;
  }
  return undefined;
}

export function materialize({ out, brief = 'asset-library', guidance, install = true, templateDir = TEMPLATE }: MaterializeOptions): string {
  // Check every input before creating anything.
  const target = resolve(out);
  const briefPath = briefSource(brief);
  const destination = guidance ? guidanceDestination(target, guidance.to) : undefined;
  const guidancePath = guidance ? guidanceSource(guidance) : undefined;
  const missing = TEMPLATE_FILES.filter((file) => !existsSync(join(templateDir, file)));
  if (missing.length) throw new Error(`the template is missing ${missing.join(', ')}`);

  // Guidance with tokens must land where tools/prepare.ts will find them;
  // otherwise a run would silently go without its assigned tokens.
  const resolverRel = guidancePath ? resolverIn(guidancePath) : undefined;
  const tokensAt = destination && resolverRel ? relative(target, join(destination, resolverRel)) : undefined;
  if (tokensAt && !isDiscoverable(tokensAt)) {
    throw new Error(
      `tools/prepare.ts wouldn't find the guidance tokens at ${tokensAt}: put the guidance at most ${MAX_DEPTH} folders deep, ` +
        `and not inside ${[...SKIP].join(', ')}`,
    );
  }
  if (existsSync(target) && readdirSync(target).length > 0) throw new Error(`${target} already exists and isn't empty`);
  mkdirSync(target, { recursive: true });

  for (const file of TEMPLATE_FILES) {
    mkdirSync(dirname(join(target, file)), { recursive: true });
    copyFileSync(join(templateDir, file), join(target, file));
  }

  for (const [dir, sources] of Object.entries(TOOL_SOURCES)) {
    mkdirSync(join(target, dir), { recursive: true });
    for (const source of sources) copyFileSync(join(REPO, source), join(target, dir, basename(source)));
  }

  copyFileSync(briefPath, join(target, `${brief}.md`));
  writeUploadFiles(target);

  if (guidancePath && destination) {
    // Real files only: a link would point back into this checkout.
    cpSync(guidancePath, destination, { recursive: true, dereference: true });
    assertNoLinks(destination);
    // Confirm with the workspace's own search that these tokens are the ones it finds.
    if (tokensAt && findResolver(target) !== join(target, tokensAt)) {
      rmSync(target, { recursive: true, force: true });
      throw new Error(`tools/prepare.ts wouldn't use the guidance tokens at ${tokensAt}`);
    }
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
  const inside = isInside(target, REPO);
  console.log(`Workspace ready at ${target}${inside ? ' (warning: inside the repo; real runs must be outside it)' : ''}.`);
}

// Usage:
//   node src/cli.ts check [--skill <dir>]
//   node src/cli.ts build [--skill <dir>] [--out <file>]
// --skill defaults to this repo's core/design-system. The eval starter passes
// the workspace-local copy of the skill instead.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkPairs, loadPairRules } from './contrast.ts';
import { buildCss } from './css.ts';
import { resolveTokens } from './resolve.ts';

const here = dirname(fileURLToPath(import.meta.url));
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    skill: { type: 'string', default: join(here, '../../../core/design-system') },
    out: { type: 'string', default: join(here, '../dist/tokens.css') },
  },
});

const command = positionals[0];
const skillDir = resolve(values.skill);
const resolverPath = join(skillDir, 'tokens.resolver.json');
const resolution = resolveTokens(resolverPath);

function fail(lines: string[]): never {
  for (const line of lines) console.error(`  ${line}`);
  process.exit(1);
}

if (resolution.errors.length) {
  console.error(`Token errors in ${relative(process.cwd(), resolverPath)}:`);
  fail(resolution.errors);
}

if (command === 'check') {
  const counts = resolution.modes.map((m) => `${m.name || 'base'} ${m.tokens.size}`).join(', ');
  console.log(`Tokens valid: ${counts}.`);

  const results = checkPairs(loadPairRules(join(skillDir, 'contrast-pairs.json')), resolution.modes);
  const failures = results.filter((r) => !r.pass);
  if (failures.length) {
    console.error(`${failures.length} of ${results.length} contrast pairs fail:`);
    fail(failures.map((r) => `[${r.mode}] ${r.foreground} on ${r.background.join(' + ')}: ${r.ratio.toFixed(2)} < ${r.minimum}`));
  }
  const tightest = [...results].sort((a, b) => a.ratio / a.minimum - b.ratio / b.minimum).slice(0, 3);
  console.log(`Contrast: ${results.length} pairs pass. Tightest:`);
  for (const r of tightest) console.log(`  [${r.mode}] ${r.foreground} on ${r.background.join(' + ')}: ${r.ratio.toFixed(2)} (min ${r.minimum})`);
} else if (command === 'build') {
  const out = resolve(values.out);
  const css = buildCss(resolution.modes, { source: relative(dirname(out), resolverPath) });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, css);
  console.log(`Wrote ${relative(process.cwd(), out)}.`);
} else {
  fail(['usage: cli.ts check|build [--skill <dir>] [--out <file>]']);
}

// Runs before `pnpm dev` and `pnpm build`.
//
// If this workspace contains DTCG design tokens (a tokens.resolver.json),
// converts them to CSS custom properties in src/design-tokens.css. A token
// path becomes a custom property with dots replaced by hyphens, for example
// color.text.secondary becomes --color-text-secondary. Without tokens, this
// does nothing.
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src', 'design-tokens.css');
const SKIP = new Set(['node_modules', 'dist', 'src', 'tools', 'upload-files', 'replacement-files']);

function findResolver(dir: string, depth: number): string | undefined {
  const entries = readdirSync(dir, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && e.name === 'tokens.resolver.json')) return join(dir, 'tokens.resolver.json');
  if (depth === 0) return undefined;
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
    const found = findResolver(join(dir, entry.name), depth - 1);
    if (found) return found;
  }
  return undefined;
}

const resolver = findResolver(root, 4);

if (!resolver) {
  rmSync(out, { force: true });
} else {
  const { resolveTokens } = await import('./tokens/resolve.ts');
  const { buildCss } = await import('./tokens/css.ts');
  const resolution = resolveTokens(resolver);
  if (resolution.errors.length) {
    console.error(`Design token errors in ${relative(root, resolver)}:\n  ${resolution.errors.join('\n  ')}`);
    process.exit(1);
  }
  writeFileSync(out, buildCss(resolution.modes, { source: relative(dirname(out), resolver) }));
  console.log(`Generated ${relative(root, out)} from ${relative(root, resolver)}.`);
}

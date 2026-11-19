// Runs before `pnpm dev` and `pnpm build`.
//
// If this workspace contains DTCG design tokens (a tokens.resolver.json),
// converts them to CSS custom properties in src/design-tokens.css. A token
// path becomes a custom property with dots replaced by hyphens, for example
// color.text.secondary becomes --color-text-secondary. Without tokens, this
// does nothing, except remove a stale file it generated earlier.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findResolver } from './find-tokens.ts';
import { buildCss, GENERATED_HEADER } from './tokens/css.ts';
import { resolveTokens } from './tokens/resolve.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src', 'design-tokens.css');
const resolver = findResolver(root);
const generatedHere = () => existsSync(out) && readFileSync(out, 'utf8').startsWith(GENERATED_HEADER);

if (!resolver) {
  // Remove only a stale file this script generated; never a file you wrote.
  if (generatedHere()) rmSync(out);
} else {
  const resolution = resolveTokens(resolver);
  if (resolution.errors.length) {
    console.error(`Design token errors in ${relative(root, resolver)}:\n  ${resolution.errors.join('\n  ')}`);
    process.exit(1);
  }
  writeFileSync(out, buildCss(resolution.modes, { source: relative(dirname(out), resolver) }));
  console.log(`Generated ${relative(root, out)} from ${relative(root, resolver)}. Import it from your app to use the tokens.`);
}

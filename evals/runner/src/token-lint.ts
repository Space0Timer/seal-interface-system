import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import stylelint from 'stylelint';
import { buildCss } from '../../../packages/tokens/src/css.ts';
import { resolveTokens } from '../../../packages/tokens/src/resolve.ts';
import { REPO } from '../../starter/src/materialize.ts';

export type TokenLint = { status: 'not-applicable' | 'not-run' } | {
  status: 'passed' | 'failed';
  checked: { stylesheets: number; scripts: number };
  report: string;
};

interface Finding {
  file: string;
  rule: string;
  message: string;
  line?: number | undefined;
  column?: number | undefined;
}

const SCRIPT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

export async function lintTokens(output: string, files: string[], out: string, state: string, skillDir: string): Promise<TokenLint> {
  const resolver = resolveTokens(join(REPO, 'core/design-system/tokens.resolver.json'));
  if (resolver.errors.length) throw new Error(`could not resolve lint tokens: ${resolver.errors.join(', ')}`);
  const css = buildCss(resolver.modes, { source: relative('src', join(skillDir, 'tokens.resolver.json')) });
  const tokensCss = join(state, 'lint-tokens.css');
  writeFileSync(tokensCss, css);
  const findings: Finding[] = [];
  let stylesheets = 0;
  for (const file of files.filter((path) => extname(path) === '.css')) {
    const code = readFileSync(join(output, file), 'utf8');
    if (file === 'src/design-tokens.css' && code === css) continue;
    stylesheets++;
    const result = await stylelint.lint({
      code, codeFilename: join(output, file), ignoreDisables: true,
      config: {
        plugins: [join(REPO, 'packages/lint/stylelint-token-values.js')],
        rules: { 'ds/token-values': [true, { tokensCss }] },
      },
    });
    for (const sheet of result.results) {
      for (const { rule, text, line, column } of sheet.warnings) findings.push({ file, rule, message: text, line, column });
    }
  }

  const scripts = files.filter((file) => SCRIPT.has(extname(file)));
  if (scripts.length) {
    const config = join(state, 'token-oxlint.json');
    writeFileSync(config, JSON.stringify({
      categories: { correctness: 'off' },
      jsPlugins: [join(REPO, 'packages/lint/oxlint-plugin.js')],
      rules: { 'ds/no-inline-style': 'error', 'ds/no-raw-color': 'error' },
    }));
    const result = spawnSync(join(REPO, 'node_modules/.bin/oxlint'), [
      '--config', config, '--disable-nested-config', '--no-ignore', '--format', 'json', '--', ...scripts.map((file) => `./${file}`),
    ], { cwd: output, encoding: 'utf8' });
    if (result.error || (result.status !== 0 && result.status !== 1) || !result.stdout.trim()) {
      throw new Error(`token lint could not run Oxlint: ${result.error?.message ?? result.stderr}`);
    }
    const { diagnostics } = JSON.parse(result.stdout) as {
      diagnostics: Array<{ filename: string; code: string; message: string; labels?: Array<{ span?: { line: number; column: number } }> }>;
    };
    if (result.status === 1 && !diagnostics.length) throw new Error(`token lint could not run Oxlint: ${result.stderr}`);
    for (const diagnostic of diagnostics) {
      const span = diagnostic.labels?.[0]?.span;
      findings.push({
        file: diagnostic.filename, rule: diagnostic.code.replace(/^ds\((.+)\)$/, 'ds/$1'), message: diagnostic.message,
        line: span?.line, column: span?.column,
      });
    }
  }
  const result = {
    status: findings.length ? 'failed' as const : 'passed' as const,
    checked: { stylesheets, scripts: scripts.length },
    report: 'token-lint.json',
  };
  writeFileSync(join(out, result.report), `${JSON.stringify({ ...result, findings }, null, 2)}\n`);
  return result;
}

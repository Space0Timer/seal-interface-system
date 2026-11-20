import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
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

// Comments that would switch rules off or reconfigure them inside the code
// being checked: eslint-disable(-line|-next-line), oxlint-disable…,
// eslint-enable, and /* eslint rule: off */ config comments. Stylelint is
// told to ignore its own disables; Oxlint has no such switch, so the
// scripts are linted from copies where these words are made inert. Each
// replacement keeps the same length, so lines and columns still match.
const DIRECTIVE = /\b(eslint|oxlint)-(disable|enable)/g;
const CONFIG_COMMENT = /(\/\*\s*)(eslint|oxlint)[ \t]/g;

/** The script with its lint directives made inert, and how many there were. */
export function withoutDirectives(code: string): { code: string; directives: number } {
  let directives = 0;
  const inert = code
    .replace(DIRECTIVE, (_m, tool: string, verb: string) => {
      directives++;
      return `${tool}_${verb}`;
    })
    .replace(CONFIG_COMMENT, (_m, open: string, tool: string) => {
      directives++;
      return `${open}${tool}_`;
    });
  return { code: inert, directives };
}

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
  const directives: Array<{ file: string; count: number }> = [];
  if (scripts.length) {
    const copies = join(state, 'token-lint-scripts');
    rmSync(copies, { recursive: true, force: true });
    for (const file of scripts) {
      const { code, directives: count } = withoutDirectives(readFileSync(join(output, file), 'utf8'));
      if (count) directives.push({ file, count });
      mkdirSync(dirname(join(copies, file)), { recursive: true });
      writeFileSync(join(copies, file), code);
    }
    const config = join(state, 'token-oxlint.json');
    writeFileSync(config, JSON.stringify({
      categories: { correctness: 'off' },
      jsPlugins: [join(REPO, 'packages/lint/oxlint-plugin.js')],
      rules: { 'ds/no-inline-style': 'error', 'ds/no-raw-color': 'error' },
    }));
    const result = spawnSync(join(REPO, 'node_modules/.bin/oxlint'), [
      '--config', config, '--disable-nested-config', '--no-ignore', '--format', 'json', '--', ...scripts.map((file) => `./${file}`),
    ], { cwd: copies, encoding: 'utf8' });
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
  // Directives in the authored code are listed, and had no effect on the findings.
  writeFileSync(join(out, result.report), `${JSON.stringify({ ...result, findings, ignoredDirectives: directives }, null, 2)}\n`);
  return result;
}

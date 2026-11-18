import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import stylelint from 'stylelint';

const plugin = fileURLToPath(new URL('../stylelint-token-values.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'lint-'));
const tokensCss = join(dir, 'tokens.css');
writeFileSync(
  tokensCss,
  ':root { --color-text-primary: #000; --space-region: 32px; --radius-control: 6px; --border-width-default: 1px; --motion-duration-fast: 120ms; --motion-easing-standard: cubic-bezier(0.2, 0, 0, 1); --type-body-default-font-size: 14px; --elevation-overlay: none; }',
);

async function lint(code) {
  const { results } = await stylelint.lint({
    code,
    config: { plugins: [plugin], rules: { 'ds/token-values': [true, { tokensCss }] } },
  });
  return results[0].warnings.map((w) => w.text);
}

test('token references and structural values pass', async () => {
  const warnings = await lint(`
    .row {
      color: var(--color-text-primary);
      padding-inline: var(--space-region);
      border: var(--border-width-default) solid var(--color-text-primary);
      border-radius: var(--radius-control);
      font-size: var(--type-body-default-font-size);
      box-shadow: var(--elevation-overlay);
      transition: background-color var(--motion-duration-fast) var(--motion-easing-standard);
      display: grid;
      grid-template-columns: auto 1fr minmax(0, 12ch);
      width: 100%;
      min-width: 0;
      margin: 0 auto;
      background: transparent;
      --row-gap: var(--space-region);
      gap: var(--row-gap);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `);
  assert.deepEqual(warnings, []);
});

test('raw colors are rejected', async () => {
  const warnings = await lint('.a { color: #6d28d9; } .b { background: linear-gradient(red, oklch(0.6 0.2 300)); } .c { border-color: rebeccapurple; }');
  assert.equal(warnings.length, 3, warnings.join('\n'));
  assert.ok(warnings.every((w) => w.includes('Raw color')));
});

test('raw spacing, radius and border widths are rejected', async () => {
  const warnings = await lint('.a { padding: 12px; } .b { border-radius: 16px; } .c { border: 1px solid var(--color-text-primary); } .d { --gap: 1.5rem; }');
  assert.equal(warnings.length, 4, warnings.join('\n'));
  assert.ok(warnings.every((w) => w.includes('Raw length')));
});

test('type, font and shadow values must be tokens', async () => {
  const warnings = await lint('.a { font-family: Inter, sans-serif; } .b { font-weight: 600; } .c { box-shadow: 0 4px 12px var(--color-text-primary); }');
  assert.equal(warnings.length, 3, warnings.join('\n'));
});

test('raw durations and easings are rejected', async () => {
  const warnings = await lint('.a { transition: opacity 300ms ease-in-out; } .b { animation-duration: 0ms; }');
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.ok(warnings[0].includes('Raw motion'));
});

test('invented or primitive custom properties are rejected', async () => {
  const warnings = await lint('.a { color: var(--color-brand-purple); } .b { color: var(--palette-accent-500); }');
  assert.equal(warnings.length, 2, warnings.join('\n'));
  assert.ok(warnings.every((w) => w.includes('is not a design token')));
});

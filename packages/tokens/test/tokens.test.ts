import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPairs, contrastRatio, loadPairRules } from '../src/contrast.ts';
import { buildCss, cssVarName, formatColor } from '../src/css.ts';
import { resolveTokens } from '../src/resolve.ts';

const skill = fileURLToPath(new URL('../../../core/design-system/', import.meta.url));
const real = resolveTokens(join(skill, 'tokens.resolver.json'));

test('the design system tokens resolve without errors in every mode', () => {
  assert.deepEqual(real.errors, []);
  assert.deepEqual(real.modes.map((m) => m.name), ['light', 'dark']);
  assert.equal(real.modes[0]?.tokens.size, real.modes[1]?.tokens.size);
});

test('every contrast pair passes', () => {
  const results = checkPairs(loadPairRules(join(skill, 'contrast-pairs.json')), real.modes);
  assert.ok(results.length > 0);
  assert.deepEqual(results.filter((r) => !r.pass), []);
});

test('CSS follows the documented naming and omits primitives', () => {
  const css = buildCss(real.modes, { source: 'test' });
  assert.equal(cssVarName('color.text.secondary'), '--color-text-secondary');
  assert.match(css, /--color-text-secondary: #/);
  assert.match(css, /--type-list-default-font-size: 13px;/);
  assert.match(css, /--type-list-default-font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;/);
  assert.match(css, /--space-region: 32px;/);
  assert.match(css, /--motion-easing-standard: cubic-bezier\(0\.2, 0, 0, 1\);/);
  assert.doesNotMatch(css, /--palette-|--font-/);
});

test('CSS maps modes independently and honors reduced motion', () => {
  const css = buildCss(real.modes, { source: 'test' });
  assert.match(css, /:root,\n\[data-mode="light"\] \{\n {2}color-scheme: light;/);
  assert.match(css, /\[data-mode="dark"\] \{\n {2}color-scheme: dark;/);
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\n {2}:root:not\(\[data-mode="light"\]\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n {2}:root \{\n {4}--motion-duration-default: 0ms;/);
});

test('colors with alpha become rgb() with an alpha channel', () => {
  assert.equal(formatColor({ colorSpace: 'srgb', components: [0, 0, 0], alpha: 0.08 }), 'rgb(0 0 0 / 0.08)');
  assert.equal(formatColor({ colorSpace: 'srgb', components: [1, 1, 1] }), '#ffffff');
});

test('contrast ratio matches WCAG for black on white', () => {
  assert.equal(contrastRatio([0, 0, 0], [1, 1, 1]), 21);
});

test('broken aliases, type mismatches and missing mode tokens are reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokens-'));
  const write = (name: string, data: unknown) => writeFileSync(join(dir, name), JSON.stringify(data));
  write('base.json', {
    size: { $type: 'dimension', a: { $value: { value: 4, unit: 'px' } }, b: { $value: '{size.missing}' } },
    weight: { $type: 'fontWeight', w: { $value: '{size.a}' } },
  });
  write('light.json', { color: { $type: 'color', x: { $value: { colorSpace: 'srgb', components: [1, 1, 1] } } } });
  write('dark.json', {});
  write('r.json', {
    version: '2025.10',
    sets: { base: { sources: [{ $ref: 'base.json' }] } },
    modifiers: { mode: { default: 'light', contexts: { light: [{ $ref: 'light.json' }], dark: [{ $ref: 'dark.json' }] } } },
    resolutionOrder: [{ $ref: '#/sets/base' }, { $ref: '#/modifiers/mode' }],
  });
  const { errors } = resolveTokens(join(dir, 'r.json'));
  assert.ok(errors.some((e) => e.includes('size.b: unresolved alias {size.missing}')), errors.join('\n'));
  assert.ok(errors.some((e) => e.includes('weight.w: {size.a} is dimension, expected fontWeight')), errors.join('\n'));
  assert.ok(errors.some((e) => e.includes('[dark] missing tokens defined in light: color.x')), errors.join('\n'));
});

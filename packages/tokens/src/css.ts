// Converts resolved tokens to CSS custom properties.
// Naming: a token path becomes a custom property with dots replaced by
// hyphens; typography roles expand to one property per field.
// (This file is copied into generated workspaces; keep comments neutral.)
import { isObject, type Json, type ResolvedMode, type Token } from './resolve.ts';

/** Groups product code may use. palette.* and font.* primitives are never emitted. */
export const EMITTED_GROUPS = ['color', 'type', 'space', 'size', 'radius', 'border', 'elevation', 'motion'];

const TYPOGRAPHY_FIELDS: Record<string, string> = {
  fontFamily: 'font-family',
  fontSize: 'font-size',
  fontWeight: 'font-weight',
  lineHeight: 'line-height',
  letterSpacing: 'letter-spacing',
};

const FONT_WEIGHTS: Record<string, number> = {
  thin: 100, hairline: 100, 'extra-light': 200, 'ultra-light': 200, light: 300, normal: 400, regular: 400,
  book: 400, medium: 500, 'semi-bold': 600, 'demi-bold': 600, bold: 700, 'extra-bold': 800, 'ultra-bold': 800,
  black: 900, heavy: 900, 'extra-black': 950, 'ultra-black': 950,
};

export function cssVarName(path: string): string {
  return `--${path.replaceAll('.', '-')}`;
}

function num(n: number): string {
  return String(Math.round(n * 10000) / 10000);
}

export function formatColor(value: Json): string {
  if (!isObject(value) || !Array.isArray(value['components'])) throw new Error('invalid color');
  const [r, g, b] = value['components'].map((c) => Math.round((c as number) * 255));
  const alpha = typeof value['alpha'] === 'number' ? value['alpha'] : 1;
  if (alpha === 1) return `#${[r, g, b].map((c) => (c ?? 0).toString(16).padStart(2, '0')).join('')}`;
  return `rgb(${r} ${g} ${b} / ${num(alpha)})`;
}

function formatFontFamily(value: Json): string {
  const names = Array.isArray(value) ? value : [value];
  return names.map((n) => (/^[A-Za-z0-9-]+$/.test(String(n)) ? String(n) : `"${String(n)}"`)).join(', ');
}

function formatUnit(value: Json): string {
  if (!isObject(value)) throw new Error('invalid dimension or duration');
  return `${num(value['value'] as number)}${String(value['unit'])}`;
}

function formatShadowLayer(layer: Json): string {
  if (!isObject(layer)) throw new Error('invalid shadow');
  const parts = [layer['offsetX'], layer['offsetY'], layer['blur'], layer['spread']].map((d) => formatUnit(d ?? null));
  return `${layer['inset'] === true ? 'inset ' : ''}${parts.join(' ')} ${formatColor(layer['color'] ?? null)}`;
}

export function formatValue(type: string, value: Json): string {
  switch (type) {
    case 'color':
      return formatColor(value);
    case 'dimension':
    case 'duration':
      return formatUnit(value);
    case 'fontFamily':
      return formatFontFamily(value);
    case 'fontWeight':
      return typeof value === 'number' ? String(value) : String(FONT_WEIGHTS[String(value)]);
    case 'number':
      return num(value as number);
    case 'cubicBezier':
      return `cubic-bezier(${(value as number[]).map(num).join(', ')})`;
    case 'shadow':
      return (Array.isArray(value) ? value : [value]).map(formatShadowLayer).join(', ');
    case 'strokeStyle':
      return typeof value === 'string' ? value : 'dashed';
    case 'border': {
      if (!isObject(value)) throw new Error('invalid border');
      return `${formatUnit(value['width'] ?? null)} ${formatValue('strokeStyle', value['style'] ?? null)} ${formatColor(value['color'] ?? null)}`;
    }
    case 'transition': {
      if (!isObject(value)) throw new Error('invalid transition');
      const delay = value['delay'] === undefined ? '' : ` ${formatUnit(value['delay'])}`;
      return `${formatUnit(value['duration'] ?? null)} ${formatValue('cubicBezier', value['timingFunction'] ?? null)}${delay}`;
    }
    default:
      throw new Error(`cannot format $type ${type}`);
  }
}

/** One token to its CSS declarations. Typography expands per field. */
export function declarations(token: Token): Array<[string, string]> {
  if (token.type === 'typography') {
    if (!isObject(token.value)) throw new Error(`${token.path}: invalid typography`);
    const value = token.value;
    const types: Record<string, string> = {
      fontFamily: 'fontFamily', fontSize: 'dimension', fontWeight: 'fontWeight', lineHeight: 'number', letterSpacing: 'dimension',
    };
    return Object.entries(TYPOGRAPHY_FIELDS)
      .filter(([field]) => field in value)
      .map(([field, suffix]) => [`${cssVarName(token.path)}-${suffix}`, formatValue(types[field] ?? '', value[field] ?? null)]);
  }
  return [[cssVarName(token.path), formatValue(token.type, token.value)]];
}

function emitted(tokens: Map<string, Token>): Map<string, string> {
  const out = new Map<string, string>();
  for (const token of tokens.values()) {
    if (!EMITTED_GROUPS.includes(token.path.split('.')[0] ?? '')) continue;
    for (const [name, value] of declarations(token)) out.set(name, value);
  }
  return out;
}

function block(selector: string, decls: Array<[string, string]>, indent = ''): string {
  const body = decls.map(([n, v]) => `${indent}  ${n}: ${v};`).join('\n');
  return `${indent}${selector} {\n${body}\n${indent}}`;
}

export interface CssOptions {
  /** Shown in the header comment. */
  source: string;
}

export function buildCss(modes: ResolvedMode[], options: CssOptions): string {
  const perMode = modes.map((mode) => ({ mode, vars: emitted(mode.tokens) }));
  const names = [...new Set(perMode.flatMap(({ vars }) => [...vars.keys()]))].sort();
  const shared = names.filter((n) => new Set(perMode.map(({ vars }) => vars.get(n))).size === 1);
  const varying = names.filter((n) => !shared.includes(n));
  const first = perMode[0];
  if (!first) throw new Error('no modes to build');

  const out = [
    `/* Generated by @ds/tokens from ${options.source}. Do not edit; edit the tokens and rebuild. */`,
    block(':root', shared.map((n) => [n, first.vars.get(n) ?? ''])),
  ];

  const scheme = (name: string): Array<[string, string]> =>
    name === 'light' || name === 'dark' ? [['color-scheme', name]] : [];

  for (const { mode, vars } of perMode) {
    const decls: Array<[string, string]> = [...scheme(mode.name), ...varying.map((n): [string, string] => [n, vars.get(n) ?? ''])];
    if (!mode.name) continue;
    const selector = mode.isDefault ? `:root,\n[data-mode="${mode.name}"]` : `[data-mode="${mode.name}"]`;
    out.push(block(selector, decls));
    if (mode.name === 'dark' && !mode.isDefault) {
      const def = perMode.find((m) => m.mode.isDefault)?.mode.name ?? 'light';
      out.push(`@media (prefers-color-scheme: dark) {\n${block(`:root:not([data-mode="${def}"])`, decls, '  ')}\n}`);
    }
  }

  const reduced = first.mode.tokens.get('motion.duration.reduced');
  if (reduced) {
    const value = formatValue(reduced.type, reduced.value);
    const durations = names.filter((n) => n.startsWith('--motion-duration-') && n !== '--motion-duration-reduced');
    out.push(`@media (prefers-reduced-motion: reduce) {\n${block(':root', durations.map((n) => [n, value]), '  ')}\n}`);
  }

  return `${out.join('\n\n')}\n`;
}

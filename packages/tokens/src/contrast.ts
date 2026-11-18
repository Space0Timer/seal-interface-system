// Checks the foreground/background pairs in contrast-pairs.json for every mode.
// A background is a stack: the first entry is opaque, later entries are
// composited over it. Ratios use the WCAG 2 formula.
import { readFileSync } from 'node:fs';
import { isObject, type ResolvedMode } from './resolve.ts';

export interface PairRule {
  use: string;
  kind: 'text' | 'non-text';
  minimum: number;
  foreground: string[];
  background: string[][];
}

export interface PairResult {
  mode: string;
  foreground: string;
  background: string[];
  ratio: number;
  minimum: number;
  pass: boolean;
}

type Rgba = { rgb: [number, number, number]; alpha: number };

function colorOf(mode: ResolvedMode, path: string): Rgba {
  const token = mode.tokens.get(path);
  if (!token || token.type !== 'color' || !isObject(token.value)) throw new Error(`[${mode.name}] ${path} is not a color token`);
  const [r = 0, g = 0, b = 0] = token.value['components'] as number[];
  const alpha = typeof token.value['alpha'] === 'number' ? token.value['alpha'] : 1;
  return { rgb: [r, g, b], alpha };
}

function over(top: Rgba, bottom: [number, number, number]): [number, number, number] {
  return [0, 1, 2].map((i) => top.rgb[i]! * top.alpha + bottom[i]! * (1 - top.alpha)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export function loadPairRules(path: string): PairRule[] {
  const doc = JSON.parse(readFileSync(path, 'utf8')) as { rules: PairRule[] };
  return doc.rules;
}

export function checkPairs(rules: PairRule[], modes: ResolvedMode[]): PairResult[] {
  const results: PairResult[] = [];
  for (const mode of modes) {
    for (const rule of rules) {
      for (const foreground of rule.foreground) {
        for (const background of rule.background) {
          const [base, ...layers] = background;
          if (!base) continue;
          let bg = colorOf(mode, base).rgb;
          for (const layer of layers) bg = over(colorOf(mode, layer), bg);
          const ratio = contrastRatio(over(colorOf(mode, foreground), bg), bg);
          results.push({ mode: mode.name, foreground, background, ratio, minimum: rule.minimum, pass: ratio >= rule.minimum });
        }
      }
    }
  }
  return results;
}

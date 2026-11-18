// Loads a DTCG 2025.10 resolver document, merges its sources for each mode,
// and resolves aliases. Collects validation errors instead of throwing, so a
// check can report every problem at once.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface Token {
  path: string;
  type: string;
  value: Json;
  description?: string;
}

export interface ResolvedMode {
  name: string;
  isDefault: boolean;
  tokens: Map<string, Token>;
}

export interface Resolution {
  modifier: string | undefined;
  modes: ResolvedMode[];
  errors: string[];
}

type Source = JsonObject;

interface ResolverDoc {
  version: string;
  sets?: Record<string, { sources: Source[] }>;
  modifiers?: Record<string, { default?: string; contexts: Record<string, Source[]> }>;
  resolutionOrder: Array<{ $ref: string }>;
}

const ALIAS = /^\{([^{}]+)\}$/;

const COMPOSITE_FIELDS: Record<string, Record<string, string>> = {
  typography: {
    fontFamily: 'fontFamily',
    fontSize: 'dimension',
    fontWeight: 'fontWeight',
    letterSpacing: 'dimension',
    lineHeight: 'number',
  },
  shadow: { color: 'color', offsetX: 'dimension', offsetY: 'dimension', blur: 'dimension', spread: 'dimension' },
  border: { color: 'color', width: 'dimension', style: 'strokeStyle' },
  transition: { duration: 'duration', delay: 'duration', timingFunction: 'cubicBezier' },
};

const FONT_WEIGHT_NAMES = new Set([
  'thin', 'hairline', 'extra-light', 'ultra-light', 'light', 'normal', 'regular', 'book', 'medium',
  'semi-bold', 'demi-bold', 'bold', 'extra-bold', 'ultra-bold', 'black', 'heavy', 'extra-black', 'ultra-black',
]);

export function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, 'utf8')) as Json;
}

function clone<T extends Json>(value: T): T {
  return structuredClone(value);
}

/** Deep-merges token documents. Tokens (objects with $value) replace; groups merge. */
function merge(target: JsonObject, source: JsonObject): JsonObject {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (isObject(existing) && isObject(value) && !('$value' in value) && !('$value' in existing)) {
      merge(existing, value);
    } else {
      target[key] = clone(value);
    }
  }
  return target;
}

function loadSources(baseDir: string, sources: Source[], errors: string[]): JsonObject {
  const merged: JsonObject = {};
  for (const source of sources) {
    const ref = source['$ref'];
    if (typeof ref === 'string') {
      try {
        const doc = readJson(join(baseDir, ref));
        if (isObject(doc)) merge(merged, doc);
        else errors.push(`${ref}: not a JSON object`);
      } catch (error) {
        errors.push(`${ref}: ${(error as Error).message}`);
      }
    } else {
      merge(merged, source);
    }
  }
  return merged;
}

function buildTree(
  baseDir: string,
  doc: ResolverDoc,
  input: Record<string, string>,
  errors: string[],
): JsonObject {
  const tree: JsonObject = {};
  for (const step of doc.resolutionOrder) {
    const [, kind, name] = step.$ref.split('/');
    if (kind === 'sets' && name && doc.sets?.[name]) {
      merge(tree, loadSources(baseDir, doc.sets[name].sources, errors));
    } else if (kind === 'modifiers' && name && doc.modifiers?.[name]) {
      const modifier = doc.modifiers[name];
      const context = input[name] ?? modifier.default;
      const sources = context === undefined ? undefined : modifier.contexts[context];
      if (sources) merge(tree, loadSources(baseDir, sources, errors));
      else errors.push(`modifier ${name}: no context ${String(context)}`);
    } else {
      errors.push(`resolutionOrder: cannot resolve ${step.$ref}`);
    }
  }
  return tree;
}

interface RawToken {
  type: string | undefined;
  value: Json;
  description?: string;
}

function flatten(tree: JsonObject, errors: string[]): Map<string, RawToken> {
  const out = new Map<string, RawToken>();
  const walk = (node: JsonObject, path: string[], inherited: string | undefined): void => {
    const groupType = typeof node['$type'] === 'string' ? node['$type'] : inherited;
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$')) continue;
      const childPath = [...path, key];
      const name = childPath.join('.');
      if (/[{}.]/.test(key)) errors.push(`${name}: invalid name`);
      if (!isObject(child)) {
        errors.push(`${name}: expected an object`);
        continue;
      }
      if ('$value' in child) {
        if (Object.keys(child).some((k) => !k.startsWith('$'))) errors.push(`${name}: token has children`);
        const description = child['$description'];
        out.set(name, {
          type: typeof child['$type'] === 'string' ? child['$type'] : groupType,
          value: child['$value'] ?? null,
          ...(typeof description === 'string' ? { description } : {}),
        });
      } else {
        walk(child, childPath, groupType);
      }
    }
  };
  walk(tree, [], undefined);
  return out;
}

function validateValue(path: string, type: string, value: Json, errors: string[]): void {
  const fail = (why: string): void => {
    errors.push(`${path}: ${why}`);
  };
  const unit = (v: Json, units: string[]) =>
    isObject(v) && typeof v['value'] === 'number' && typeof v['unit'] === 'string' && units.includes(v['unit']);
  switch (type) {
    case 'color': {
      if (!isObject(value)) return fail('color must be an object');
      const { colorSpace, components, alpha } = value;
      if (colorSpace !== 'srgb') return fail(`unsupported colorSpace ${String(colorSpace)}`);
      if (!Array.isArray(components) || components.length !== 3) return fail('srgb needs 3 components');
      if (!components.every((c) => typeof c === 'number' && c >= 0 && c <= 1)) fail('srgb components must be 0–1');
      if (alpha !== undefined && (typeof alpha !== 'number' || alpha < 0 || alpha > 1)) fail('alpha must be 0–1');
      return;
    }
    case 'dimension':
      if (!unit(value, ['px', 'rem'])) fail('dimension needs { value, unit: px | rem }');
      return;
    case 'duration':
      if (!unit(value, ['ms', 's'])) fail('duration needs { value, unit: ms | s }');
      return;
    case 'fontFamily':
      if (!(typeof value === 'string' || (Array.isArray(value) && value.every((v) => typeof v === 'string'))))
        fail('fontFamily must be a string or string array');
      return;
    case 'fontWeight':
      if (!((typeof value === 'number' && value >= 1 && value <= 1000) || (typeof value === 'string' && FONT_WEIGHT_NAMES.has(value))))
        fail('fontWeight must be 1–1000 or a named weight');
      return;
    case 'cubicBezier':
      if (!(Array.isArray(value) && value.length === 4 && value.every((v) => typeof v === 'number')))
        return fail('cubicBezier needs four numbers');
      if ([value[0], value[2]].some((x) => (x as number) < 0 || (x as number) > 1)) fail('cubicBezier x values must be 0–1');
      return;
    case 'number':
      if (typeof value !== 'number') fail('number expected');
      return;
    case 'strokeStyle':
      if (typeof value !== 'string' && !isObject(value)) fail('strokeStyle must be a string or object');
      return;
    default: {
      const fields = COMPOSITE_FIELDS[type];
      if (!fields) return fail(`unsupported $type ${type}`);
      const layers = type === 'shadow' && Array.isArray(value) ? value : [value];
      for (const layer of layers) {
        if (!isObject(layer)) {
          fail(`${type} value must be an object`);
          continue;
        }
        for (const [field, fieldType] of Object.entries(fields)) {
          if (!(field in layer)) {
            if (!(type === 'transition' && field === 'delay')) fail(`${type} is missing ${field}`);
            continue;
          }
          validateValue(`${path}.${field}`, fieldType, layer[field] ?? null, errors);
        }
      }
    }
  }
}

function resolveAll(raw: Map<string, RawToken>, errors: string[]): Map<string, Token> {
  const typeOf = (path: string, seen: string[] = []): string | undefined => {
    const token = raw.get(path);
    if (!token) return undefined;
    if (token.type) return token.type;
    const match = typeof token.value === 'string' ? ALIAS.exec(token.value) : null;
    if (match?.[1] && !seen.includes(path)) return typeOf(match[1], [...seen, path]);
    return undefined;
  };

  const resolveRef = (where: string, value: Json, expected: string, seen: string[]): Json => {
    const match = typeof value === 'string' ? ALIAS.exec(value) : null;
    if (!match?.[1]) return value;
    const target = match[1];
    const token = raw.get(target);
    if (!token) {
      errors.push(`${where}: unresolved alias ${String(value)}`);
      return null;
    }
    if (seen.includes(target)) {
      errors.push(`${where}: circular alias ${[...seen, target].join(' -> ')}`);
      return null;
    }
    const targetType = typeOf(target);
    if (targetType !== expected) {
      errors.push(`${where}: ${String(value)} is ${String(targetType)}, expected ${expected}`);
      return null;
    }
    return resolveValue(target, token.value, expected, [...seen, target]);
  };

  const resolveValue = (where: string, value: Json, type: string, seen: string[]): Json => {
    const direct = resolveRef(where, value, type, seen);
    if (direct !== value) return direct;
    const fields = COMPOSITE_FIELDS[type];
    if (!fields) return value;
    const resolveLayer = (layer: Json): Json => {
      if (typeof layer === 'string') return resolveRef(where, layer, type, seen);
      if (!isObject(layer)) return layer;
      const out: JsonObject = { ...layer };
      for (const [field, fieldType] of Object.entries(fields)) {
        if (field in layer) out[field] = resolveValue(`${where}.${field}`, layer[field] ?? null, fieldType, seen);
      }
      return out;
    };
    return Array.isArray(value) ? value.map(resolveLayer) : resolveLayer(value);
  };

  const tokens = new Map<string, Token>();
  for (const [path, token] of raw) {
    const type = typeOf(path);
    if (!type) {
      errors.push(`${path}: no $type (set it on the token or a parent group)`);
      continue;
    }
    const value = resolveValue(path, token.value, type, [path]);
    if (value === null) continue;
    validateValue(path, type, value, errors);
    tokens.set(path, { path, type, value, ...(token.description ? { description: token.description } : {}) });
  }
  return tokens;
}

/** Resolves every context of the resolver's modifier (or the base alone if there is none). */
export function resolveTokens(resolverPath: string): Resolution {
  const errors: string[] = [];
  const doc = readJson(resolverPath) as unknown as ResolverDoc;
  if (doc.version !== '2025.10') errors.push(`resolver version must be "2025.10", got ${String(doc.version)}`);
  const baseDir = dirname(resolverPath);
  const modifierNames = Object.keys(doc.modifiers ?? {});
  if (modifierNames.length > 1) errors.push('only one modifier (the mode) is supported');
  const modifier = modifierNames[0];

  const contexts = modifier ? Object.keys(doc.modifiers?.[modifier]?.contexts ?? {}) : [''];
  const defaultContext = modifier ? (doc.modifiers?.[modifier]?.default ?? contexts[0]) : '';

  const modes = contexts.map((name) => {
    const modeErrors: string[] = [];
    const tree = buildTree(baseDir, doc, modifier ? { [modifier]: name } : {}, modeErrors);
    const tokens = resolveAll(flatten(tree, modeErrors), modeErrors);
    errors.push(...modeErrors.map((e) => (name ? `[${name}] ${e}` : e)));
    return { name, isDefault: name === defaultContext, tokens };
  });

  const [first, ...rest] = modes;
  for (const mode of rest) {
    if (!first) break;
    const missing = [...first.tokens.keys()].filter((p) => !mode.tokens.has(p));
    const extra = [...mode.tokens.keys()].filter((p) => !first.tokens.has(p));
    if (missing.length) errors.push(`[${mode.name}] missing tokens defined in ${first.name}: ${missing.join(', ')}`);
    if (extra.length) errors.push(`[${mode.name}] tokens not defined in ${first.name}: ${extra.join(', ')}`);
  }

  return { modifier, modes, errors: [...new Set(errors)] };
}

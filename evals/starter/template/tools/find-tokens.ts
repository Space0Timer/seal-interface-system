// Finds DTCG design tokens (a tokens.resolver.json) in this workspace.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const RESOLVER = 'tokens.resolver.json';

/** How many folders below the workspace root the search goes. */
export const MAX_DEPTH = 4;

/** Folders that are never searched. */
export const SKIP = new Set(['node_modules', 'dist', 'src', 'tools', 'upload-files', 'replacement-files', '.git', '.vite']);

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory(); // follows links
  } catch {
    return false;
  }
}

/** The first tokens.resolver.json found, searching up to MAX_DEPTH folders deep. */
export function findResolver(root: string, depth = MAX_DEPTH): string | undefined {
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  if (entries.some((e) => e.name === RESOLVER && !isDirectory(join(root, e.name)))) return join(root, RESOLVER);
  if (depth === 0) return undefined;
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (SKIP.has(entry.name) || !(entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(path)))) continue;
    const found = findResolver(path, depth - 1);
    if (found) return found;
  }
  return undefined;
}

/** Whether findResolver would reach a resolver at this workspace-relative path. */
export function isDiscoverable(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  const folders = parts.slice(0, -1);
  return parts.at(-1) === RESOLVER && folders.length <= MAX_DEPTH && !folders.some((f) => SKIP.has(f));
}

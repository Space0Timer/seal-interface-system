// File helpers for runs: content hashes, and workspace snapshots and diffs.
// Copying out of the workspace is copy.ts's job.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface WalkOptions {
  /** Folder names skipped at any depth. */
  skipAnywhere?: string[];
  /** Paths (relative, with /) skipped. */
  skipPaths?: string[];
}

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const posix = (rel: string) => rel.split(sep).join('/');

/** Every file and link under root, relative with forward slashes, sorted. Links are never followed. */
export function walk(root: string, { skipAnywhere = [], skipPaths = [] }: WalkOptions = {}): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = posix(relative(root, path));
      if (skipPaths.includes(rel)) continue;
      if (entry.isDirectory()) {
        if (!skipAnywhere.includes(entry.name)) visit(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.push(rel);
      }
    }
  };
  visit(root);
  return out.sort();
}

/** A file's content hash; for a link, a hash of where it points. */
export function hashEntry(path: string): string {
  const stat = lstatSync(path);
  return stat.isSymbolicLink() ? `link:${sha256(readlinkSync(path))}` : sha256(readFileSync(path));
}

/** One hash for a whole tree: its sorted relative paths and their content hashes. */
export function hashTree(root: string, options: WalkOptions = {}): string {
  const lines = walk(root, options).map((rel) => `${rel}\0${hashEntry(join(root, rel))}\n`);
  return sha256(lines.join(''));
}

export type Snapshot = Map<string, string>;

export function snapshot(root: string, options: WalkOptions = {}): Snapshot {
  return new Map(walk(root, options).map((rel) => [rel, hashEntry(join(root, rel))]));
}

export interface Diff {
  added: string[];
  changed: string[];
  deleted: string[];
}

export function diff(before: Snapshot, after: Snapshot): Diff {
  const added = [...after.keys()].filter((rel) => !before.has(rel));
  const changed = [...after.keys()].filter((rel) => before.has(rel) && before.get(rel) !== after.get(rel));
  const deleted = [...before.keys()].filter((rel) => !after.has(rel));
  return { added, changed, deleted };
}

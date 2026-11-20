// Copies files out of a folder the generated code could still change: the
// generator's output out of its workspace into the results, and the build's
// dist/ into the folder the runner serves. A process left running could swap
// a file or folder for a link to the host between two steps of a copy, so
// the runner never reads these folders with its own permissions. A separate
// helper process copies them, confined (see confineCopy) to reading only
// the folder it copies from, the Node install and the OS runtime, and to
// writing only the folder it copies to. It also opens each file without
// following links and checks the type of what it opened. Links are
// recorded, never copied or followed.
import { spawnSync } from 'node:child_process';
import type { Launch } from './confine.ts';

export interface CopyResult {
  copied: string[];
  /** Links found among the files, recorded but never copied or followed. */
  links: Array<{ path: string; target: string }>;
}

export interface ConfinedCopy extends CopyResult {
  /** False if the folder copied from isn't a folder (it's missing, or a link). Nothing is copied then. */
  found: boolean;
  /** Entries the copy couldn't or wouldn't take, and why (a sandbox refusal shows as EPERM). */
  refused: Array<{ path: string; reason: string }>;
  /** Every file and link the copy saw, with its hash as hashEntry in files.ts computes it. */
  hashes: Map<string, string>;
}

export interface CopyOptions {
  /** Folder names skipped at any depth. */
  skipAnywhere?: string[] | undefined;
  /** Paths (relative, with /) skipped. */
  skipPaths?: string[] | undefined;
  /** If given, only files and links that are new or changed since this snapshot are copied, plus everything under `keep`. */
  before?: Map<string, string> | undefined;
  /** Folders (relative, with /) copied whole. */
  keep?: string[] | undefined;
}

/** The copy helper, run as `node -e HELPER <from> <to> <options>`. Self-contained, so it reads nothing of the repo. */
export const COPY_HELPER = `
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const [from, to, json] = process.argv.slice(1);
const options = JSON.parse(json);
const skipAnywhere = new Set(options.skipAnywhere);
const skipPaths = new Set(options.skipPaths);
const before = options.before && new Map(options.before);
const out = { found: false, copied: [], links: [], refused: [], hashes: [] };
const reason = (error) => (error && error.code) || String(error);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const wanted = (rel, hash) => !before || options.keep.some((dir) => rel.startsWith(dir + '/')) || before.get(rel) !== hash;
const copyFile = (rel) => {
  let fd;
  try {
    // Never through a link at the last step, never waiting on a pipe, and the type checked on what was opened, so
    // nothing can swap in between.
    fd = fs.openSync(path.join(from, rel), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) return out.refused.push({ path: rel, reason: 'not a regular file' });
    const data = fs.readFileSync(fd);
    const hash = sha256(data);
    out.hashes.push([rel, hash]);
    if (!wanted(rel, hash)) return;
    const target = path.join(to, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { flag: 'wx' });
    out.copied.push(rel);
  } catch (error) {
    out.refused.push({ path: rel, reason: reason(error) });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
};
let seen = 0;
const visit = (rel, depth) => {
  if (depth > 32) return out.refused.push({ path: rel, reason: 'nested too deep' });
  let entries;
  try {
    entries = fs.readdirSync(path.join(from, rel), { withFileTypes: true });
  } catch (error) {
    return out.refused.push({ path: rel || '.', reason: reason(error) });
  }
  for (const entry of entries) {
    if (++seen > 20000) return out.refused.push({ path: rel || '.', reason: 'too many files' });
    const child = rel ? rel + '/' + entry.name : entry.name;
    if (skipPaths.has(child)) continue;
    if (entry.isSymbolicLink()) {
      let target = '';
      try {
        target = fs.readlinkSync(path.join(from, child));
      } catch {}
      const hash = 'link:' + sha256(target);
      out.hashes.push([child, hash]);
      if (wanted(child, hash)) out.links.push({ path: child, target });
    } else if (entry.isDirectory()) {
      if (!skipAnywhere.has(entry.name)) visit(child, depth + 1);
    } else if (entry.isFile()) copyFile(child);
    else out.refused.push({ path: child, reason: 'not a regular file' });
  }
};
let top;
try {
  top = fs.lstatSync(from);
} catch {}
out.found = !!top && top.isDirectory();
if (out.found) visit('', 0);
out.copied.sort();
out.links.sort((a, b) => (a.path < b.path ? -1 : 1));
out.refused.sort((a, b) => (a.path < b.path ? -1 : 1));
// No process.exit: a report larger than the pipe's buffer is still being written. Node exits once it's flushed.
process.stdout.write(JSON.stringify(out));
`;

/** Copies from into to, which must exist, with the confined helper. Links are recorded and never followed. */
export function confinedCopy(from: string, to: string, launch: Launch, options: CopyOptions = {}): ConfinedCopy {
  const settings = {
    skipAnywhere: options.skipAnywhere ?? [],
    skipPaths: options.skipPaths ?? [],
    before: options.before ? [...options.before] : null,
    keep: options.keep ?? [],
  };
  const [command, args] = launch.wrap(process.execPath, ['-e', COPY_HELPER, from, to, JSON.stringify(settings)]);
  const result = spawnSync(command, args, { env: launch.env, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`copying ${from} failed (exit ${result.status ?? result.signal}): ${result.stderr || result.error?.message || ''}`);
  const report = JSON.parse(result.stdout) as Omit<ConfinedCopy, 'hashes'> & { hashes: Array<[string, string]> };
  return { ...report, hashes: new Map(report.hashes) };
}

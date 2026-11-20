// Where node and pnpm live and what they need, so a confined process (an
// agent's sandboxed session, or a workspace's build and preview server) can
// run them with an environment built from scratch: their installs stay
// readable even when the home folder they sit under is hidden.
//
// Not copied into workspaces.
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

export function onPath(name: string): string | undefined {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    const candidate = join(dir, name);
    if (dir && existsSync(candidate)) return candidate;
  }
  return undefined;
}

export interface Toolchain {
  /** PATH entries for node and pnpm. */
  binDirs: string[];
  /** Folders a sandbox must keep readable: the Node and pnpm installs and corepack's cache. Real paths. */
  roots: string[];
  /** Variables node and pnpm need, such as where corepack keeps the pinned pnpm. */
  env: Record<string, string>;
}

export function toolchain(): Toolchain {
  const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
  const pnpmBin = onPath('pnpm');
  const pnpmRoot = pnpmBin ? dirname(dirname(realpathSync(pnpmBin))) : undefined;
  // A corepack pnpm shim needs corepack's cache of the pinned pnpm, which lives under the real home.
  const corepackHome = process.env['COREPACK_HOME'] ?? join(homedir(), '.cache', 'node', 'corepack');
  const corepack = existsSync(corepackHome) ? realpathSync(corepackHome) : undefined;
  return {
    binDirs: [...new Set([dirname(process.execPath), ...(pnpmBin ? [dirname(pnpmBin)] : [])])],
    roots: [...new Set([nodeRoot, ...(pnpmRoot ? [pnpmRoot] : []), ...(corepack ? [corepack] : [])])],
    env: corepack ? { COREPACK_HOME: corepack, COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' } : {},
  };
}

/** PATH for a confined process: the toolchain first, then the system folders. */
export function confinedPath(binDirs: string[]): string {
  return [...new Set([...binDirs, '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
}

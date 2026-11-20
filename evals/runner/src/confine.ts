// Confines the generated app's own code after generation: its build, and its
// preview server, which loads its Vite config and its copy of the mock API.
// Both run code the generator could have written, outside the generation
// sandbox, so they get the same treatment:
// - An environment built from an explicit allowlist, with a fresh home and
//   temp folder. Nothing the runner holds, such as CLAUDE_CODE_OAUTH_TOKEN
//   on a live run, is inherited.
// - On macOS, an OS sandbox (sandbox-exec) that can't read the owner's home,
//   the system temp folders, the repo checkouts or the results, except the
//   workspace, its own state and the node and pnpm installs; can write only
//   to the workspace and its own state; has no network beyond localhost; and
//   can't inspect other processes or ask the keychain for anything.
// So generated code can neither reach the host's files and credentials nor
// copy them into the build and preview logs the run keeps.
//
// Elsewhere only the environment is confined, so live runs refuse to start
// there (see runEval).
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { confinedPath, type Toolchain } from '../../starter/src/toolchain.ts';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export interface ConfineInput {
  workspace: string;
  /** A private folder outside the workspace for the fresh home and temp folder. */
  stateDir: string;
  /** Folders the confined process must never read. Real paths. */
  hidden: string[];
  toolchain: Toolchain;
}

export interface ConfinementRecord {
  sandbox: 'sandbox-exec' | 'none';
  /** The whole environment. It holds only paths and switches, never a secret. */
  env: Record<string, string>;
  hidden: string[];
  profile?: string | undefined;
}

export interface Confinement {
  env: Record<string, string>;
  /** The command line that runs `command args` confined. */
  wrap(command: string, args: string[]): [string, string[]];
  record: ConfinementRecord;
}

export function sandboxAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' && existsSync(SANDBOX_EXEC);
}

function statePaths(stateDir: string) {
  return { home: join(stateDir, 'home'), tmp: join(stateDir, 'tmp') };
}

/** The allowlist: nothing else from the runner's environment gets through. */
export function confinedEnv({ stateDir, toolchain }: ConfineInput): Record<string, string> {
  const { home, tmp } = statePaths(stateDir);
  return {
    PATH: confinedPath(toolchain.binDirs),
    HOME: home,
    TMPDIR: tmp,
    LANG: 'en_US.UTF-8',
    ...toolchain.env,
    // pnpm would otherwise try to reinstall before `pnpm build`, because the
    // fresh home points it at a different store. The workspace was installed
    // from its lockfile before generation, and the sandbox has no network.
    pnpm_config_verify_deps_before_run: 'false',
  };
}

const q = (path: string) => JSON.stringify(path);
const subpaths = (paths: string[]) => paths.map((p) => `(subpath ${q(p)})`).join(' ');

export function seatbeltProfile({ workspace, stateDir, hidden, toolchain }: ConfineInput): string {
  const own = [workspace, stateDir];
  return [
    '(version 1)',
    '(allow default)',
    '; Reads: nothing under the hidden folders except the workspace, its own state and the toolchain.',
    `(deny file-read* ${subpaths([...new Set(hidden)])})`,
    '; Metadata stays readable, since Node resolves real paths through the parent folders.',
    '(allow file-read-metadata)',
    `(allow file-read* ${subpaths([...own, ...toolchain.roots])})`,
    '; Writes: only the workspace, its own state and the standard devices.',
    '(deny file-write*)',
    `(allow file-write* ${subpaths(own)} (regex #"^/dev/(null|zero|tty[^/]*|fd/[0-9]+|dtracehelper|stdout|stderr)$"))`,
    '; Network: localhost only. Name lookups go through mDNSResponder; every other Unix socket is closed.',
    '; The last matching rule wins, so the localhost allow comes last.',
    '(deny network-outbound (remote unix-socket))',
    '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    '(deny network-outbound (remote ip "*:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
    "; No other process's arguments or environment, and no keychain.",
    '(deny process-info* (target others))',
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") (global-name "com.apple.security.agent"))',
    '',
  ].join('\n');
}

/** Sets up the private state and returns how to run a command confined. */
export function confine(input: ConfineInput, { sandbox = sandboxAvailable() }: { sandbox?: boolean } = {}): Confinement {
  const { home, tmp } = statePaths(input.stateDir);
  for (const dir of [home, tmp]) mkdirSync(dir, { recursive: true });
  const env = confinedEnv(input);
  const hidden = [...new Set(input.hidden)];
  if (!sandbox) {
    return { env, wrap: (command, args) => [command, args], record: { sandbox: 'none', env, hidden } };
  }
  const profile = seatbeltProfile({ ...input, hidden });
  return {
    env,
    wrap: (command, args) => [SANDBOX_EXEC, ['-p', profile, command, ...args]],
    record: { sandbox: 'sandbox-exec', env, hidden, profile },
  };
}

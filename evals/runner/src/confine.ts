// Confines the generated app's build. `pnpm build` runs code the generator
// could have written (the build script, the Vite config and its plugins)
// outside the generation sandbox, so it gets:
// - An environment built from an explicit allowlist, with a fresh home and
//   temp folder. Nothing the runner holds, such as CLAUDE_CODE_OAUTH_TOKEN
//   on a live run, is inherited.
// - On macOS, an OS sandbox (sandbox-exec) that reads nothing by default.
//   It may read only the OS runtime, the node and pnpm installs, the
//   workspace and its own state, and never the repo checkouts or the
//   results. It can write only to the workspace and its own state, has no
//   outbound network access, and can't inspect other processes or ask the
//   keychain for anything.
// So generated code can neither reach the host's files and credentials
// (in the home folder, on a mounted volume, in a shared folder) nor copy
// them into the build log the run keeps.
//
// Files leave the workspace only through a helper confined the same way
// (see copy.ts): the generator's output into the results, and the build's
// output into the folder the runner serves. It can read only the folder it
// copies from, the Node install and the OS runtime, and write only the
// folder it copies to. So a process left running can't swap a host file
// into either.
//
// Elsewhere only the environment is confined, so live runs refuse to start
// there (see runEval). The runner serves the copy itself, so no other
// generated code runs outside the browser.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { confinedPath, type Toolchain } from '../../starter/src/toolchain.ts';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** The OS runtime a build reads: system binaries, libraries and frameworks, /etc, time zones and devices. */
export const SYSTEM_READ = ['/usr/bin', '/usr/sbin', '/usr/lib', '/usr/libexec', '/usr/share', '/bin', '/sbin', '/System', '/private/etc', '/private/var/db/timezone', '/dev'];
/** The root and the top-level links into /private, which path lookups pass through. */
const SYSTEM_READ_LITERAL = ['/', '/etc', '/var', '/tmp'];

export interface ConfineInput {
  workspace: string;
  /** A private folder outside the workspace for the fresh home and temp folder. */
  stateDir: string;
  /** Paths never readable, even inside an allowed folder: the repo checkouts, the results, ~/.claude. Real paths. */
  forbidden: string[];
  toolchain: Toolchain;
}

export interface ConfinementRecord {
  sandbox: 'sandbox-exec' | 'none';
  /** The whole environment. It holds only paths and switches, never a secret. */
  env: Record<string, string>;
  /** Everything the build may read. */
  readable: string[];
  forbidden: string[];
  profile?: string | undefined;
}

/** How to launch a confined process: its whole environment, and the command line that runs `command args` confined. */
export interface Launch {
  env: Record<string, string>;
  wrap(command: string, args: string[]): [string, string[]];
}

export interface Confinement extends Launch {
  record: ConfinementRecord;
}

/** What a sandbox may touch, besides the OS runtime it always reads. Real paths. */
export interface SandboxPolicy {
  /** Readable installs, such as Node's. */
  tools: string[];
  /** Readable data, readable even inside a forbidden path. */
  data: string[];
  write: string[];
  /** Never readable, even inside a tool. */
  forbidden: string[];
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

const buildPolicy = ({ workspace, stateDir, toolchain, forbidden }: ConfineInput): SandboxPolicy => ({
  tools: toolchain.roots,
  data: [workspace, stateDir],
  write: [workspace, stateDir],
  forbidden,
});

/** Every folder a sandbox with this policy may read. */
export function readableUnder({ tools, data }: SandboxPolicy): string[] {
  return [...new Set([...SYSTEM_READ, ...tools, ...data])];
}

/** Every folder the build may read. */
export function readable(input: ConfineInput): string[] {
  return readableUnder(buildPolicy(input));
}

const q = (path: string) => JSON.stringify(path);
const subpaths = (paths: string[]) => paths.map((p) => `(subpath ${q(p)})`).join(' ');

export function sandboxProfile(policy: SandboxPolicy): string {
  const forbidden = [...new Set(policy.forbidden)];
  return [
    '(version 1)',
    '(allow default)',
    '; The last matching rule wins.',
    '; Reads: nothing, except the OS runtime, the tools and the data.',
    '(deny file-read*)',
    '; Metadata stays readable, since Node resolves real paths through the parent folders.',
    '(allow file-read-metadata)',
    `(allow file-read* ${SYSTEM_READ_LITERAL.map((p) => `(literal ${q(p)})`).join(' ')} ${subpaths(readableUnder(policy))})`,
    ...(forbidden.length
      ? ['; Never the repo checkouts, the results or ~/.claude, even inside an allowed folder.', `(deny file-read* ${subpaths(forbidden)})`, `(allow file-read* ${subpaths(policy.data)})`]
      : []),
    '; Writes: only the writable folders and the standard devices.',
    '(deny file-write*)',
    `(allow file-write* ${subpaths(policy.write)} (regex #"^/dev/(null|zero|tty[^/]*|fd/[0-9]+|dtracehelper|stdout|stderr)$"))`,
    '; Neither the build nor its copy helper makes network requests.',
    '(deny network-outbound)',
    "; No other process's arguments or environment, and no keychain.",
    '(deny process-info* (target others))',
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") (global-name "com.apple.security.agent"))',
    '',
  ].join('\n');
}

export function seatbeltProfile(input: ConfineInput): string {
  return sandboxProfile(buildPolicy(input));
}

/** Sets up the private state and returns how to run a command confined. */
export function confine(input: ConfineInput, { sandbox = sandboxAvailable() }: { sandbox?: boolean } = {}): Confinement {
  const { home, tmp } = statePaths(input.stateDir);
  for (const dir of [home, tmp]) mkdirSync(dir, { recursive: true });
  const env = confinedEnv(input);
  const record = { env, readable: readable(input), forbidden: [...new Set(input.forbidden)] };
  if (!sandbox) return { env, wrap: (command, args) => [command, args], record: { sandbox: 'none', ...record } };
  const profile = seatbeltProfile(input);
  return {
    env,
    wrap: (command, args) => [SANDBOX_EXEC, ['-p', profile, command, ...args]],
    record: { sandbox: 'sandbox-exec', ...record, profile },
  };
}

export interface CopyInput {
  /** The folder copied from: the workspace, or the build output. Real path. */
  from: string;
  /** The folder copied to, which only the copy may write. Real path. */
  to: string;
  nodeRoot: string;
  forbidden: string[];
}

/**
 * How to run a copy out of the workspace: Node with no inherited
 * environment, reading only the folder copied from, the Node install and
 * the OS runtime, and writing only the folder copied to.
 */
export function confineCopy(input: CopyInput, { sandbox = sandboxAvailable() }: { sandbox?: boolean } = {}): Launch & { sandbox: ConfinementRecord['sandbox'] } {
  const env = { LANG: 'en_US.UTF-8' };
  if (!sandbox) return { env, wrap: (command, args) => [command, args], sandbox: 'none' };
  const profile = sandboxProfile({ tools: [input.nodeRoot], data: [input.from, input.to], write: [input.to], forbidden: input.forbidden });
  return { env, wrap: (command, args) => [SANDBOX_EXEC, ['-p', profile, command, ...args]], sandbox: 'sandbox-exec' };
}

// Finds and stops whatever a session left running. Killing the CLI's process
// group isn't enough: Claude Code runs each Bash command in a process group
// (and session) of its own, so a process a command started in the
// background keeps running after the CLI exits, still inside the session's
// sandbox, where it can go on changing the workspace.
//
// Nothing a process says about itself proves it's the session's: anyone can
// start a process with the session's HOME, in its workspace. So ownership
// comes from the process tree, checked while the session runs:
// - The CLI's own process group is the session's: the CLI starts in a
//   session of its own, and a process group never spans sessions.
// - Every shell Claude Code starts is a small zsh wrapper (watchShells),
//   which registers its PID and waits. The runner checks in the process
//   table that the shell descends from the CLI, records its process group,
//   and only then lets it run. Every process the command leaves in that
//   group is the session's.
// - So is any child of a process that is the session's.
// When the CLI exits, the runner finds candidates: processes whose
// environment sets the session's HOME, or that work in the workspace or that
// HOME. A recorded group is killed when its first process is still the
// shell that registered, or when one of its members is a candidate, so a
// group whose number was reused by now is never mistaken for it. A
// candidate that isn't shown to be the session's is reported and left
// running: it could be the session's, or a diagnostic someone started.
// macOS only: `ps -E` and lsof show the candidates.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, constants, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { Socket } from 'node:net';
import { dirname, join } from 'node:path';

export interface Leftovers {
  /** What was stopped, as `<pid> <command line>`. */
  stopped: string[];
  /** The session's, but still running after every attempt, in the same form. */
  remaining: string[];
  /** Candidates not shown to be the session's, so left running, in the same form. */
  unverified: string[];
}

interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

const CALL = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10_000 } as const;
const uid = () => String(process.getuid?.() ?? '');
const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);
const describe = (procs: Iterable<Proc>) => [...procs].map((p) => `${p.pid} ${p.command.slice(0, 200)}`);
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** This user's processes, without their environments. */
function processTable(): Map<number, Proc> {
  const table = new Map<number, Proc>();
  for (const line of execFileSync('ps', ['-ww', '-U', uid(), '-o', 'pid=,ppid=,pgid=,command='], CALL).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (match) table.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] ?? '' });
  }
  return table;
}

/** When a process started, or undefined if it isn't running. */
function startOf(pid: number): string | undefined {
  const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], CALL);
  return ps.status === 0 ? ps.stdout.trim() || undefined : undefined;
}

/** The shell wrapper's script. It registers its PID, waits for the runner (at most 10 seconds), then runs zsh. */
function wrapper(dir: string): string {
  return `#!/bin/zsh -f
# Registers this shell, then runs zsh.
ready=${quote(join(dir, 'ready'))}.$$
if mkfifo "$ready" 2>/dev/null && exec 3<>"$ready"; then
  print -r -- $$ >> ${quote(join(dir, 'register'))}
  read -r -t 10 -u 3 _
  exec 3<&-
  rm -f "$ready"
fi
exec /bin/zsh "$@"
`;
}

export interface Shells {
  /** Process groups of the shells shown to descend from the CLI, with when each group's first process started. */
  groups: Map<number, string | undefined>;
  close(): void;
}

/**
 * Writes the shell wrapper at shell and listens for its registrations. A
 * shell is recorded only if the process table shows it descends from the
 * CLI, whose PID cli returns once it has started. Whatever registers is let
 * run, so a registration someone else wrote can't hold anything up, and
 * can't get anything recorded either.
 */
export function watchShells(shell: string, cli: () => number | undefined): Shells {
  const dir = dirname(shell);
  mkdirSync(dir, { recursive: true });
  writeFileSync(shell, wrapper(dir));
  chmodSync(shell, 0o755);
  const register = join(dir, 'register');
  execFileSync('mkfifo', [register], CALL);
  // Open for reading and writing, so it never reaches end of file between shells.
  const pipe = new Socket({ fd: openSync(register, constants.O_RDWR | constants.O_NONBLOCK), readable: true, writable: false });
  const groups = new Map<number, string | undefined>();
  let pending = '';
  pipe.on('data', (chunk: Buffer) => {
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!/^\d+$/.test(line)) continue;
      const pid = Number(line);
      const table = processTable();
      const cliPid = cli();
      let current = pid;
      for (let depth = 0; depth < 10 && current > 1 && current !== cliPid; depth++) current = table.get(current)?.ppid ?? 0;
      const group = table.get(pid)?.pgid;
      if (cliPid && current === cliPid && group && group !== cliPid && !groups.has(group)) groups.set(group, startOf(group));
      try {
        const ready = openSync(join(dir, `ready.${pid}`), constants.O_WRONLY | constants.O_NONBLOCK);
        try {
          writeSync(ready, '\n');
        } finally {
          closeSync(ready);
        }
      } catch {
        // No shell is waiting under that PID.
      }
    }
  });
  pipe.on('error', () => undefined);
  return { groups, close: () => pipe.destroy() };
}

/**
 * The processes whose environment sets HOME to home. `ps -E` prints the
 * environment after the arguments, so only what follows a process's own
 * command line counts. The environments are only searched, never kept: a
 * live session's holds its token.
 */
function withHome(home: string, table: Map<number, Proc>): Set<number> {
  const found = new Set<number>();
  for (const line of execFileSync('ps', ['-ww', '-E', '-U', uid(), '-o', 'pid=,command='], CALL).split('\n')) {
    const [, pid = '', shown = ''] = /^\s*(\d+)\s(.*)$/.exec(line) ?? [];
    const command = table.get(Number(pid))?.command;
    if (command === undefined || !shown.startsWith(`${command} `)) continue;
    if (`${shown.slice(command.length)} `.includes(` HOME=${home} `)) found.add(Number(pid));
  }
  return found;
}

/** The processes working in one of the folders. lsof shows this for Apple's own binaries too, whose environment ps doesn't show. */
function workingIn(folders: string[]): Set<number> {
  // lsof exits non-zero when it can't read some process's details, so its output is used either way. It always
  // lists this process, so a listing without it means lsof itself failed.
  const lsof = spawnSync('lsof', ['-w', '-a', '-u', uid(), '-d', 'cwd', '-F', 'pn'], CALL);
  if (lsof.error || !lsof.stdout.includes(`p${process.pid}\n`)) throw new Error(`lsof listed no working folders: ${lsof.error?.message ?? lsof.stderr}`);
  const found = new Set<number>();
  let pid = 0;
  for (const line of lsof.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && folders.some((dir) => inside(line.slice(1), dir))) found.add(pid);
  }
  return found;
}

export interface Session {
  /** The session's HOME. */
  home: string;
  /** The folders it works in: the workspace and its HOME. */
  folders: string[];
  /** The CLI's process group. */
  cliGroup: number;
  /** The shells' process groups, from watchShells. */
  shells: Map<number, string | undefined>;
}

/** What's shown to be the session's so far. Kept across rounds, since a parent killed in one round can't vouch for its child in the next. */
interface Owned {
  pids: Set<number>;
  groups: Set<number>;
}

/** The session's processes, and the candidates not shown to be the session's. Adds what it finds to owned. */
export function sessionProcesses(session: Session, owned: Owned): { owned: Map<number, Proc>; unverified: Map<number, Proc> } {
  const table = processTable();
  const selfGroup = table.get(process.pid)?.pgid;
  const candidates = new Set([...withHome(session.home, table), ...workingIn(session.folders)]);
  candidates.delete(process.pid);
  owned.groups.add(session.cliGroup);
  for (const [group, start] of session.shells) {
    if (owned.groups.has(group)) continue;
    const members = [...table.values()].filter((p) => p.pgid === group);
    const sameLeader = start !== undefined && table.has(group) && startOf(group) === start;
    if (members.length && (sameLeader || members.some((p) => candidates.has(p.pid)))) owned.groups.add(group);
  }
  owned.groups.delete(selfGroup ?? -1);
  const ours = new Map<number, Proc>();
  // Group members and children of the session's processes, until nothing new turns up.
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of table.values()) {
      if (ours.has(p.pid) || p.pid === process.pid || p.pgid === selfGroup) continue;
      if (owned.groups.has(p.pgid) || owned.pids.has(p.pid) || owned.pids.has(p.ppid)) {
        ours.set(p.pid, p);
        owned.pids.add(p.pid);
        owned.groups.add(p.pgid);
        grew = true;
      }
    }
  }
  // A recorded shell's group that can't be shown to be the same group any more is reported, not killed.
  const unconfirmed = [...table.values()].filter((p) => session.shells.has(p.pgid) && !owned.groups.has(p.pgid));
  const unverified = new Map<number, Proc>();
  for (const p of [...[...candidates].flatMap((pid) => table.get(pid) ?? []), ...unconfirmed]) {
    if (!ours.has(p.pid)) unverified.set(p.pid, p);
  }
  return { owned: ours, unverified };
}

/**
 * Kills the session's processes and their process groups, and looks again,
 * since one may have started another just before it was killed. Stops after
 * a few rounds or at the deadline, and reports what's left.
 */
export async function stopLeftovers(session: Session, { deadline = Date.now() + 30_000, rounds = 10 }: { deadline?: number; rounds?: number } = {}): Promise<Leftovers> {
  const owned: Owned = { pids: new Set(), groups: new Set() };
  const stopped = new Map<number, Proc>();
  let found = sessionProcesses(session, owned);
  for (let round = 0; found.owned.size && round < rounds && Date.now() < deadline; round++) {
    for (const target of [...found.owned.keys(), ...[...owned.groups].map((group) => -group)]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    for (const [pid, p] of found.owned) if (!stopped.has(pid)) stopped.set(pid, p);
    await new Promise((resolve) => setTimeout(resolve, 100));
    found = sessionProcesses(session, owned);
  }
  return {
    stopped: describe([...stopped.values()].filter((p) => !found.owned.has(p.pid))),
    remaining: describe(found.owned.values()),
    unverified: describe(found.unverified.values()),
  };
}

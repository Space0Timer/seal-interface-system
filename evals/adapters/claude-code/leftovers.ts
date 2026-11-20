// Finds and stops whatever a session left running. Killing the CLI's process
// group isn't enough: Claude Code runs each Bash command in a process group
// (and session) of its own, so a process a command started in the
// background keeps running after the CLI exits, still inside the session's
// sandbox, where it can go on changing the workspace.
//
// Nothing a process says about itself proves it's the session's: anyone can
// start a process with the session's HOME, in its workspace. So ownership
// comes from the process tree, checked while the session runs:
// - Every shell Claude Code starts is a small zsh wrapper (watchShells).
//   It runs the real zsh as its child, and checks in with the runner before
//   and after: it sends its PID and the PID of a waiter it started, and
//   waits. The runner checks in the process table that the shell descends
//   from the CLI and that the waiter is its child. Then it records every
//   process in the shell's process group as a witness, by PID and start
//   time, and kills the waiter, which lets the shell go on. The runner
//   never writes to a path the session could replace.
// - A process is the session's while it's a recorded witness: same PID,
//   same start time. Its process group is then the session's too: a group's
//   number can't be handed out again while the group has a member. So is
//   any child of the session's processes.
// When the CLI exits, the runner kills those processes and groups. A group
// with no witness left alive can't be shown to be the same group, so its
// members aren't killed. Neither are candidates (processes whose environment
// sets the session's HOME, or that work in the workspace or that HOME) that
// aren't shown to be the session's: they're reported and left running. They
// could be the session's, or a diagnostic someone started. macOS only: ps
// and lsof show the candidates.
import { execFileSync, spawnSync } from 'node:child_process';
import { constants, fstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { dirname, join } from 'node:path';

export interface Leftovers {
  /** What was stopped, as `<pid> <command line>`. */
  stopped: string[];
  /** The session's, but still running after every attempt, in the same form. */
  remaining: string[];
  /** Not shown to be the session's, so left running, in the same form. */
  unverified: string[];
}

interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  /** When it started, to the second. With the PID, it tells one process from a later one that reused the PID. */
  start: string;
  command: string;
}

/** Processes shown to be the session's, by PID, with when each started. */
export type Witnesses = Map<number, string>;

const CALL = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10_000 } as const;
const uid = () => String(process.getuid?.() ?? '');
const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);
const describe = (procs: Iterable<Proc>) => [...procs].map((p) => `${p.pid} ${p.command.slice(0, 200)}`);
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const ps = (args: string[]) => execFileSync('ps', ['-ww', '-U', uid(), ...args], { ...CALL, env: { ...process.env, LC_ALL: 'C' } });

/** This user's processes, without their environments. */
export function processTable(): Map<number, Proc> {
  const commands = new Map<number, string>();
  for (const line of ps(['-o', 'pid=,command=']).split('\n')) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (match) commands.set(Number(match[1]), match[2] ?? '');
  }
  const table = new Map<number, Proc>();
  for (const line of ps(['-o', 'pid=,ppid=,pgid=,lstart=']).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*\S)\s*$/.exec(line);
    const pid = Number(match?.[1]);
    const command = commands.get(pid);
    if (match && command !== undefined) table.set(pid, { pid, ppid: Number(match[2]), pgid: Number(match[3]), start: match[4] ?? '', command });
  }
  return table;
}

/** The shell wrapper's script: it checks in, runs zsh, checks in again, and exits with zsh's status. */
function wrapper(register: string): string {
  return `#!/bin/zsh -f
# Checks in before and after running zsh.
checkin() {
  sleep 10 < /dev/null > /dev/null 2>&1 &
  local waiter=$!
  print -r -- "$$ $waiter" >> ${quote(register)} 2>/dev/null && wait $waiter 2>/dev/null
  kill $waiter 2>/dev/null
}
checkin
/bin/zsh "$@"
code=$?
checkin
exit $code
`;
}

export interface Shells {
  /** The session's processes seen so far: shells and every member of their process groups when they checked in. */
  witnesses: Witnesses;
  /** The process groups of the shells that checked in. */
  groups: Set<number>;
  close(): void;
}

/**
 * Writes the shell wrapper at shell, in a folder that must not exist yet,
 * and listens for check-ins. They're only taken from a shell the process
 * table shows descends from the CLI, whose PID cli returns once it has
 * started, so a check-in someone else wrote records nothing and lets
 * nothing go on. If a check-in can't be handled, for example because ps
 * failed, fail is called once and later check-ins are ignored: what that
 * shell leaves could no longer be told apart.
 */
export function watchShells(shell: string, cli: () => number | undefined, fail: (error: Error) => void): Shells {
  const dir = dirname(shell);
  mkdirSync(dirname(dir), { recursive: true });
  mkdirSync(dir);
  writeFileSync(shell, wrapper(join(dir, 'register')), { flag: 'wx', mode: 0o755 });
  const register = join(dir, 'register');
  execFileSync('mkfifo', [register], CALL);
  // Open for reading and writing, so it never reaches end of file between shells. It's opened once, before the
  // session starts; nothing in the folder is opened again.
  const fd = openSync(register, constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  if (!fstatSync(fd).isFIFO()) throw new Error(`${register} is not the pipe the runner made`);
  const pipe = new Socket({ fd, readable: true, writable: false });
  const witnesses: Witnesses = new Map();
  const groups = new Set<number>();
  let pending = '';
  let failed = false;
  const checkIn = (line: string) => {
    const match = /^(\d+) (\d+)$/.exec(line);
    const cliPid = cli();
    if (!match || !cliPid) return;
    const table = processTable();
    const shellProc = table.get(Number(match[1]));
    const waiter = table.get(Number(match[2]));
    let current = shellProc?.pid ?? 0;
    for (let depth = 0; depth < 10 && current > 1 && current !== cliPid; depth++) current = table.get(current)?.ppid ?? 0;
    if (!shellProc || !waiter || current !== cliPid || waiter.ppid !== shellProc.pid) return;
    groups.add(shellProc.pgid);
    for (const p of table.values()) if (p.pgid === shellProc.pgid) witnesses.set(p.pid, p.start);
    try {
      process.kill(waiter.pid, 'SIGTERM');
    } catch {
      // It's gone already, and the shell has gone on.
    }
  };
  pipe.on('data', (chunk: Buffer) => {
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (failed) return;
      try {
        checkIn(line);
      } catch (error) {
        failed = true;
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  pipe.on('error', () => undefined);
  return { witnesses, groups, close: () => pipe.destroy() };
}

/**
 * The processes whose environment sets HOME to home. `ps -E` prints the
 * environment after the arguments, so only what follows a process's own
 * command line counts. The environments are only searched, never kept: a
 * live session's holds its token.
 */
function withHome(home: string, table: Map<number, Proc>): Set<number> {
  const found = new Set<number>();
  for (const line of ps(['-E', '-o', 'pid=,command=']).split('\n')) {
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
  /** From watchShells. Witnesses are added as more are found. */
  shells: Pick<Shells, 'witnesses' | 'groups'>;
}

/**
 * The session's processes and process groups now, and what may be the
 * session's but isn't shown to be. Records what it finds as witnesses.
 */
export function sessionProcesses(session: Session): { owned: Map<number, Proc>; groups: Set<number>; unverified: Map<number, Proc> } {
  const { witnesses } = session.shells;
  const table = processTable();
  const selfGroup = table.get(process.pid)?.pgid;
  const owned = new Map<number, Proc>();
  const groups = new Set<number>();
  const own = (p: Proc) => {
    if (owned.has(p.pid) || p.pid === process.pid || p.pgid === selfGroup) return false;
    owned.set(p.pid, p);
    groups.add(p.pgid);
    return true;
  };
  for (const p of table.values()) if (witnesses.get(p.pid) === p.start) own(p);
  // Members of the groups those are in, and children of the session's processes, until nothing new turns up.
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of table.values()) if ((groups.has(p.pgid) || owned.has(p.ppid)) && own(p)) grew = true;
  }
  for (const p of owned.values()) witnesses.set(p.pid, p.start);
  const candidates = [...withHome(session.home, table), ...workingIn(session.folders)];
  const unverified = new Map<number, Proc>();
  for (const p of [...candidates.flatMap((pid) => table.get(pid) ?? []), ...[...table.values()].filter((q) => session.shells.groups.has(q.pgid))]) {
    if (!owned.has(p.pid) && p.pid !== process.pid) unverified.set(p.pid, p);
  }
  return { owned, groups, unverified };
}

/**
 * Kills the session's processes and process groups, and looks again, since
 * one may have started another just before it was killed. Each round kills
 * only what that round's process table showed. Stops after a few rounds or
 * at the deadline, and reports what's left.
 */
export async function stopLeftovers(session: Session, { deadline = Date.now() + 30_000, rounds = 10 }: { deadline?: number; rounds?: number } = {}): Promise<Leftovers> {
  const stopped = new Map<number, Proc>();
  let found = sessionProcesses(session);
  for (let round = 0; found.owned.size && round < rounds && Date.now() < deadline; round++) {
    for (const target of [...found.owned.keys(), ...[...found.groups].map((group) => -group)]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    for (const [pid, p] of found.owned) if (!stopped.has(pid)) stopped.set(pid, p);
    await new Promise((resolve) => setTimeout(resolve, 100));
    found = sessionProcesses(session);
  }
  return {
    stopped: describe([...stopped.values()].filter((p) => !found.owned.has(p.pid))),
    remaining: describe(found.owned.values()),
    unverified: describe(found.unverified.values()),
  };
}

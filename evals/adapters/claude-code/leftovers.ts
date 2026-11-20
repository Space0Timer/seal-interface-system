// Finds and stops whatever a session left running. Killing the CLI's process
// group isn't enough: Claude Code runs each Bash command in a process group
// of its own, so a process a command started in the background keeps
// running after the CLI exits, still inside the session's sandbox, where it
// can go on changing the workspace.
//
// Only a process shown to be the session's is killed:
// - Its environment, not its arguments, sets HOME to the session's own. That
//   folder belongs to this one session, and every process the session starts
//   inherits it.
// - Or its parent or its process group is the session's, as the CLI's own
//   group is. A process group never spans sessions, and the CLI starts in a
//   session of its own, so no process started elsewhere can join one of the
//   session's groups.
// `ps -E` shows no environment for Apple's own binaries, such as sh and
// sleep, so one of those is the session's only through its parent or group.
// A process working in the workspace or the session's HOME that can't be
// shown to be the session's is reported and left running: it could be the
// session's, or a shell someone opened there. macOS only.
import { execFileSync, spawnSync } from 'node:child_process';

export interface Leftovers {
  /** What was stopped, as `<pid> <command line>`. */
  stopped: string[];
  /** The session's, but still running after every attempt, in the same form. */
  remaining: string[];
  /** Working in the workspace or the session's HOME, but not shown to be the session's, so left running. */
  unverified: string[];
}

interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

/** What has been shown to be the session's so far. Kept across rounds, since a parent killed in one round can't vouch for its child in the next. */
interface Owned {
  pids: Set<number>;
  groups: Set<number>;
}

const CALL = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10_000 } as const;
const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);
const describe = (procs: Iterable<Proc>) => [...procs].map((p) => `${p.pid} ${p.command.slice(0, 200)}`);

/** This user's processes, without their environments. */
function processTable(uid: string): Map<number, Proc> {
  const table = new Map<number, Proc>();
  for (const line of execFileSync('ps', ['-ww', '-U', uid, '-o', 'pid=,ppid=,pgid=,command='], CALL).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (match) table.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] ?? '' });
  }
  return table;
}

/**
 * The processes whose environment sets HOME to home. `ps -E` prints the
 * environment after the arguments, so only what follows a process's own
 * command line counts. The environments are only searched, never kept: a
 * live session's holds its token.
 */
function withHome(uid: string, home: string, table: Map<number, Proc>): Set<number> {
  const found = new Set<number>();
  for (const line of execFileSync('ps', ['-ww', '-E', '-U', uid, '-o', 'pid=,command='], CALL).split('\n')) {
    const [, pid = '', shown = ''] = /^\s*(\d+)\s(.*)$/.exec(line) ?? [];
    const command = table.get(Number(pid))?.command;
    if (command === undefined || !shown.startsWith(`${command} `)) continue;
    if (`${shown.slice(command.length)} `.includes(` HOME=${home} `)) found.add(Number(pid));
  }
  return found;
}

/** The processes working in one of the folders. lsof shows this for Apple's own binaries too. */
function workingIn(uid: string, folders: string[]): Set<number> {
  // lsof exits non-zero when it can't read some process's details, so its output is used either way. It always
  // lists this process, so a listing without it means lsof itself failed.
  const lsof = spawnSync('lsof', ['-w', '-a', '-u', uid, '-d', 'cwd', '-F', 'pn'], CALL);
  if (lsof.error || !lsof.stdout.includes(`p${process.pid}\n`)) throw new Error(`lsof listed no working folders: ${lsof.error?.message ?? lsof.stderr}`);
  const found = new Set<number>();
  let pid = 0;
  for (const line of lsof.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && folders.some((dir) => inside(line.slice(1), dir))) found.add(pid);
  }
  return found;
}

/** The session's processes, and the others working in its folders. Adds what it finds to owned. */
export function sessionProcesses(home: string, folders: string[], owned: Owned): { owned: Map<number, Proc>; unverified: Map<number, Proc> } {
  const uid = String(process.getuid?.() ?? '');
  const table = processTable(uid);
  const self = table.get(process.pid);
  const ours = new Map<number, Proc>();
  const claim = (p: Proc) => {
    // Never this process or its own group.
    if (p.pid === process.pid || p.pgid === self?.pgid) return false;
    ours.set(p.pid, p);
    owned.pids.add(p.pid);
    owned.groups.add(p.pgid);
    return true;
  };
  for (const pid of withHome(uid, home, table)) {
    const p = table.get(pid);
    if (p) claim(p);
  }
  for (const p of table.values()) if (owned.pids.has(p.pid)) claim(p);
  // Children and group members of the session's processes, until nothing new turns up.
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of table.values()) {
      if (!ours.has(p.pid) && (owned.pids.has(p.ppid) || owned.groups.has(p.pgid)) && claim(p)) grew = true;
    }
  }
  const unverified = new Map<number, Proc>();
  for (const pid of workingIn(uid, folders)) {
    const p = table.get(pid);
    if (p && !ours.has(pid) && pid !== process.pid) unverified.set(pid, p);
  }
  return { owned: ours, unverified };
}

/**
 * Kills the session's processes and their process groups, and looks again,
 * since one may have started another just before it was killed. Stops after
 * a few rounds or at the deadline, and reports what's left. groups are
 * process groups already known to be the session's, such as the CLI's own.
 */
export async function stopLeftovers(
  home: string,
  folders: string[],
  { groups = [], deadline = Date.now() + 30_000, rounds = 10 }: { groups?: number[]; deadline?: number; rounds?: number } = {},
): Promise<Leftovers> {
  const owned: Owned = { pids: new Set(), groups: new Set(groups) };
  const stopped = new Map<number, Proc>();
  let found = sessionProcesses(home, folders, owned);
  for (let round = 0; found.owned.size && round < rounds && Date.now() < deadline; round++) {
    const targets = [...found.owned.keys(), ...[...owned.groups].map((group) => -group)];
    for (const target of targets) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    for (const [pid, p] of found.owned) if (!stopped.has(pid)) stopped.set(pid, p);
    await new Promise((resolve) => setTimeout(resolve, 100));
    found = sessionProcesses(home, folders, owned);
  }
  return {
    stopped: describe([...stopped.values()].filter((p) => !found.owned.has(p.pid))),
    remaining: describe(found.owned.values()),
    unverified: describe(found.unverified.values()),
  };
}

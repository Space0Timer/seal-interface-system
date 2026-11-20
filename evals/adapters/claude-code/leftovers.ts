// Finds and stops whatever a session left running. Killing the CLI's process
// group isn't enough: Claude Code runs each Bash command in a process group
// of its own, so a process a command started in the background keeps
// running after the CLI exits, still inside the session's sandbox, where it
// can go on changing the workspace.
//
// A process counts as the session's if its environment sets HOME to the
// session's own, a fresh folder that belongs to this one session, or if its
// working folder is inside the workspace or that HOME. Every process the
// session starts inherits the HOME. The working folder is needed too:
// `ps -E` shows no environment for Apple's own binaries, such as sh and
// sleep, and lsof shows their working folders. A process that drops that
// HOME and leaves those folders isn't found. macOS only.
import { execFileSync, spawnSync } from 'node:child_process';

export interface Leftovers {
  /** What was stopped, as `<pid> <command line>`. */
  stopped: string[];
  /** What was still running after every attempt, in the same form. */
  remaining: string[];
}

const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

/**
 * This user's processes that belong to the session, by PID, with their
 * command lines. Environments are only searched, never kept: a live
 * session's environment holds its token.
 */
export function sessionProcesses(home: string, folders: string[]): Map<number, string> {
  const uid = String(process.getuid?.() ?? '');
  const found = new Set<number>();
  const marker = ` HOME=${home}`;
  const withEnv = execFileSync('ps', ['-ww', '-E', '-U', uid, '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  for (const line of withEnv.split('\n')) {
    if (line.includes(`${marker} `) || line.endsWith(marker)) found.add(Number.parseInt(line, 10));
  }
  // lsof exits non-zero when it can't read some process's details, so its output is used either way. It always
  // lists this process, so an empty listing means lsof itself failed.
  const cwd = spawnSync('lsof', ['-w', '-a', '-u', uid, '-d', 'cwd', '-F', 'pn'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (cwd.error || !cwd.stdout.includes(`p${process.pid}\n`)) throw new Error(`lsof listed no working folders: ${cwd.error?.message ?? cwd.stderr}`);
  let pid = 0;
  for (const line of cwd.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && folders.some((dir) => inside(line.slice(1), dir))) found.add(pid);
  }
  found.delete(process.pid);
  const pids = [...found].filter((p) => p > 0);
  if (!pids.length) return new Map();
  // The command lines, without the environment. A process that has exited since is left out, and ps then exits non-zero.
  const listed = spawnSync('ps', ['-ww', '-o', 'pid=,command=', '-p', pids.join(',')], { encoding: 'utf8' }).stdout ?? '';
  const commands = new Map(
    listed
      .split('\n')
      .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
      .filter((match) => match !== null)
      .map(([, p = '', command = '']) => [Number(p), command.slice(0, 200)] as const),
  );
  return new Map(pids.map((p) => [p, commands.get(p) ?? '']));
}

/**
 * Kills every process that belongs to the session, and looks again, since
 * one may have started another just before it was killed. Gives up after a
 * few rounds and reports what's left.
 */
export async function stopLeftovers(home: string, folders: string[], rounds = 10): Promise<Leftovers> {
  const stopped = new Map<number, string>();
  const describe = (entries: Iterable<[number, string]>) => [...entries].map(([pid, command]) => `${pid} ${command}`);
  for (let round = 0; round < rounds; round++) {
    const found = sessionProcesses(home, folders);
    if (!found.size) return { stopped: describe(stopped), remaining: [] };
    for (const [pid, command] of found) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      if (!stopped.has(pid)) stopped.set(pid, command);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const remaining = sessionProcesses(home, folders);
  return { stopped: describe([...stopped].filter(([pid]) => !remaining.has(pid))), remaining: describe(remaining) };
}

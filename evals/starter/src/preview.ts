// Serves a built workspace with its own `vite preview` (and its copy of the
// mock API), bound to this process: the OS assigns a free port, the server
// starts there with --strictPort, and the URL is the one this process
// announces. If the process exits, callers can tell, so a server from
// another workspace or worktree can never stand in for it.
//
// Not copied into workspaces.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

/** Stops a detached child and its process group. Safe if it already exited. */
export function stopProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM'); // the whole process group (POSIX)
  } catch {
    child.kill('SIGTERM'); // no group, or not POSIX
  }
}

export interface Preview {
  /** The URL this process announced, without a trailing slash. */
  url: string;
  /** True once the server process has exited. */
  gone(): boolean;
  /** Everything the server printed so far. */
  output(): string;
  stop(): void;
}

/** How to launch the server: its environment, and optionally a wrapper such as an OS sandbox. */
export interface Launch {
  env: NodeJS.ProcessEnv;
  wrap?(command: string, args: string[]): [string, string[]];
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Starts `vite preview` in a built workspace and resolves once this process
 * has announced its URL and answers on it. Rejects (and stops the server)
 * if the process exits first or doesn't serve in time. Without `launch`, the
 * server inherits this process's environment.
 */
export async function startPreview(workspace: string, { timeoutMs = 30_000, launch }: { timeoutMs?: number; launch?: Launch } = {}): Promise<Preview> {
  const port = await freePort();
  const viteArgs = ['exec', 'vite', 'preview', '--port', String(port), '--strictPort'];
  const [command, args] = launch?.wrap?.('pnpm', viteArgs) ?? ['pnpm', viteArgs];
  const child = spawn(command, args, {
    cwd: workspace,
    env: launch?.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  const preview: Preview = { url: '', gone, output: () => output, stop: () => stopProcess(child) };

  // Wait for this process to announce its own URL, on the port it was given, then answer on it.
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      if (gone()) throw new Error(`vite preview exited (code ${child.exitCode}) before serving:\n${output}`);
      const announced = new RegExp(`(http://(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):${port})/`).exec(output.replace(ANSI, ''));
      if (announced?.[1]) {
        const url = announced[1];
        const ok = await fetch(url).then((r) => r.ok, () => false);
        if (ok && !gone()) return { ...preview, url };
      }
      if (Date.now() > deadline) throw new Error(`vite preview didn't serve on port ${port} in time:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } catch (error) {
    stopProcess(child);
    throw error;
  }
}

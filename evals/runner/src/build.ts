import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

const SANDBOX = '/usr/bin/sandbox-exec';
const SYSTEM_BINS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

// Read the bundle with the same filesystem restrictions as the build. Its
// paths remain data when the runner receives them, even if a build emits links.
const COLLECT_BUNDLE = `
  import { lstatSync, readFileSync, readdirSync } from 'node:fs';
  import { join } from 'node:path';
  function* files(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const key = prefix + '/' + entry.name;
      if (entry.isDirectory()) yield* files(path, key);
      else if (entry.isFile()) yield [key, readFileSync(path).toString('base64')];
      else throw new Error('unsupported build output: ' + key);
    }
  }
  if (!lstatSync('dist').isDirectory()) throw new Error('dist must be a real directory');
  for (const file of files('dist')) console.log(JSON.stringify(file));
`;

export class BuildOutputError extends Error {}

export function buildSandbox(workspace: string, state: string) {
  if (process.platform !== 'darwin' || !existsSync(SANDBOX)) {
    throw new Error('isolated builds require macOS sandbox-exec');
  }
  const pnpm = (process.env['PATH'] ?? '')
    .split(delimiter)
    .filter(isAbsolute)
    .map((dir) => join(dir, 'pnpm'))
    .find((path) => {
      try {
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  if (!pnpm) throw new Error('pnpm was not found on PATH');

  mkdirSync(state, { recursive: true });
  const stateDir = realpathSync(state);
  const app = realpathSync(workspace);
  const home = join(stateDir, 'home');
  const tmp = join(stateDir, 'tmp');
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const corepackHome = process.env['COREPACK_HOME'] ?? join(homedir(), '.cache', 'node', 'corepack');
  const corepack = existsSync(corepackHome) ? realpathSync(corepackHome) : undefined;
  const node = realpathSync(process.execPath);
  const executables = [...SYSTEM_BINS, dirname(dirname(node)), dirname(pnpm)];
  const read = [
    ...executables, dirname(realpathSync(pnpm)),
    '/System', '/usr/lib', '/usr/share', '/dev', '/private/etc', '/private/var/db/timezone',
    app, stateDir, ...(corepack ? [corepack] : []),
  ];
  const subpaths = (paths: string[]) => [...new Set(paths)].map((path) => `(subpath ${JSON.stringify(path)})`).join(' ');
  const profile = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork sysctl-read file-read-metadata)',
    `(allow process-exec ${subpaths([...executables, dirname(realpathSync(pnpm)), app, ...(corepack ? [corepack] : [])])})`,
    `(allow file-read* (literal "/") ${subpaths(read)})`,
    `(allow file-write* (literal "/dev/null") ${subpaths([app, stateDir])})`,
  ].join('\n');
  const env = {
    HOME: home,
    TMPDIR: tmp,
    PATH: [...new Set([dirname(node), dirname(pnpm), ...SYSTEM_BINS])].join(delimiter),
    LANG: 'en_US.UTF-8',
    CI: '1',
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_ENV_FILE: '0',
    ...(corepack ? { COREPACK_HOME: corepack } : {}),
  };
  return {
    command: SANDBOX,
    args: ['-p', profile, pnpm, 'build'],
    probe: ['-p', profile, pnpm, '--version'],
    env,
    bundle: ['-p', profile, node, '--input-type=module', '--eval', COLLECT_BUNDLE],
  };
}

/** Runs only the runner's collector inside the sandbox and returns a fixed snapshot. */
export async function collectBundle(workspace: string, sandbox: ReturnType<typeof buildSandbox>): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const child = spawn(sandbox.command, sandbox.bundle, {
      cwd: workspace, env: sandbox.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let error = '';
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (error += chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        const cause = code === null ? Error : BuildOutputError;
        reject(new cause(`could not read build output: ${error.trim()}`));
        return;
      }
      try {
        const entries = Buffer.concat(chunks).toString('utf8').trim().split('\n').filter(Boolean);
        const bundle = new Map(entries.map((line) => {
          const [path, bytes] = JSON.parse(line) as [string, string];
          return [path, Buffer.from(bytes, 'base64')];
        }));
        if (!bundle.has('/index.html')) {
          reject(new BuildOutputError('build output is missing dist/index.html'));
          return;
        }
        resolve(bundle);
      } catch (cause) {
        reject(new Error('could not decode build output', { cause }));
      }
    });
  });
}

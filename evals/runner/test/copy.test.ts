// The confined copy of the generator's output: what it takes, what it
// records, and that it reads nothing outside the workspace.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { toolchain } from '../../starter/src/toolchain.ts';
import { confineCopy, sandboxAvailable } from '../src/confine.ts';
import { confinedCopy, type CopyOptions } from '../src/copy.ts';
import { diff, snapshot, walk } from '../src/files.ts';

const root = mkdtempSync(join(realpathSync(tmpdir()), 'copy-'));
after(() => rmSync(root, { recursive: true, force: true }));
const { nodeRoot } = toolchain();
const skip = { skipAnywhere: ['node_modules', '.git'], skipPaths: ['dist', '.vite'] };
/** Copies from into a new folder the way the runner does: confined to those two folders where the OS allows it. */
const copy = (from: string, to: string, options: CopyOptions, confinement?: { sandbox: boolean }) => {
  mkdirSync(to);
  return confinedCopy(from, to, confineCopy({ from, to, nodeRoot, forbidden: [] }, confinement), options);
};

test('the output is all of src/ and every other file added or changed, with links recorded and the snapshot taken on the way', () => {
  const workspace = join(root, 'app');
  for (const dir of ['src', 'tools', 'node_modules/pkg', 'dist']) mkdirSync(join(workspace, dir), { recursive: true });
  writeFileSync(join(workspace, 'src', 'App.tsx'), 'export function App() {}\n');
  writeFileSync(join(workspace, 'index.html'), '<!doctype html>');
  writeFileSync(join(workspace, 'tools', 'prepare.ts'), '// unchanged');
  writeFileSync(join(workspace, 'README.md'), 'removed later');
  writeFileSync(join(workspace, 'node_modules', 'pkg', 'index.js'), '');
  const before = snapshot(workspace, skip);

  writeFileSync(join(workspace, 'index.html'), '<!doctype html><title>changed</title>');
  writeFileSync(join(workspace, 'main.ts'), 'console.log(1)');
  rmSync(join(workspace, 'README.md'));
  writeFileSync(join(workspace, 'dist', 'index.html'), 'build output');
  writeFileSync(join(workspace, 'node_modules', 'pkg', 'index.js'), 'changed dependency');
  writeFileSync(join(root, 'host-secret.txt'), 'a host file');
  symlinkSync(join(root, 'host-secret.txt'), join(workspace, 'src', 'secret.txt'));

  const output = join(root, 'output');
  const copied = copy(workspace, output, { ...skip, before, keep: ['src'] });
  assert.equal(copied.found, true);
  assert.deepEqual(copied.copied, ['index.html', 'main.ts', 'src/App.tsx']);
  assert.deepEqual(copied.links, [{ path: 'src/secret.txt', target: join(root, 'host-secret.txt') }]);
  assert.deepEqual(copied.refused, []);
  assert.deepEqual(walk(output), ['index.html', 'main.ts', 'src/App.tsx']);
  assert.equal(readFileSync(join(output, 'index.html'), 'utf8'), '<!doctype html><title>changed</title>');
  // The copy's hashes are the snapshot the runner would have taken itself, so the changes come out the same.
  assert.deepEqual(copied.hashes, snapshot(workspace, skip));
  assert.deepEqual(diff(before, copied.hashes), { added: ['main.ts', 'src/secret.txt'], changed: ['index.html'], deleted: ['README.md'] });
});

test('a workspace that is no longer a folder has nothing to copy', () => {
  const linked = join(root, 'linked-app');
  symlinkSync(join(root, 'app'), linked);
  const copied = copy(linked, join(root, 'output-linked'), skip);
  assert.equal(copied.found, false);
  assert.deepEqual([copied.copied, copied.links, readdirSync(join(root, 'output-linked'))], [[], [], []]);
});

test('the output copy reads nothing outside the workspace, even when a folder in its path turns into a link to the host', { skip: sandboxAvailable() ? false : 'needs macOS sandbox-exec' }, () => {
  // What a process the session left running could do between two steps of the copy: swap a folder for a link to a
  // host folder. Here the workspace is reached through such a link from the start; the copy is confined to the path
  // it was given.
  const host = join(root, 'host-folder');
  mkdirSync(join(host, 'app', 'src'), { recursive: true });
  writeFileSync(join(host, 'app', 'src', 'App.tsx'), 'host secret');
  const swapped = join(root, 'swapped');
  symlinkSync(host, swapped);
  const options = { ...skip, before: new Map(), keep: ['src'] };

  const confined = copy(join(swapped, 'app'), join(root, 'output-swapped'), options);
  assert.equal(confined.found, true);
  assert.deepEqual(confined.copied, []);
  assert.deepEqual(confined.refused, [{ path: '.', reason: 'EPERM' }]);
  assert.deepEqual(confined.hashes, new Map());
  assert.deepEqual(readdirSync(join(root, 'output-swapped')), []);

  // The sandbox is what stops it: unconfined, the same copy takes the host file.
  const unconfined = copy(join(swapped, 'app'), join(root, 'output-unconfined'), options, { sandbox: false });
  assert.deepEqual(unconfined.copied, ['src/App.tsx']);
  assert.equal(readFileSync(join(root, 'output-unconfined', 'src', 'App.tsx'), 'utf8'), 'host secret');
});

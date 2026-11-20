import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';
import { REPLACEMENT_FILE, UPLOAD_BATCH } from '../../fixtures/src/data.ts';
import { EVAL_WORDS, OWNER_COPY } from '../src/leaks.ts';
import { materialize, REPO, TEMPLATE, TEMPLATE_FILES } from '../src/materialize.ts';

// Every temp folder this file creates is removed when the run ends.
const temps: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const fresh = () => join(temp('starter-'), 'workspace');

const TOP_LEVEL = [
  'README.md',
  'asset-library.md',
  'index.html',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'replacement-files',
  'src',
  'tools',
  'tsconfig.json',
  'upload-files',
  'vite.config.ts',
];

function textFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ['upload-files', 'replacement-files', 'node_modules'].includes(entry.name) ? [] : textFiles(path);
    return /\.(md|ts|tsx|json|html|yaml)$/.test(entry.name) ? [path] : [];
  });
}

test('a plain workspace has the template, tools, brief and upload files, and nothing else', () => {
  const ws = materialize({ out: fresh(), install: false });
  assert.deepEqual(readdirSync(ws).sort(), TOP_LEVEL);
  for (const file of ['src/main.tsx', 'src/App.tsx', 'tools/prepare.ts', 'tools/tokens/resolve.ts', 'tools/tokens/css.ts', 'tools/mock-api/vite-plugin.ts', 'tools/mock-api/mock-api.ts']) {
    assert.ok(existsSync(join(ws, file)), file);
  }
  assert.deepEqual(readdirSync(join(ws, 'upload-files')).sort(), UPLOAD_BATCH.map((f) => f.filename).sort());
  for (const file of UPLOAD_BATCH) assert.equal(statSync(join(ws, 'upload-files', file.filename)).size, file.sizeBytes);
  assert.deepEqual(readdirSync(join(ws, 'replacement-files')), [REPLACEMENT_FILE.filename]);
  assert.deepEqual(readdirSync(join(ws, 'tools', 'mock-api')).sort(), ['data.ts', 'mock-api.ts', 'thumbnails.ts', 'vite-plugin.ts']);
  assert.ok(!existsSync(join(ws, 'src', 'design-tokens.css')));
});

test('nothing in a plain workspace carries the owner\'s design guidance, copy, or the eval around it', () => {
  const ws = materialize({ out: fresh(), install: false });
  for (const file of textFiles(ws)) {
    const text = readFileSync(file, 'utf8');
    for (const phrase of OWNER_COPY) assert.ok(!text.includes(phrase), `${relative(ws, file)} contains "${phrase}"`);
    const leak = EVAL_WORDS.exec(text);
    assert.equal(leak, null, `${relative(ws, file)} mentions "${leak?.[0]}"`);
  }
});

test('with the design-system skill installed, prepare generates design-tokens.css; without it, nothing', () => {
  const plain = materialize({ out: fresh(), install: false });
  execFileSync(process.execPath, ['tools/prepare.ts'], { cwd: plain, stdio: 'pipe' });
  assert.ok(!existsSync(join(plain, 'src', 'design-tokens.css')));

  const skilled = materialize({ out: fresh(), install: false, guidance: { from: 'core/design-system', to: '.claude/skills/design-system' } });
  assert.ok(existsSync(join(skilled, '.claude', 'skills', 'design-system', 'SKILL.md')));
  execFileSync(process.execPath, ['tools/prepare.ts'], { cwd: skilled, stdio: 'pipe' });
  const css = readFileSync(join(skilled, 'src', 'design-tokens.css'), 'utf8');
  assert.match(css, /--color-text-secondary: #/);
  assert.match(css, /--type-list-default-font-size: 13px;/);
  assert.doesNotMatch(css, /--palette-/);
});

function linksIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (lstatSync(path).isSymbolicLink()) return [path];
    return entry.isDirectory() && entry.name !== 'node_modules' ? linksIn(path) : [];
  });
}

test('guidance given through a link is copied as real files, and its tokens still generate', () => {
  const links = temp('starter-links-');
  symlinkSync(join(REPO, 'core', 'design-system'), join(links, 'design-system'));
  const ws = materialize({ out: fresh(), install: false, guidance: { from: join(links, 'design-system'), to: '.claude/skills/design-system' } });
  assert.deepEqual(linksIn(ws), []);
  assert.ok(lstatSync(join(ws, '.claude', 'skills', 'design-system')).isDirectory());
  execFileSync(process.execPath, ['tools/prepare.ts'], { cwd: ws, stdio: 'pipe' });
  assert.match(readFileSync(join(ws, 'src', 'design-tokens.css'), 'utf8'), /--color-text-secondary: #/);
});

test('guidance with a link that escapes its own tree is rejected before anything is created', () => {
  const guidance = temp('starter-guidance-');
  writeFileSync(join(guidance, 'SKILL.md'), '---\nname: x\n---\n');
  symlinkSync(join(REPO, 'AGENTS.md'), join(guidance, 'notes.md'));
  const out = fresh();
  assert.throws(() => materialize({ out, install: false, guidance: { from: guidance, to: '.claude/skills/x' } }), /points outside the guidance/);
  assert.ok(!existsSync(out));
});

test('the brief must be a single brief name; paths are rejected before anything is created', () => {
  for (const brief of ['../../AGENTS', 'asset-library/../x', 'Asset Library', '']) {
    const out = fresh();
    assert.throws(() => materialize({ out, brief, install: false }), /single brief name/, brief);
    assert.ok(!existsSync(out), brief);
  }
  assert.throws(() => materialize({ out: fresh(), brief: 'no-such-brief', install: false }), /no brief named/);
});

test('prepare never deletes a design-tokens.css it did not generate, but clears its own stale output', () => {
  const plain = materialize({ out: fresh(), install: false });
  const mine = join(plain, 'src', 'design-tokens.css');
  writeFileSync(mine, ':root { --brand: red; }\n');
  execFileSync(process.execPath, ['tools/prepare.ts'], { cwd: plain, stdio: 'pipe' });
  assert.equal(readFileSync(mine, 'utf8'), ':root { --brand: red; }\n');

  const skilled = materialize({ out: fresh(), install: false, guidance: { from: 'core/design-system', to: 'design-system' } });
  execFileSync(process.execPath, ['tools/prepare.ts'], { cwd: skilled, stdio: 'pipe' });
  assert.ok(existsSync(join(skilled, 'src', 'design-tokens.css')));
  rmSync(join(skilled, 'design-system'), { recursive: true });
  execFileSync(process.execPath, ['tools/prepare.ts'], { cwd: skilled, stdio: 'pipe' });
  assert.ok(!existsSync(join(skilled, 'src', 'design-tokens.css')), 'stale generated output is removed');
});

test('guidance must land in a folder inside the workspace, never its root; an existing workspace is never overwritten', () => {
  for (const to of ['../outside', '.', './', '', 'skills/../..', 'skills/../../x']) {
    const out = fresh();
    assert.throws(() => materialize({ out, install: false, guidance: { from: 'core/design-system', to } }), /folder inside the workspace/, to);
    assert.ok(!existsSync(out), to);
  }
  const ws = materialize({ out: fresh(), install: false });
  assert.throws(() => materialize({ out: ws, install: false }), /isn't empty/);
});

test('the declared template files are exactly the template\'s tracked files', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: TEMPLATE, encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(tracked, [...TEMPLATE_FILES].sort());
});

test('only declared template files are copied; local extras (.env.local, dist, .vite, .DS_Store) stay out', () => {
  // A temporary copy of the template, so the real one is never touched.
  const template = temp('starter-template-');
  for (const file of TEMPLATE_FILES) {
    mkdirSync(join(template, file, '..'), { recursive: true });
    copyFileSync(join(TEMPLATE, file), join(template, file));
  }
  const extras = ['.env.local', 'dist/index.html', '.vite/deps.json', '.DS_Store', 'src/.DS_Store', 'src/notes.local.ts'];
  for (const file of extras) {
    mkdirSync(join(template, file, '..'), { recursive: true });
    writeFileSync(join(template, file), 'local only');
  }
  const ws = materialize({ out: fresh(), install: false, templateDir: template });
  for (const file of extras) assert.ok(!existsSync(join(ws, file)), file);
  for (const file of TEMPLATE_FILES) assert.ok(existsSync(join(ws, file)), file);
});

test('guidance tokens that prepare would not find are rejected before anything is created', () => {
  for (const to of ['.claude/plugins/local/skills/design-system', 'src/design-system', 'tools/design-system', 'a/b/c/d/e']) {
    const out = fresh();
    assert.throws(() => materialize({ out, install: false, guidance: { from: 'core/design-system', to } }), /wouldn't find the guidance tokens/, to);
    assert.ok(!existsSync(out), to);
  }
  // Every accepted destination produces the token CSS.
  for (const to of ['design-system', '.claude/skills/design-system', '.agents/skills/design-system', 'a/b/c/design-system']) {
    const ws = materialize({ out: fresh(), install: false, guidance: { from: 'core/design-system', to } });
    execFileSync(process.execPath, ['tools/prepare.ts'], { cwd: ws, stdio: 'pipe' });
    assert.ok(existsSync(join(ws, 'src', 'design-tokens.css')), to);
  }
});

test('guidance without tokens can go anywhere inside the workspace', () => {
  const guidance = temp('starter-guidance-');
  writeFileSync(join(guidance, 'SKILL.md'), '---\nname: x\n---\n');
  const ws = materialize({ out: fresh(), install: false, guidance: { from: guidance, to: '.claude/plugins/local/skills/x' } });
  assert.ok(existsSync(join(ws, '.claude', 'plugins', 'local', 'skills', 'x', 'SKILL.md')));
});

test('prepare follows a linked token folder and skips .git', () => {
  const linked = materialize({ out: fresh(), install: false });
  symlinkSync(join(REPO, 'core', 'design-system'), join(linked, 'linked-skill'));
  execFileSync(process.execPath, ['tools/prepare.ts'], { cwd: linked, stdio: 'pipe' });
  assert.ok(existsSync(join(linked, 'src', 'design-tokens.css')), 'tokens found through a linked folder');

  const withGit = materialize({ out: fresh(), install: false });
  mkdirSync(join(withGit, '.git', 'objects'), { recursive: true });
  copyFileSync(join(REPO, 'core', 'design-system', 'tokens.resolver.json'), join(withGit, '.git', 'objects', 'tokens.resolver.json'));
  execFileSync(process.execPath, ['tools/prepare.ts'], { cwd: withGit, stdio: 'pipe' });
  assert.ok(!existsSync(join(withGit, 'src', 'design-tokens.css')), '.git is never searched');
});

test('the locked dependencies install and the blank app type-checks and builds', () => {
  const ws = materialize({ out: fresh() });
  execFileSync('pnpm', ['build'], { cwd: ws, stdio: 'pipe' });
  assert.ok(existsSync(join(ws, 'dist', 'index.html')));
});

test('with the skill installed, the app still installs, generates its token CSS and builds', () => {
  const ws = materialize({ out: fresh(), guidance: { from: 'core/design-system', to: '.claude/skills/design-system' } });
  execFileSync('pnpm', ['build'], { cwd: ws, stdio: 'pipe' });
  assert.ok(existsSync(join(ws, 'dist', 'index.html')));
  assert.match(readFileSync(join(ws, 'src', 'design-tokens.css'), 'utf8'), /^\/\* Generated by the token converter from /);
});

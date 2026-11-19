// A stand-in for an agent: copies the conformance app into the workspace
// instead of calling a model, so the whole runner pipeline can run inside
// `pnpm check` for free. Its isolation checks only cover what it does
// itself: it writes inside the workspace and nowhere else.
//
// Variants exist only for the runner's own tests:
//   broken-build   writes a type error into src/, so `pnpm build` fails
//   leaky          reads the canary, so the isolation checks fail
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Adapter, GenerateOptions, GenerateResult } from '../types.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CONFORMANCE_APP = join(REPO, 'evals', 'tests', 'conformance-app');

export type FakeVariant = 'conformance' | 'broken-build' | 'leaky';

export function fakeAdapter(variant: FakeVariant = 'conformance'): Adapter {
  return {
    name: variant === 'conformance' ? 'fake' : `fake-${variant}`,
    live: false,
    skillDir: (name) => join('.claude', 'skills', name),
    version: () => undefined,
    async generate(workspace: string, prompt: string, options: GenerateOptions): Promise<GenerateResult> {
      const written: string[] = [];
      const write = (rel: string, from: string) => {
        copyFileSync(from, join(workspace, rel));
        written.push(rel);
      };
      write('index.html', join(CONFORMANCE_APP, 'index.html'));
      write('main.ts', join(CONFORMANCE_APP, 'main.ts'));
      let sawCanary = false;
      if (variant === 'broken-build') {
        writeFileSync(join(workspace, 'src', 'App.tsx'), 'export function App(): number {\n  return "not a number";\n}\n');
        written.push('src/App.tsx');
      }
      if (variant === 'leaky') sawCanary = readFileSync(options.canary.file, 'utf8').includes(options.canary.token);

      const log = { adapter: 'fake', variant, prompt, written };
      writeFileSync(join(options.logDir, 'fake.json'), `${JSON.stringify(log, null, 2)}\n`);
      return {
        ok: true,
        logs: ['fake.json'],
        isolation: [
          { id: 'fake.writes-inside-workspace', ok: true, detail: `wrote only ${written.join(', ')} inside the workspace` },
          { id: 'fake.canary-unread', ok: !sawCanary, detail: sawCanary ? `read the canary at ${options.canary.file}` : 'never opened the canary' },
        ],
        settings: { variant },
      };
    },
  };
}

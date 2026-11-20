// Shared behavior tests. Point EVAL_BASE_URL at a condition's running app
// (served with the mock API plugin) to test it. Without it, the tests run
// against the conformance app, plus the meta tests that check the tests
// themselves.
import { execFileSync } from 'node:child_process';
import { defineConfig } from '@playwright/test';
import { PROJECTS } from './projects.ts';

const external = process.env['EVAL_BASE_URL'];

/**
 * The conformance app gets a port the OS picks for this run, and Playwright
 * always starts its own server there (--strictPort, never reusing one).
 * A fixed port let a concurrent run elsewhere own the server and stop it
 * mid-run. The main process picks the port once; its workers inherit it
 * through the environment, so every process tests the same server.
 */
function conformancePort(): number {
  const key = 'EVAL_CONFORMANCE_PORT';
  process.env[key] ??= execFileSync(
    process.execPath,
    ['-e', 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { process.stdout.write(String(s.address().port)); s.close(); });'],
    { encoding: 'utf8' },
  ).trim();
  return Number(process.env[key]);
}

const conformance = external ? undefined : `http://127.0.0.1:${conformancePort()}`;

export default defineConfig({
  testDir: '.',
  testMatch: external ? ['asset-library/**/*.spec.ts'] : ['asset-library/**/*.spec.ts', 'meta/**/*.spec.ts'],
  timeout: 120_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env['CI'],
  reporter: [['list']],
  use: {
    baseURL: external ?? conformance,
    ...(process.env['EVAL_MOCK_ADMIN_TOKEN'] ? { serviceWorkers: 'block' } : {}),
  },
  ...(conformance
    ? {
        webServer: {
          command: `pnpm exec vite --config conformance-app/vite.config.ts --host 127.0.0.1 --port ${new URL(conformance).port} --strictPort`,
          url: conformance,
          reuseExistingServer: false,
        },
      }
    : {}),
  // Meta tests check the tests themselves, so one project is enough.
  projects: PROJECTS.map((project) => (project.name === 'desktop-light' ? project : { ...project, testIgnore: 'meta/**' })),
});

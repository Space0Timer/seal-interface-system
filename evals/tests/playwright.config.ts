// Shared behavior tests. Point EVAL_BASE_URL at a condition's running app
// (served with the mock API plugin) to test it. Without it, the tests run
// against the conformance app, plus the meta tests that check the tests
// themselves.
import { defineConfig, devices } from '@playwright/test';

const external = process.env['EVAL_BASE_URL'];
const port = 5299;

export default defineConfig({
  testDir: '.',
  testMatch: external ? ['asset-library/**/*.spec.ts'] : ['asset-library/**/*.spec.ts', 'meta/**/*.spec.ts'],
  timeout: 120_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env['CI'],
  reporter: [['list']],
  use: { baseURL: external ?? `http://localhost:${port}` },
  ...(external
    ? {}
    : {
        webServer: {
          command: `pnpm exec vite --config conformance-app/vite.config.ts --port ${port} --strictPort`,
          url: `http://localhost:${port}`,
          reuseExistingServer: !process.env['CI'],
        },
      }),
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile-touch', use: { ...devices['Pixel 7'] } },
  ],
});

// Screenshots of each required state, for review. The runner points
// EVAL_BASE_URL at the condition's served build and EVAL_SCREENSHOT_DIR at the
// run's results. Every project from the behavior tests: desktop and mobile,
// light and dark.
import { defineConfig } from '@playwright/test';
import { PROJECTS } from '../tests/projects.ts';

const base = process.env['EVAL_BASE_URL'];
const brief = process.env['EVAL_BRIEF'] ?? 'asset-library';
if (!base || !process.env['EVAL_SCREENSHOT_DIR']) throw new Error('set EVAL_BASE_URL and EVAL_SCREENSHOT_DIR');

export default defineConfig({
  testDir: 'screenshots',
  testMatch: [`${brief}.spec.ts`],
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { baseURL: base, ...(process.env['EVAL_MOCK_ADMIN_TOKEN'] ? { serviceWorkers: 'block' } : {}) },
  projects: [...PROJECTS],
});

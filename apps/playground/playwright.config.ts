import { defineConfig, devices } from '@playwright/test';

const port = 5199;

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env['CI'],
  reporter: [['list']],
  use: { baseURL: `http://localhost:${port}` },
  webServer: {
    // Tokens must be built first (`pnpm tokens:build`, part of `pnpm check`).
    command: `pnpm exec vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env['CI'],
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // Touch emulation: no hover, real tap targets (P5, P6).
    { name: 'mobile-touch', use: { ...devices['Pixel 7'] } },
  ],
});

// Smoke test for the token pipeline: generated CSS loads, each mode maps its
// own values, and reduced motion zeroes durations. Expected values come from
// the generated custom properties, not copies of token values.
import { expect, test, type Page } from '@playwright/test';

function hexToRgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

function readRoot(page: Page) {
  return page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      canvas: style.getPropertyValue('--color-surface-canvas').trim(),
      background: style.backgroundColor,
      fontFamily: style.fontFamily,
      fastDuration: style.getPropertyValue('--motion-duration-fast').trim(),
    };
  });
}

test('light mode applies the canvas token and the system font', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const root = await readRoot(page);
  expect(root.canvas).toMatch(/^#[0-9a-f]{6}$/);
  expect(root.background).toBe(hexToRgb(root.canvas));
  expect(root.fontFamily).toMatch(/^system-ui/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('dark mode follows the system setting and data-mode overrides it', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  const light = await readRoot(page);

  await page.emulateMedia({ colorScheme: 'dark' });
  const dark = await readRoot(page);
  expect(dark.canvas).not.toBe(light.canvas);
  expect(dark.background).toBe(hexToRgb(dark.canvas));

  await page.evaluate(() => document.documentElement.setAttribute('data-mode', 'light'));
  expect((await readRoot(page)).canvas).toBe(light.canvas);

  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => document.documentElement.setAttribute('data-mode', 'dark'));
  expect((await readRoot(page)).canvas).toBe(dark.canvas);
});

test('reduced motion sets durations to zero', async ({ page }) => {
  await page.goto('/');
  expect((await readRoot(page)).fastDuration).not.toBe('0ms');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect((await readRoot(page)).fastDuration).toBe('0ms');
});

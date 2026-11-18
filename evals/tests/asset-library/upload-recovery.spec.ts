import { expect, test } from '@playwright/test';
import { OVERSIZED_FILENAME, TRANSIENT_FAILURE_FILENAME } from '../../fixtures/src/data.ts';
import { checkOversizedRecovery, checkTransientRecovery, controlsIn, failedItem, openLibrary, uploadBatch } from './helpers.ts';

const FAILED = [TRANSIENT_FAILURE_FILENAME, OVERSIZED_FILENAME];

test('partial failure: each failed file has recovery controls visible without hover and reachable by Tab', async ({ page }, info) => {
  await openLibrary(page, 'default');
  await uploadBatch(page);
  if (!info.project.use.hasTouch) await page.mouse.move(0, 0);

  for (const filename of FAILED) {
    const controls = controlsIn(await failedItem(page, filename));
    expect(await controls.count(), `${filename} has a visible control`).toBeGreaterThan(0);
  }

  // Tab from the top of the page until focus lands on a control in each failed item.
  const reached = new Set<string>();
  await page.locator('body').focus();
  for (let i = 0; i < 400 && reached.size < FAILED.length; i++) {
    await page.keyboard.press('Tab');
    const scope = await page.evaluate(() => document.activeElement?.closest('[data-eval-scope]')?.textContent ?? null);
    for (const filename of FAILED) if (scope?.includes(filename)) reached.add(filename);
  }
  expect([...reached].sort(), 'failed items reached with Tab').toEqual([...FAILED].sort());
});

test('transient failure: recovery resends only that file', async ({ page }) => {
  await checkTransientRecovery(page);
});

test('validation failure: recovery never resends the oversized file and accepts a replacement', async ({ page }) => {
  await checkOversizedRecovery(page);
});

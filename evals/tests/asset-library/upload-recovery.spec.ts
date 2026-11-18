import { expect, test } from '@playwright/test';
import { OVERSIZED_FILENAME, TRANSIENT_FAILURE_FILENAME } from '../../fixtures/src/data.ts';
import {
  checkOversizedRecovery,
  checkTransientRecovery,
  controlsIn,
  failedItem,
  measureTouchTargets,
  openLibrary,
  TOUCH_TARGET_MIN,
  uploadBatch,
} from './helpers.ts';

test('partial failure: each failed file has recovery controls visible without hover', async ({ page }, info) => {
  await openLibrary(page, 'default');
  await uploadBatch(page);
  if (!info.project.use.hasTouch) await page.mouse.move(0, 0);
  for (const filename of [TRANSIENT_FAILURE_FILENAME, OVERSIZED_FILENAME]) {
    const controls = controlsIn(await failedItem(page, filename));
    expect(await controls.count(), `${filename} has a visible control`).toBeGreaterThan(0);
  }

  // On touch layouts, record every clickable target's size as design-fit
  // evidence (P6). Reviewers score it; it doesn't fail this behavior test.
  if (info.project.use.hasTouch) {
    const targets = await measureTouchTargets(page);
    const small = targets.filter((t) => !t.meetsMinimum);
    await info.attach('touch-targets.json', { body: JSON.stringify({ minimum: TOUCH_TARGET_MIN, targets }, null, 2), contentType: 'application/json' });
    info.annotations.push({
      type: 'design-fit evidence (P6)',
      description: `${small.length} of ${targets.length} interactive targets are smaller than ${TOUCH_TARGET_MIN} × ${TOUCH_TARGET_MIN} px`,
    });
  }
});

// Each check tries every control with the mouse, then requires a working
// recovery to also work from the keyboard (Tab, then Enter).
test('transient failure: recovery resends only that file and clears the failure', async ({ page }) => {
  await checkTransientRecovery(page);
});

test('validation failure: recovery never resends the oversized file and accepts a replacement', async ({ page }) => {
  await checkOversizedRecovery(page);
});

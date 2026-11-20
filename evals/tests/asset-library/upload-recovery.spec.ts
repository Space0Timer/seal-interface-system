import { writeFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { OVERSIZED_FILENAME, TRANSIENT_FAILURE_FILENAME } from '../../fixtures/src/data.ts';
import { test } from '../browser.ts';
import {
  checkBothFailuresRecover,
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
  // Written to a file in the test's output folder so it survives the run.
  if (info.project.use.hasTouch) {
    const targets = await measureTouchTargets(page);
    const small = targets.filter((t) => !t.meetsMinimum);
    const summary = `${small.length} of ${targets.length} interactive targets are smaller than ${TOUCH_TARGET_MIN} × ${TOUCH_TARGET_MIN} px`;
    const file = info.outputPath('touch-targets.json');
    writeFileSync(file, `${JSON.stringify({ project: info.project.name, state: 'partial upload failure', minimum: TOUCH_TARGET_MIN, summary, targets }, null, 2)}\n`);
    await info.attach('touch-targets.json', { path: file, contentType: 'application/json' });
    info.annotations.push({ type: 'design-fit evidence (P6)', description: summary });
    console.log(`[${info.project.name}] touch targets (P6 evidence): ${summary}. Details: ${file}`);
  }
});

test('partial failure: both failed files can be recovered in one batch, in either order', async ({ page }) => {
  await checkBothFailuresRecover(page);
});

// Each check tries every control with the mouse, then requires a working
// recovery to also work from the keyboard (Tab, then Enter).
test('transient failure: recovery resends only that file and clears the failure', async ({ page }) => {
  await checkTransientRecovery(page);
});

test('validation failure: recovery never resends the oversized file and accepts a replacement', async ({ page }) => {
  await checkOversizedRecovery(page);
});

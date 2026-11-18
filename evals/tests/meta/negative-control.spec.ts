// Tests the tests: the shared recovery check must fail an app that has
// learned "failed upload = Retry". Runs only against the conformance app.
import { expect, test } from '@playwright/test';
import { checkOversizedRecovery, checkTransientRecovery } from '../asset-library/helpers.ts';

const variant = { path: '/?variant=retry-everything' };

test.describe('retry-everything variant', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop is enough to test the tests.');

  test('the oversized-file check rejects Retry on a validation failure', async ({ page }) => {
    await expect(checkOversizedRecovery(page, variant)).rejects.toThrow(/resent Q3-brand-guidelines-final-v2\.pdf/);
  });

  test('the transient check still passes, so the failure above is specific', async ({ page }) => {
    await checkTransientRecovery(page, variant);
  });
});

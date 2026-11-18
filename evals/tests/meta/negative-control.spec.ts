// Tests the tests: the shared recovery checks must fail broken variants of
// the conformance app, each for the right reason. Runs only against the
// conformance app, in the desktop-light project (see playwright.config.ts).
import { expect, test } from '@playwright/test';
import { checkOversizedRecovery, checkTransientRecovery } from '../asset-library/helpers.ts';

test.describe.configure({ mode: 'parallel' });

const variant = (name: string) => ({ path: `/?variant=${name}` });
const STALE = /still shows the failure|status region did not change/;
const MOUSE_ONLY = /can't be reached with Tab/;

test('retry-everything: the oversized check rejects Retry on a validation failure', async ({ page }) => {
  await expect(checkOversizedRecovery(page, variant('retry-everything'))).rejects.toThrow(/resent Q3-brand-guidelines-final-v2\.pdf/);
});

test('retry-everything: the transient check still passes, so the failure above is specific', async ({ page }) => {
  await checkTransientRecovery(page, variant('retry-everything'));
});

test('stale-after-recovery: the transient check rejects a screen that still shows the failure', async ({ page }) => {
  await expect(checkTransientRecovery(page, variant('stale-after-recovery'))).rejects.toThrow(STALE);
});

test('stale-after-recovery: the oversized check rejects a screen that still shows the failure', async ({ page }) => {
  await expect(checkOversizedRecovery(page, variant('stale-after-recovery'))).rejects.toThrow(STALE);
});

test('mouse-only-recovery: the transient check rejects recovery that Tab cannot reach', async ({ page }) => {
  await expect(checkTransientRecovery(page, variant('mouse-only-recovery'))).rejects.toThrow(MOUSE_ONLY);
});

test('mouse-only-recovery: the oversized check rejects recovery that Tab cannot reach', async ({ page }) => {
  await expect(checkOversizedRecovery(page, variant('mouse-only-recovery'))).rejects.toThrow(MOUSE_ONLY);
});

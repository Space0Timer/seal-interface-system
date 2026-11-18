// Tests the tests. Broken variants of the conformance app must fail the
// shared checks, each for the right reason; valid variations must pass.
// Runs only against the conformance app, in the desktop-light project (see
// playwright.config.ts).
import { expect, test } from '@playwright/test';
import {
  checkAllAssetsReachable,
  checkLargeLibrary,
  checkOversizedRecovery,
  checkSearchFinds,
  checkTransientRecovery,
} from '../asset-library/helpers.ts';

test.describe.configure({ mode: 'parallel' });

const at = (query: string) => ({ path: `/?${query}` });
const STALE = /failed item is still on screen|is still offered|upload result still reads/;
const MOUSE_ONLY = /can't be reached with Tab/;

test.describe('broken variants fail', () => {
  test('retry-everything: the oversized check rejects Retry on a validation failure', async ({ page }) => {
    await expect(checkOversizedRecovery(page, at('variant=retry-everything'))).rejects.toThrow(/resent Q3-brand-guidelines-final-v2\.pdf/);
  });

  test('stale-after-recovery: the transient check rejects an unchanged screen', async ({ page }) => {
    await expect(checkTransientRecovery(page, at('variant=stale-after-recovery'))).rejects.toThrow(STALE);
  });

  test('stale-after-recovery: the oversized check rejects an unchanged screen', async ({ page }) => {
    await expect(checkOversizedRecovery(page, at('variant=stale-after-recovery'))).rejects.toThrow(STALE);
  });

  test('stale-rerender: the transient check rejects a re-created failure with a "Retry sent" message', async ({ page }) => {
    await expect(checkTransientRecovery(page, at('variant=stale-rerender'))).rejects.toThrow(STALE);
  });

  test('stale-rerender: the oversized check rejects a re-created failure', async ({ page }) => {
    await expect(checkOversizedRecovery(page, at('variant=stale-rerender'))).rejects.toThrow(STALE);
  });

  test('mouse-only-recovery: the transient check rejects recovery that Tab cannot reach', async ({ page }) => {
    await expect(checkTransientRecovery(page, at('variant=mouse-only-recovery'))).rejects.toThrow(MOUSE_ONLY);
  });

  test('mouse-only-recovery: the oversized check rejects recovery that Tab cannot reach', async ({ page }) => {
    await expect(checkOversizedRecovery(page, at('variant=mouse-only-recovery'))).rejects.toThrow(MOUSE_ONLY);
  });

  test('empty-search: the search check rejects a search that shows nothing', async ({ page }) => {
    await expect(checkSearchFinds(page, at('variant=empty-search'))).rejects.toThrow(/items shown for "invoice"/);
  });

  test('search-loaded-only: the search check rejects searching only loaded pages', async ({ page }) => {
    await expect(checkSearchFinds(page, at('variant=search-loaded-only'))).rejects.toThrow(/items shown for "invoice"/);
  });
});

test.describe('valid variations pass', () => {
  test('retry-everything: the transient check still passes, so its oversized failure is specific', async ({ page }) => {
    await checkTransientRecovery(page, at('variant=retry-everything'));
  });

  test('five per page with prefetching: every asset is reachable', async ({ page }) => {
    await checkAllAssetsReachable(page, at('page=5&prefetch=1'));
  });

  test('five per page with prefetching: the large library reaches a later page', async ({ page }) => {
    await checkLargeLibrary(page, at('page=5&prefetch=1'));
  });

  test('five per page with prefetching: search still finds assets', async ({ page }) => {
    await checkSearchFinds(page, at('page=5&prefetch=1'));
  });
});

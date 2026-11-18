// Tests the tests. Broken variants of the conformance app must fail the
// shared checks, each for the right reason; valid variations must pass.
// Runs only against the conformance app, in the desktop-light project (see
// playwright.config.ts).
import { expect, test } from '@playwright/test';
import {
  checkAllAssetsReachable,
  checkBothFailuresRecover,
  checkBulkDelete,
  measureTouchTargets,
  checkLargeLibrary,
  checkOversizedRecovery,
  checkSearchFinds,
  checkTransientRecovery,
} from '../asset-library/helpers.ts';

test.describe.configure({ mode: 'parallel' });

const at = (query: string) => ({ path: `/?${query}` });
const STALE = /failed item is still on screen|is still offered|upload summary still reads/;
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

  test('stale-summary: the transient check rejects an unchanged summary beside a changing asset count', async ({ page }) => {
    await expect(checkTransientRecovery(page, at('variant=stale-summary'))).rejects.toThrow(/upload summary still reads \W{1,3}10 of 12 uploaded/);
  });

  test('fetch-all-later: the large-library check rejects fetching everything after the first render', async ({ page }) => {
    await expect(checkLargeLibrary(page, at('variant=fetch-all-later'))).rejects.toThrow(/assets requested up front/);
  });

  test('retry-clears-all: a recovery that makes the other failure unrecoverable is rejected', async ({ page }) => {
    await expect(checkBothFailuresRecover(page, at('variant=retry-clears-all'))).rejects.toThrow(/still has a failed item with recovery controls/);
  });

  test('delete-extra: bulk delete that also removes an unselected asset is rejected', async ({ page }) => {
    await expect(checkBulkDelete(page, at('variant=delete-extra'))).rejects.toThrow(/assets deleted across the interaction|unselected assets no longer in the library/);
  });

  test('json-body: uploads that lose the file contents are rejected', async ({ page }) => {
    await expect(checkTransientRecovery(page, at('variant=json-body'))).rejects.toThrow(/expected one successful upload of \d+ bytes/);
  });

  test('summary-vanishes: removing the summary while a failure remains is rejected', async ({ page }) => {
    await expect(checkTransientRecovery(page, at('variant=summary-vanishes'))).rejects.toThrow(/upload summary is gone although a failure remains/);
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

  test('one per page: search follows result pages to find both invoices', async ({ page }) => {
    await checkSearchFinds(page, at('page=1'));
  });

  test('one per page: bulk delete selects across pages', async ({ page }) => {
    await checkBulkDelete(page, at('page=1'));
  });

  test('aria-labelledby names with truncated text: every asset is reachable', async ({ page }) => {
    await checkAllAssetsReachable(page, at('labelledby=1'));
  });

  test('aria-labelledby names with truncated text: bulk delete finds and selects rows', async ({ page }) => {
    await checkBulkDelete(page, at('labelledby=1'));
  });

  test('"More actions" on every row: pagination still finds the page\'s "Load more"', async ({ page }) => {
    await checkAllAssetsReachable(page, at('row-actions=1'));
  });

  test('"More actions" on every row: transient recovery still passes', async ({ page }) => {
    await checkTransientRecovery(page, at('row-actions=1'));
  });

  test('"Load more" inside a pagination nav > ul > li: every asset is reachable', async ({ page }) => {
    await checkAllAssetsReachable(page, at('pager-nav=1'));
  });

  test('both failures recover in one batch, in either order', async ({ page }) => {
    await checkBothFailuresRecover(page);
  });
});

test.describe('touch-target measurement', () => {
  test('the gap between a small checkbox and a separate label is not counted', async ({ page }) => {
    await page.setContent(
      '<input type="checkbox" id="c" style="width:16px;height:16px;margin:0">' +
        '<span style="display:inline-block;width:80px"></span>' +
        '<label for="c" style="display:inline-block;width:22px;height:18px">On</label>',
    );
    const [box] = await measureTouchTargets(page);
    expect(box?.meetsMinimum).toBe(false);
    expect(box?.width).toBeLessThanOrEqual(22);
  });

  test('a label that wraps its control counts as one target', async ({ page }) => {
    await page.setContent('<label style="display:inline-block;padding:14px"><input type="checkbox" style="width:16px;height:16px;margin:0"> On</label>');
    const [box] = await measureTouchTargets(page);
    expect(box?.meetsMinimum).toBe(true);
  });
});

test('conformance app: double-clicking "Load more" with a slow response appends each page once', async ({ page }) => {
  await page.route(/\/api\/assets\?.*offset=20/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  await page.request.post('/__mock/reset', { data: { scenario: 'default' } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Load more' }).dblclick();
  await expect(page.locator('tbody tr')).toHaveCount(39);
  await page.waitForTimeout(1_000);
  await expect(page.locator('tbody tr')).toHaveCount(39);
});

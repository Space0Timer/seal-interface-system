import { expect, test } from '@playwright/test';
import { assetsFor, DEFAULT_ASSETS, NO_RESULTS_QUERY } from '../../fixtures/src/data.ts';
import { isSelected, libraryItem, loadMore, mockLog, openLibrary, selectItem, settleUploads, uploadFiles, visibleItems } from './helpers.ts';

const DEFAULT_NAMES = DEFAULT_ASSETS.map((a) => a.filename);
const FIRST_PAGE = DEFAULT_NAMES.slice(0, 10);
const LARGE_NAMES = assetsFor('large').map((a) => a.filename);

test('populated: the newest assets appear as items exposing their full filenames', async ({ page }) => {
  await openLibrary(page, 'default');
  await expect.poll(() => visibleItems(page, FIRST_PAGE)).toEqual(FIRST_PAGE);
});

test('pagination: every asset in the default library can be reached', async ({ page }) => {
  await openLibrary(page, 'default');
  await expect.poll(() => visibleItems(page, FIRST_PAGE)).toEqual(FIRST_PAGE);
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    for (const name of await visibleItems(page, DEFAULT_NAMES)) seen.add(name);
    if (seen.size === DEFAULT_NAMES.length || !(await loadMore(page))) break;
  }
  expect(DEFAULT_NAMES.filter((n) => !seen.has(n)), 'assets never shown').toEqual([]);
});

test('large library: loads in pages and reaches a later page', async ({ page }) => {
  await openLibrary(page, 'large');
  await expect.poll(() => visibleItems(page, LARGE_NAMES.slice(0, 10)), { timeout: 5_000 }).toHaveLength(10);
  const requested = (await mockLog(page))
    .filter((e) => e.path === '/api/assets')
    .reduce((sum, e) => sum + Math.min(Number(e.query['limit'] ?? 50), 200), 0);
  expect(requested, 'assets requested on first load').toBeLessThanOrEqual(1_000);

  const scan = LARGE_NAMES.slice(0, 2_000);
  const furthest = async () => Math.max(-1, ...(await visibleItems(page, scan)).map((n) => scan.indexOf(n)));
  const before = await furthest();
  expect(await loadMore(page), 'scrolling to the end, or a "more" or "next" control, requests a later page').toBe(true);
  await expect.poll(furthest, { message: 'items from the later page appear' }).toBeGreaterThan(before);
});

test('empty: no items, and uploading a file adds it', async ({ page }) => {
  await openLibrary(page, 'empty');
  await page.waitForLoadState('networkidle');
  expect(await visibleItems(page, DEFAULT_NAMES)).toEqual([]);

  const file = uploadFiles.batch[0]!;
  await page.locator('input[type=file][multiple]').first().setInputFiles(file);
  const entries = await settleUploads(page, 1);
  const upload = entries.find((e) => e.path === '/api/uploads');
  expect(upload?.status).toBe(201);
  await expect(libraryItem(page, upload?.filename ?? '')).toBeVisible();
});

test('no results: a search with no matches shows no items, and clearing it restores them', async ({ page }) => {
  await openLibrary(page, 'default');
  await expect.poll(() => visibleItems(page, FIRST_PAGE)).toEqual(FIRST_PAGE);
  const search = page.getByRole('searchbox').or(page.getByRole('textbox', { name: /search/i })).first();
  await search.fill(NO_RESULTS_QUERY);
  await expect.poll(() => visibleItems(page, DEFAULT_NAMES)).toEqual([]);
  await search.fill('');
  await expect.poll(() => visibleItems(page, FIRST_PAGE)).toEqual(FIRST_PAGE);
});

test('multi-select: three selected assets are deleted together', async ({ page }) => {
  await openLibrary(page, 'default');
  const targets = DEFAULT_ASSETS.slice(1, 4);
  for (const asset of targets) {
    const item = libraryItem(page, asset.filename);
    await selectItem(item);
    expect(await isSelected(item), `${asset.filename} reports selected`).toBe(true);
  }

  const outsideItems = page.locator('button, [role=button]').filter({ hasText: /delete|remove/i });
  const labelled = page.getByRole('button', { name: /delete|remove/i });
  const candidates = labelled.or(outsideItems).filter({ visible: true });
  const itemSelector = 'tr, li, [role=row], [role=listitem], [role=option]';
  const index = await candidates.evaluateAll((els, sel) => els.findIndex((el) => !el.closest(sel)), itemSelector);
  expect(index, 'a visible Delete or Remove control outside the items').toBeGreaterThanOrEqual(0);
  await candidates.nth(index).click();

  const dialog = page.getByRole('dialog').or(page.getByRole('alertdialog')).filter({ visible: true });
  if (await dialog.count()) await dialog.getByRole('button', { name: /delete|remove/i }).first().click();

  await expect
    .poll(async () => (await mockLog(page)).find((e) => e.path === '/api/assets/delete')?.ids?.slice().sort())
    .toEqual(targets.map((a) => a.id).sort());
  await expect.poll(() => visibleItems(page, targets.map((a) => a.filename))).toEqual([]);
});

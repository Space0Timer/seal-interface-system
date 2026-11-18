import { expect, test } from '@playwright/test';
import { DEFAULT_ASSETS, NO_RESULTS_QUERY } from '../../fixtures/src/data.ts';
import {
  checkAllAssetsReachable,
  checkLargeLibrary,
  checkSearchFinds,
  DEFAULT_NAMES,
  isSelected,
  libraryItem,
  mockLog,
  openLibrary,
  searchField,
  selectItem,
  settleUploads,
  uploadFiles,
  visibleItems,
  waitForItems,
} from './helpers.ts';

test('populated: assets render as items exposing their full filenames', async ({ page }) => {
  await openLibrary(page, 'default');
  await waitForItems(page, DEFAULT_NAMES);
});

test('pagination: every asset in the default library can be reached', async ({ page }) => {
  await checkAllAssetsReachable(page);
});

test('large library: loads in pages and reaches a later page', async ({ page }) => {
  await checkLargeLibrary(page);
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

test('search: finds matching assets beyond the first page, and only those', async ({ page }) => {
  await checkSearchFinds(page);
});

test('no results: a search with no matches shows no items, and clearing it restores them', async ({ page }) => {
  await openLibrary(page, 'default');
  const initial = await waitForItems(page, DEFAULT_NAMES);
  await searchField(page).fill(NO_RESULTS_QUERY);
  await expect.poll(() => visibleItems(page, DEFAULT_NAMES)).toEqual([]);
  await searchField(page).fill('');
  await expect.poll(() => visibleItems(page, DEFAULT_NAMES)).toEqual(initial);
});

test('multi-select: three selected assets are deleted together', async ({ page }) => {
  await openLibrary(page, 'default');
  const rendered = await waitForItems(page, DEFAULT_NAMES);
  const targets = DEFAULT_ASSETS.filter((a) => rendered.includes(a.filename)).slice(0, 3);
  expect(targets, 'at least three assets on the first page').toHaveLength(3);
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

import { expect } from '@playwright/test';
import { NO_RESULTS_QUERY } from '../../fixtures/src/data.ts';
import { test } from '../browser.ts';
import {
  checkAllAssetsReachable,
  checkBulkDelete,
  checkLargeLibrary,
  checkSearchFinds,
  checkWholeLibrarySearch,
  DEFAULT_NAMES,
  libraryItem,
  openLibrary,
  searchField,
  settleUploads,
  UPLOAD_SIZES,
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
  expect(upload?.sizeBytes, 'the upload carries the file’s bytes').toBe(UPLOAD_SIZES.get(upload?.filename ?? ''));
  await expect(libraryItem(page, upload?.filename ?? '')).toBeVisible();
});

test('search: finds exactly the matching invoices', async ({ page }) => {
  await checkSearchFinds(page);
});

test('search: finds a filename not fetched before the search in the large library', async ({ page }) => {
  await checkWholeLibrarySearch(page);
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
  await checkBulkDelete(page);
});

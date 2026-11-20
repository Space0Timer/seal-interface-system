// Full-page screenshots of the asset-library brief's required states, driven
// by the shared test helpers. Each PNG is saved only after its state is
// reached, confirmed by the mock API's log and by what renders, so a
// screenshot never shows a loading screen. If a state can't be reached, the
// test fails and no file is written; the runner records why.
//
// The checks here are deliberately looser than the behavior tests: they
// confirm the state, not the testability contract, so reviewers still see
// a screen that misses a requirement. Selection is the exception, since it
// can only be driven through the contract's checkboxes or aria-selected.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { assetsFor, NO_RESULTS_QUERY, OVERSIZED_FILENAME, TRANSIENT_FAILURE_FILENAME, UPLOAD_BATCH, type Asset } from '../../fixtures/src/data.ts';
import {
  DEFAULT_NAMES,
  isSelected,
  libraryItem,
  loadMore,
  mockLog,
  openLibrary,
  searchField,
  selectItem,
  settleUploads,
  uploadFiles,
  uploadsIn,
  visibleItems,
} from '../../tests/asset-library/helpers.ts';

const DIR = process.env['EVAL_SCREENSHOT_DIR']!;
const LARGE_NAMES = assetsFor('large')
  .slice(0, 1_000)
  .map((a) => a.filename);
const DEFAULT_ASSETS = assetsFor('default');

/** Filenames shown on the page, as items or as plain text. */
async function shownNames(page: Page, names: readonly string[]): Promise<string[]> {
  const items = await visibleItems(page, names);
  const text = await page.evaluate(() => document.body.innerText);
  return [...new Set([...items, ...names.filter((n) => text.includes(n))])];
}

/** Every GET /api/assets so far has its final status. */
async function assetRequestsDone(page: Page): Promise<boolean> {
  const requests = (await mockLog(page)).filter((e) => e.path === '/api/assets');
  return requests.length > 0 && requests.every((e) => e.status !== 0);
}

/** Lets the screen settle: requests answered, images decoded, fonts loaded. Then scrolls to the top. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await page
    .waitForFunction(() => [...document.images].every((img) => img.complete), undefined, { timeout: 10_000 })
    .catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

async function shoot(page: Page, project: string, state: string): Promise<void> {
  await settle(page);
  mkdirSync(join(DIR, project), { recursive: true });
  await page.screenshot({ path: join(DIR, project, `${state}.png`), fullPage: true, animations: 'disabled', caret: 'hide' });
}

test('populated', async ({ page }, info) => {
  await openLibrary(page, 'default');
  await expect.poll(() => assetRequestsDone(page), { message: 'the assets request is answered' }).toBe(true);
  await expect.poll(async () => (await shownNames(page, DEFAULT_NAMES)).length, { message: 'assets are shown' }).toBeGreaterThan(0);
  await shoot(page, info.project.name, 'populated');
});

test('large-library', async ({ page }, info) => {
  await openLibrary(page, 'large');
  await expect.poll(() => assetRequestsDone(page), { message: 'the assets request is answered' }).toBe(true);
  await expect.poll(async () => (await shownNames(page, LARGE_NAMES)).length, { message: 'assets are shown' }).toBeGreaterThan(0);
  await shoot(page, info.project.name, 'large-library');
});

test('empty', async ({ page }, info) => {
  await openLibrary(page, 'empty');
  await expect.poll(() => assetRequestsDone(page), { message: 'the assets request is answered' }).toBe(true);
  const answered = (await mockLog(page)).filter((e) => e.path === '/api/assets' && e.status === 200);
  expect(answered.length, 'the library loaded (with 0 assets)').toBeGreaterThan(0);
  await shoot(page, info.project.name, 'empty');
});

test('no-results', async ({ page }, info) => {
  await openLibrary(page, 'default');
  await expect.poll(async () => (await shownNames(page, DEFAULT_NAMES)).length, { message: 'assets are shown' }).toBeGreaterThan(0);
  await searchField(page).fill(NO_RESULTS_QUERY);
  await expect.poll(() => shownNames(page, DEFAULT_NAMES), { message: `no assets are shown for "${NO_RESULTS_QUERY}"` }).toEqual([]);
  await expect.poll(() => assetRequestsDone(page)).toBe(true);
  await shoot(page, info.project.name, 'no-results');
});

test('multi-select', async ({ page }, info) => {
  await openLibrary(page, 'default');
  await expect.poll(async () => (await visibleItems(page, DEFAULT_NAMES)).length, { message: 'assets render as items' }).toBeGreaterThan(0);
  const selected: Asset[] = [];
  for (let i = 0; i < 10 && selected.length < 3; i++) {
    const shown = await visibleItems(page, DEFAULT_NAMES);
    for (const asset of DEFAULT_ASSETS) {
      if (selected.length === 3) break;
      if (!shown.includes(asset.filename) || selected.includes(asset)) continue;
      const item = libraryItem(page, asset.filename);
      await selectItem(item);
      expect(await isSelected(item), `${asset.filename} reports selected`).toBe(true);
      selected.push(asset);
    }
    if (selected.length < 3 && !(await loadMore(page, DEFAULT_NAMES))) break;
  }
  expect(selected, 'three assets are selected').toHaveLength(3);
  await shoot(page, info.project.name, 'multi-select');
});

test('partial-upload-failure', async ({ page }, info) => {
  await openLibrary(page, 'default');
  await expect.poll(() => assetRequestsDone(page), { message: 'the assets request is answered' }).toBe(true);
  await page.locator('input[type=file][multiple]').first().setInputFiles(uploadFiles.batch);
  // Every upload of the batch has its final status; at least the 11 the API can receive.
  const uploads = uploadsIn(await settleUploads(page, UPLOAD_BATCH.length - 1));
  const last = (name: string) => uploads.filter((u) => u.filename === name).at(-1);
  expect(uploads.filter((u) => u.status === 201).length, 'files uploaded').toBeGreaterThan(0);
  expect(last(TRANSIENT_FAILURE_FILENAME)?.status, `${TRANSIENT_FAILURE_FILENAME} failed`).toBe(503);
  expect(last(OVERSIZED_FILENAME)?.status ?? 413, `${OVERSIZED_FILENAME} failed`).toBe(413);
  await expect
    .poll(() => shownNames(page, [TRANSIENT_FAILURE_FILENAME, OVERSIZED_FILENAME]), { message: 'both failed files are shown' })
    .toEqual(expect.arrayContaining([TRANSIENT_FAILURE_FILENAME, OVERSIZED_FILENAME]));
  await shoot(page, info.project.name, 'partial-upload-failure');
});

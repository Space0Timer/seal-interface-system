// Helpers for the asset-library behavior tests. They rely only on the
// brief's testability requirements: roles, filenames and outcomes in the mock
// API's request log. Never on wording, layout, page size or a particular
// design.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type FileChooser, type Locator, type Page } from '@playwright/test';
import {
  assetsFor,
  DEFAULT_ASSETS,
  NOW,
  OVERSIZED_FILENAME,
  REPLACEMENT_FILE,
  TRANSIENT_FAILURE_FILENAME,
  UPLOAD_BATCH,
  type Scenario,
} from '../../fixtures/src/data.ts';
import { writeUploadFiles } from '../../fixtures/src/files.ts';
import type { LogEntry } from '../../fixtures/src/mock-api.ts';

export const uploadFiles = writeUploadFiles(join(tmpdir(), 'ds-eval-upload-files'));
export const DEFAULT_NAMES = DEFAULT_ASSETS.map((a) => a.filename);

export const ITEM = 'tr, li, [role=row], [role=listitem], [role=option]';
const CONTROL = 'button, a[href], [role=button], [role=link]';
const STATUS = '[role=status], [role=alert], [aria-live]:not([aria-live="off"]), output';
const BATCH_NAMES = UPLOAD_BATCH.map((f) => f.filename);

export interface OpenOptions {
  /** App path to open, for the meta tests' variants. */
  path?: string;
}

/** Fixes the clock, starts a fresh mock session in this browser context, and opens the app. */
export async function openLibrary(page: Page, scenario: Scenario, options: OpenOptions = {}): Promise<void> {
  await page.clock.setFixedTime(new Date(NOW));
  const res = await page.request.post('/__mock/reset', { data: { scenario } });
  expect(res.ok(), 'mock reset failed').toBe(true);
  await page.goto(options.path ?? '/');
}

export async function mockLog(page: Page): Promise<LogEntry[]> {
  const res = await page.request.get('/__mock/log');
  return ((await res.json()) as { entries: LogEntry[] }).entries;
}

export function uploadsIn(entries: LogEntry[]): LogEntry[] {
  return entries.filter((e) => e.path === '/api/uploads');
}

/** The list item for an asset: a row, list item or option containing the full filename. */
export function libraryItem(page: Page, filename: string): Locator {
  const byText = page.locator(ITEM).filter({ hasText: filename });
  const byLabel = page.locator(ITEM).and(page.locator(`[aria-label*=${JSON.stringify(filename)}]`));
  return byText.or(byLabel).last();
}

/** Filenames from the given list that currently appear, in full, in rendered items. In list order. */
export async function visibleItems(page: Page, filenames: readonly string[]): Promise<string[]> {
  return page.evaluate(
    ([selector, names]) => {
      const items = [...document.querySelectorAll<HTMLElement>(selector)].filter((el) => el.getClientRects().length > 0);
      const texts = items.map((el) => `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`);
      return names.filter((name) => texts.some((t) => t.includes(name)));
    },
    [ITEM, filenames] as const,
  );
}

/** Waits for at least one of the filenames to render as an item, and returns those rendered. */
export async function waitForItems(page: Page, filenames: readonly string[]): Promise<string[]> {
  await expect.poll(async () => (await visibleItems(page, filenames)).length, { message: 'assets render as items' }).toBeGreaterThan(0);
  return visibleItems(page, filenames);
}

/**
 * Loads more the way the brief allows: scroll the list to its end, or use a
 * button or link named "more" or "next". True if filenames that weren't
 * rendered before appear, whether or not a request was needed (an app may
 * have prefetched the page).
 */
export async function loadMore(page: Page, filenames: readonly string[]): Promise<boolean> {
  const before = new Set(await visibleItems(page, filenames));
  const newItemsAppear = async (timeout: number): Promise<boolean> => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if ((await visibleItems(page, filenames)).some((n) => !before.has(n))) return true;
      await page.waitForTimeout(150);
    }
    return false;
  };

  await page.evaluate((itemSelector) => {
    const items = document.querySelectorAll(itemSelector);
    items[items.length - 1]?.scrollIntoView({ block: 'end' });
    for (const el of document.querySelectorAll<HTMLElement>('*')) {
      const overflow = getComputedStyle(el).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
  }, ITEM);
  if (await newItemsAppear(1_500)) return true;

  const control = page
    .getByRole('button', { name: /more|next/i })
    .or(page.getByRole('link', { name: /more|next/i }))
    .filter({ visible: true })
    .first();
  if ((await control.count()) === 0) return false;
  await control.click({ timeout: 10_000 });
  return newItemsAppear(5_000);
}

export function searchField(page: Page): Locator {
  return page.getByRole('searchbox').or(page.getByRole('textbox', { name: /search/i })).first();
}

export async function selectItem(item: Locator): Promise<void> {
  const box = item.getByRole('checkbox');
  if ((await box.count()) > 0) await box.first().check();
  else {
    await item.focus();
    await item.press('Space');
  }
}

export async function isSelected(item: Locator): Promise<boolean> {
  const box = item.getByRole('checkbox');
  if ((await box.count()) > 0) return box.first().isChecked();
  return (await item.getAttribute('aria-selected')) === 'true';
}

/** Text of each visible status or live region (outermost regions only). */
export async function statusTexts(page: Page): Promise<string[]> {
  return page.evaluate((selector) => {
    const regions = [...document.querySelectorAll<HTMLElement>(selector)].filter(
      (el) => el.getClientRects().length > 0 && !el.parentElement?.closest(selector),
    );
    return regions.map((el) => el.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean);
  }, STATUS);
}

/**
 * Waits until every upload in the log has a response and no new uploads
 * have started for 750 ms, with at least `min` uploads in total.
 */
export async function settleUploads(page: Page, min: number): Promise<LogEntry[]> {
  let previous = -1;
  let stableSince = Date.now();
  const deadline = Date.now() + 60_000;
  for (;;) {
    const entries = await mockLog(page);
    const uploads = uploadsIn(entries);
    const pending = uploads.filter((e) => e.status === 0).length;
    if (uploads.length !== previous) {
      previous = uploads.length;
      stableSince = Date.now();
    } else if (uploads.length >= min && pending === 0 && Date.now() - stableSince >= 750) {
      return entries;
    }
    if (Date.now() > deadline) throw new Error(`uploads did not settle: ${uploads.length} of at least ${min}, ${pending} still in flight`);
    await page.waitForTimeout(150);
  }
}

const SUCCEEDING = BATCH_NAMES.filter((n) => n !== TRANSIENT_FAILURE_FILENAME && n !== OVERSIZED_FILENAME);

/**
 * Uploads the 12-file batch and checks it went out as expected: each of the
 * 10 ordinary files exactly once and successfully, the transient file once
 * (failing), and the oversized file at most once (it may be rejected in the
 * browser). Then waits for both failures to show as items with controls and
 * for the result to appear in a status region.
 */
export async function uploadBatch(page: Page): Promise<void> {
  const before = uploadsIn(await mockLog(page)).length;
  await page.locator('input[type=file][multiple]').first().setInputFiles(uploadFiles.batch);
  const sent = uploadsIn(await settleUploads(page, before + UPLOAD_BATCH.length - 1)).slice(before);

  const problems: string[] = [];
  const statuses = (name: string) => sent.filter((e) => e.filename === name).map((e) => e.status);
  for (const name of SUCCEEDING) {
    const s = statuses(name);
    if (s.length !== 1 || s[0] !== 201) problems.push(`${name}: expected one successful upload, got [${s.join(', ')}]`);
  }
  const transient = statuses(TRANSIENT_FAILURE_FILENAME);
  if (transient.length !== 1 || transient[0] !== 503) problems.push(`${TRANSIENT_FAILURE_FILENAME}: expected one failed attempt, got [${transient.join(', ')}]`);
  const oversized = statuses(OVERSIZED_FILENAME);
  if (oversized.length > 1 || oversized.some((s) => s !== 413)) problems.push(`${OVERSIZED_FILENAME}: expected at most one rejected attempt, got [${oversized.join(', ')}]`);
  const unexpected = sent.filter((e) => !BATCH_NAMES.includes(e.filename ?? ''));
  if (unexpected.length) problems.push(`unexpected uploads: ${unexpected.map((e) => e.filename).join(', ')}`);
  expect(problems, 'the initial batch upload').toEqual([]);

  for (const filename of [TRANSIENT_FAILURE_FILENAME, OVERSIZED_FILENAME]) {
    await expect.poll(() => markScope(page, filename), { message: `no failed item with controls for ${filename}` }).not.toBeNull();
  }
  await expect.poll(async () => (await statusTexts(page)).length, { message: 'the upload result is shown in a status region' }).toBeGreaterThan(0);
}

/**
 * Marks the smallest element that contains the filename and at least one
 * visible control (button or link): the failed upload's item.
 */
async function markScope(page: Page, filename: string): Promise<string | null> {
  return page.evaluate(
    ([name, controlSelector]) => {
      const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
      const starts: Element[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.includes(name) && node.parentElement && visible(node.parentElement)) starts.push(node.parentElement);
      }
      for (const el of document.querySelectorAll('[aria-label]')) {
        if (el.getAttribute('aria-label')?.includes(name) && visible(el)) starts.push(el);
      }
      let best: Element | null = null;
      let bestSize = Number.POSITIVE_INFINITY;
      for (const start of starts) {
        for (let el: Element | null = start; el && el !== document.body; el = el.parentElement) {
          if (el.matches(controlSelector)) continue;
          if ([...el.querySelectorAll(controlSelector)].some(visible)) {
            const size = el.querySelectorAll('*').length;
            if (size < bestSize) {
              best = el;
              bestSize = size;
            }
            break;
          }
        }
      }
      if (!best) return null;
      const token = `scope-${Math.random().toString(36).slice(2)}`;
      best.setAttribute('data-eval-scope', token);
      return token;
    },
    [filename, CONTROL] as const,
  );
}

export async function failedItem(page: Page, filename: string): Promise<Locator> {
  const token = await markScope(page, filename);
  if (!token) throw new Error(`no failed item with controls for ${filename}`);
  return page.locator(`[data-eval-scope="${token}"]`);
}

export function controlsIn(scope: Locator): Locator {
  return scope.locator(CONTROL).filter({ visible: true });
}

function menuItem(page: Page, index: number): Locator {
  return page.getByRole('menuitem').filter({ visible: true }).nth(index);
}

async function labelOf(control: Locator): Promise<string> {
  return (await control.innerText().catch(() => '')).trim() || ((await control.getAttribute('aria-label')) ?? '').trim();
}

/**
 * Looks at the screen afresh, so a re-rendered copy of the failed item is
 * still caught. Returns why the failure is still shown, or null.
 *
 * - Some element still has exactly the failed item's text.
 * - Some item containing the filename (and no other batch file) still offers
 *   the control that was used.
 */
async function failureStillShown(page: Page, filename: string, itemText: string, usedLabel: string | null): Promise<string | null> {
  return page.evaluate(
    ([name, before, label, others, controlSelector]) => {
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
      const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
      const target = norm(before);
      for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
        if (visible(el) && norm(el.innerText ?? '') === target) return 'the failed item is still on screen';
      }
      if (!label) return null;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.includes(name) || !node.parentElement) continue;
        for (let el: HTMLElement | null = node.parentElement; el && el !== document.body; el = el.parentElement) {
          if (others.some((o) => el.innerText.includes(o))) break;
          const controls = [...el.querySelectorAll<HTMLElement>(controlSelector)].filter(visible);
          if (controls.length === 0) continue;
          const offered = controls.some((c) => norm(c.innerText) === label || norm(c.getAttribute('aria-label') ?? '') === label);
          if (offered) return `"${label}" is still offered for ${name}`;
          break;
        }
      }
      return null;
    },
    [filename, itemText, usedLabel, BATCH_NAMES.filter((n) => n !== filename && !n.includes(filename)), CONTROL] as const,
  );
}

/** A recovery path: a control, or a control that opens a menu plus one of its items. */
type Path = [control: number] | [control: number, menuItem: number];
type Via = 'mouse' | 'keyboard';

async function recoveryPaths(page: Page, filename: string, options: OpenOptions): Promise<Path[]> {
  await openLibrary(page, 'default', options);
  await uploadBatch(page);
  const controls = controlsIn(await failedItem(page, filename));
  const paths: Path[] = [];
  const count = await controls.count();
  for (let i = 0; i < count; i++) {
    const popup = await controls.nth(i).getAttribute('aria-haspopup');
    if (popup === 'menu' || popup === 'true') {
      await controls.nth(i).click();
      const items = await page.getByRole('menuitem').filter({ visible: true }).count();
      for (let j = 0; j < items; j++) paths.push([i, j]);
      await page.keyboard.press('Escape');
    } else {
      paths.push([i]);
    }
  }
  return paths;
}

/** Tabs through the page until the target has focus. */
async function tabTo(page: Page, target: Locator): Promise<boolean> {
  await target.evaluate((el) => el.setAttribute('data-eval-target', ''));
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < 600; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => document.activeElement?.hasAttribute('data-eval-target') ?? false)) return true;
  }
  return false;
}

/** Arrows through an open menu until the target item has focus. */
async function arrowTo(page: Page, item: Locator): Promise<boolean> {
  await item.evaluate((el) => el.setAttribute('data-eval-target-item', ''));
  for (let i = 0; i < 20; i++) {
    if (await page.evaluate(() => document.activeElement?.hasAttribute('data-eval-target-item') ?? false)) return true;
    await page.keyboard.press('ArrowDown');
  }
  return false;
}

interface Attempt {
  label: string;
  via: Via;
  reachedByKeyboard: boolean;
  uploads: LogEntry[];
  chooserOpened: boolean;
  /** After a successful upload: null if the failure cleared from the screen, otherwise why not. */
  notCleared: string | null;
}

/**
 * After a successful recovery request, the screen must stop reporting the
 * failure (checked afresh, by filename) and the upload result must change:
 * some status text shown before, other than a message about this file
 * alone, is gone. A new message added next to an unchanged result doesn't
 * count.
 */
async function waitUntilCleared(
  page: Page,
  filename: string,
  itemText: string,
  statusBefore: string[],
  usedLabel: string | null,
): Promise<string | null> {
  const results = statusBefore.filter((t) => !t.includes(filename));
  const watched = results.length ? results : statusBefore;
  let reason = '';
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const still = await failureStillShown(page, filename, itemText, usedLabel);
    const after = await statusTexts(page);
    const resultChanged = watched.some((t) => !after.includes(t));
    if (!still && resultChanged) return null;
    reason = [still, !resultChanged && `the upload result still reads "${watched.join(' / ')}"`].filter(Boolean).join(' and ');
    await page.waitForTimeout(200);
  }
  return reason;
}

/** Fresh session, upload the batch, activate one recovery path, and record what happened. */
async function attempt(
  page: Page,
  filename: string,
  path: Path,
  via: Via,
  replacement: string | null,
  options: OpenOptions,
): Promise<Attempt> {
  await openLibrary(page, 'default', options);
  await uploadBatch(page);
  const scope = await failedItem(page, filename);
  const control = controlsIn(scope).nth(path[0]);
  const controlLabel = await labelOf(control);
  let label = controlLabel;
  const itemText = await scope.innerText();
  const statusBefore = await statusTexts(page);
  const before = uploadsIn(await mockLog(page)).length;
  const notReached: Attempt = { label, via, reachedByKeyboard: false, uploads: [], chooserOpened: false, notCleared: null };

  let chooser: Promise<FileChooser | null>;
  if (via === 'mouse') {
    if (path.length === 2) {
      await control.click();
      const item = menuItem(page, path[1]);
      label += ` > ${await labelOf(item)}`;
      chooser = page.waitForEvent('filechooser', { timeout: 2_000 }).catch(() => null);
      await item.click();
    } else {
      chooser = page.waitForEvent('filechooser', { timeout: 2_000 }).catch(() => null);
      await control.click();
    }
  } else {
    if (!(await tabTo(page, control))) return notReached;
    if (path.length === 2) {
      await page.keyboard.press('Enter');
      const item = menuItem(page, path[1]);
      label += ` > ${await labelOf(item)}`;
      if (!(await arrowTo(page, item))) return { ...notReached, label };
    }
    chooser = page.waitForEvent('filechooser', { timeout: 2_000 }).catch(() => null);
    await page.keyboard.press('Enter');
  }

  const opened = await chooser;
  if (opened && replacement) await opened.setFiles(replacement);
  const uploads = uploadsIn(await settleUploads(page, before)).slice(before);
  const succeeded = uploads.some((u) => u.status === 201);
  const notCleared = succeeded
    ? await waitUntilCleared(page, filename, itemText, statusBefore, path.length === 1 ? controlLabel : null)
    : null;
  return { label, via, reachedByKeyboard: true, uploads, chooserOpened: opened !== null, notCleared };
}

const describeAttempt = (a: Attempt) => `control "${a.label}" (${a.via})`;

interface Verdict {
  recovered: boolean;
  problems: string[];
}

function judgeTransient(a: Attempt): Verdict {
  const problems: string[] = [];
  const others = a.uploads.filter((u) => u.filename !== TRANSIENT_FAILURE_FILENAME);
  const mine = a.uploads.filter((u) => u.filename === TRANSIENT_FAILURE_FILENAME);
  if (others.length) problems.push(`${describeAttempt(a)} also sent ${others.map((u) => u.filename).join(', ')}`);
  if (mine.length > 1) problems.push(`${describeAttempt(a)} sent ${TRANSIENT_FAILURE_FILENAME} ${mine.length} times`);
  const sent = mine.length === 1 && mine[0]?.status === 201 && others.length === 0;
  if (sent && a.notCleared) problems.push(`${describeAttempt(a)} uploaded the file, but ${a.notCleared}`);
  return { recovered: sent && !a.notCleared, problems };
}

function judgeOversized(a: Attempt): Verdict {
  const problems: string[] = [];
  const resent = a.uploads.filter((u) => u.filename === OVERSIZED_FILENAME);
  const replacement = a.uploads.filter((u) => u.filename === REPLACEMENT_FILE.filename);
  const others = a.uploads.filter((u) => u.filename !== OVERSIZED_FILENAME && u.filename !== REPLACEMENT_FILE.filename);
  if (resent.length) problems.push(`${describeAttempt(a)} resent ${OVERSIZED_FILENAME}, which is over the limit and can never succeed`);
  if (others.length) problems.push(`${describeAttempt(a)} also sent ${others.map((u) => u.filename).join(', ')}`);
  const replaced =
    a.chooserOpened &&
    replacement.length === 1 &&
    replacement[0]?.status === 201 &&
    replacement[0].sizeBytes === REPLACEMENT_FILE.sizeBytes &&
    resent.length === 0 &&
    others.length === 0;
  if (replaced && a.notCleared) problems.push(`${describeAttempt(a)} uploaded the replacement, but ${a.notCleared}`);
  return { recovered: replaced && !a.notCleared, problems };
}

/**
 * Tries every recovery path with the mouse, then requires at least one path
 * that recovers to also work from the keyboard (Tab to reach, Enter to use).
 */
async function checkRecovery(
  page: Page,
  filename: string,
  replacement: string | null,
  judge: (a: Attempt) => Verdict,
  goal: string,
  options: OpenOptions,
): Promise<void> {
  const problems: string[] = [];
  const working: Path[] = [];
  for (const path of await recoveryPaths(page, filename, options)) {
    const verdict = judge(await attempt(page, filename, path, 'mouse', replacement, options));
    problems.push(...verdict.problems);
    if (verdict.recovered) working.push(path);
  }
  expect(problems, `recovery controls for ${filename} misbehaved`).toEqual([]);
  expect(working.length, `no control in ${filename}'s item ${goal}`).toBeGreaterThan(0);

  const keyboardProblems: string[] = [];
  for (const path of working) {
    const a = await attempt(page, filename, path, 'keyboard', replacement, options);
    if (!a.reachedByKeyboard) {
      keyboardProblems.push(`${describeAttempt(a)} can't be reached with Tab`);
      continue;
    }
    const verdict = judge(a);
    if (verdict.recovered) return;
    keyboardProblems.push(...verdict.problems, `${describeAttempt(a)} did not recover the file`);
  }
  expect(keyboardProblems, `no working recovery for ${filename} works from the keyboard`).toEqual([]);
}

/**
 * Transient failure: some control in campaign-header.png's item resends only
 * that file, and the screen then stops reporting the failure. No control in
 * the item resends any other file.
 */
export function checkTransientRecovery(page: Page, options: OpenOptions = {}): Promise<void> {
  return checkRecovery(page, TRANSIENT_FAILURE_FILENAME, null, judgeTransient, 'resent only that file and cleared the failure', options);
}

/**
 * Validation failure: no control in the oversized file's item resends it
 * (that can never succeed), and some control lets the person choose a valid
 * replacement, which uploads and clears the failure.
 */
export function checkOversizedRecovery(page: Page, options: OpenOptions = {}): Promise<void> {
  return checkRecovery(page, OVERSIZED_FILENAME, uploadFiles.replacement, judgeOversized, 'uploaded a valid replacement and cleared the failure', options);
}

/** Starting from whatever renders first, every default asset can be reached by loading more. */
export async function checkAllAssetsReachable(page: Page, options: OpenOptions = {}): Promise<void> {
  await openLibrary(page, 'default', options);
  await waitForItems(page, DEFAULT_NAMES);
  const seen = new Set<string>();
  for (let i = 0; i < DEFAULT_NAMES.length; i++) {
    for (const name of await visibleItems(page, DEFAULT_NAMES)) seen.add(name);
    if (seen.size === DEFAULT_NAMES.length || !(await loadMore(page, DEFAULT_NAMES))) break;
  }
  expect(DEFAULT_NAMES.filter((n) => !seen.has(n)), 'assets never shown').toEqual([]);
}

const LARGE_SCAN = assetsFor('large')
  .slice(0, 2_000)
  .map((a) => a.filename);

/** The large library renders, doesn't fetch everything up front, and reaches a later page. */
export async function checkLargeLibrary(page: Page, options: OpenOptions = {}): Promise<void> {
  await openLibrary(page, 'large', options);
  await expect.poll(async () => (await visibleItems(page, LARGE_SCAN)).length, { timeout: 5_000, message: 'assets render' }).toBeGreaterThan(0);
  const requested = (await mockLog(page))
    .filter((e) => e.path === '/api/assets')
    .reduce((sum, e) => sum + Math.min(Number(e.query['limit'] ?? 50), 200), 0);
  expect(requested, 'assets requested up front').toBeLessThanOrEqual(1_000);

  const furthest = async () => Math.max(-1, ...(await visibleItems(page, LARGE_SCAN)).map((n) => LARGE_SCAN.indexOf(n)));
  const before = await furthest();
  expect(await loadMore(page, LARGE_SCAN), 'scrolling to the end, or a "more" or "next" control, shows more assets').toBe(true);
  await expect.poll(furthest, { message: 'assets from a later page appear' }).toBeGreaterThan(before);
}

/** A search finds matching assets that aren't on the first page, and only those. */
export async function checkSearchFinds(page: Page, options: OpenOptions = {}): Promise<void> {
  await openLibrary(page, 'default', options);
  await waitForItems(page, DEFAULT_NAMES);
  await searchField(page).fill('invoice');
  const expected = DEFAULT_NAMES.filter((n) => n.includes('invoice'));
  await expect.poll(() => visibleItems(page, DEFAULT_NAMES), { message: 'items shown for "invoice"' }).toEqual(expected);
}

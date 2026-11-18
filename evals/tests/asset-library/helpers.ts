// Helpers for the asset-library behavior tests. They rely only on the
// brief's testability requirements: roles, filenames and outcomes in the mock
// API's request log. Never on wording, layout or a particular design.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type FileChooser, type Locator, type Page } from '@playwright/test';
import {
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

export const ITEM = 'tr, li, [role=row], [role=listitem], [role=option]';
const CONTROL = 'button, a[href], [role=button], [role=link]';
const STATUS = '[role=status], [role=alert], [aria-live]:not([aria-live="off"]), output';

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

function assetRequests(entries: LogEntry[]): LogEntry[] {
  return entries.filter((e) => e.path === '/api/assets');
}

/** The list item for an asset: a row, list item or option containing the full filename. */
export function libraryItem(page: Page, filename: string): Locator {
  const byText = page.locator(ITEM).filter({ hasText: filename });
  const byLabel = page.locator(ITEM).and(page.locator(`[aria-label*=${JSON.stringify(filename)}]`));
  return byText.or(byLabel).last();
}

/** Filenames from the given list that currently appear in rendered items, in list order. */
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

/**
 * Loads the next page the way the brief allows: scroll the list to its end,
 * or use a button or link named "more" or "next". True if a later page was
 * requested.
 */
export async function loadMore(page: Page): Promise<boolean> {
  const before = assetRequests(await mockLog(page)).length;
  const laterPageRequested = async (timeout: number): Promise<boolean> => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const requests = assetRequests(await mockLog(page)).slice(before);
      if (requests.some((e) => Number(e.query['offset'] ?? 0) > 0)) {
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(200);
        return true;
      }
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
  if (await laterPageRequested(1_500)) return true;

  const control = page
    .getByRole('button', { name: /more|next/i })
    .or(page.getByRole('link', { name: /more|next/i }))
    .filter({ visible: true })
    .first();
  if ((await control.count()) === 0) return false;
  await control.click({ timeout: 10_000 });
  return laterPageRequested(5_000);
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

/** Text of every visible status or live region, outermost regions only. */
export async function statusText(page: Page): Promise<string> {
  return page.evaluate((selector) => {
    const regions = [...document.querySelectorAll<HTMLElement>(selector)].filter(
      (el) => el.getClientRects().length > 0 && !el.parentElement?.closest(selector),
    );
    return regions.map((el) => el.innerText.trim()).join('\n').trim();
  }, STATUS);
}

/** Waits until the request log stops growing, with at least `min` uploads. */
export async function settleUploads(page: Page, min: number): Promise<LogEntry[]> {
  let previous = -1;
  let stableSince = Date.now();
  const deadline = Date.now() + 60_000;
  for (;;) {
    const entries = await mockLog(page);
    const count = uploadsIn(entries).length;
    if (count !== previous) {
      previous = count;
      stableSince = Date.now();
    } else if (count >= min && Date.now() - stableSince >= 750) {
      return entries;
    }
    if (Date.now() > deadline) throw new Error(`uploads did not settle: ${count} of at least ${min}`);
    await page.waitForTimeout(150);
  }
}

const SUCCEEDING = UPLOAD_BATCH.map((f) => f.filename).filter((n) => n !== TRANSIENT_FAILURE_FILENAME && n !== OVERSIZED_FILENAME);

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
  const unexpected = sent.filter((e) => !UPLOAD_BATCH.some((f) => f.filename === e.filename));
  if (unexpected.length) problems.push(`unexpected uploads: ${unexpected.map((e) => e.filename).join(', ')}`);
  expect(problems, 'the initial batch upload').toEqual([]);

  for (const filename of [TRANSIENT_FAILURE_FILENAME, OVERSIZED_FILENAME]) {
    await expect.poll(() => markScope(page, filename), { message: `no failed item with controls for ${filename}` }).not.toBeNull();
  }
  await expect.poll(() => statusText(page), { message: 'the upload result is shown in a status region' }).not.toBe('');
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
 * failure: the failed item disappears, or its text changes and it no longer
 * offers the control that was used. The status region must update too.
 */
async function waitUntilCleared(page: Page, scope: Locator, textBefore: string, statusBefore: string, label: string | null): Promise<string | null> {
  let reason = '';
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const statusChanged = (await statusText(page)) !== statusBefore;
    let itemCleared = !(await scope.isVisible().catch(() => false));
    if (!itemCleared) {
      const text = await scope.innerText().catch(() => textBefore);
      const stillOffered = label !== null && label !== '' && (await controlsIn(scope).filter({ hasText: label }).count()) > 0;
      itemCleared = text !== textBefore && !stillOffered;
    }
    if (itemCleared && statusChanged) return null;
    reason = [!itemCleared && 'the failed item still shows the failure', !statusChanged && 'the status region did not change']
      .filter(Boolean)
      .join(' and ');
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
  const textBefore = await scope.innerText();
  const statusBefore = await statusText(page);
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
    ? await waitUntilCleared(page, scope, textBefore, statusBefore, path.length === 1 ? controlLabel : null)
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

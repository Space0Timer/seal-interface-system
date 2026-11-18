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
  type Asset,
  type Scenario,
} from '../../fixtures/src/data.ts';
import { writeUploadFiles } from '../../fixtures/src/files.ts';
import type { LogEntry } from '../../fixtures/src/mock-api.ts';

export const uploadFiles = writeUploadFiles(join(tmpdir(), 'ds-eval-upload-files'));
export const DEFAULT_NAMES = DEFAULT_ASSETS.map((a) => a.filename);

export const ITEM = 'tr, li, [role=row], [role=listitem], [role=option]';
const CONTROL = 'button, a[href], [role=button], [role=link]';
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

/**
 * The list item for an asset: a row, option or list item whose computed
 * accessible name contains the full filename, or whose text does.
 */
export function libraryItem(page: Page, filename: string): Locator {
  const byName = page
    .getByRole('row', { name: filename })
    .or(page.getByRole('option', { name: filename }))
    .or(page.getByRole('listitem', { name: filename }));
  const byText = page.locator(ITEM).filter({ hasText: filename });
  return byName.or(byText).last();
}

/** For each filename, the other filenames that contain it (a.png is inside …-cta.png). */
const containersCache = new WeakMap<readonly string[], string[][]>();
function containersOf(filenames: readonly string[]): string[][] {
  let cached = containersCache.get(filenames);
  if (!cached) {
    cached = filenames.map((name) => filenames.filter((other) => other !== name && other.includes(name)));
    containersCache.set(filenames, cached);
  }
  return cached;
}

/**
 * Filenames from the given list that currently appear, in full, in rendered
 * items. In list order. An item's text includes its accessible-name sources:
 * text content, and aria-labelledby, aria-label and title on the item or its
 * descendants. A filename that only appears inside a longer filename
 * doesn't count.
 */
export async function visibleItems(page: Page, filenames: readonly string[]): Promise<string[]> {
  return page.evaluate(
    ([selector, names, containers]) => {
      const nameSources = (el: Element): string => {
        const parts = [el.textContent ?? ''];
        for (const node of [el, ...el.querySelectorAll('[aria-label], [aria-labelledby], [title]')]) {
          for (const attr of ['aria-label', 'title']) {
            const value = node.getAttribute(attr);
            if (value) parts.push(value);
          }
          for (const id of (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)) {
            parts.push(document.getElementById(id)?.textContent ?? '');
          }
        }
        return parts.join('\n');
      };
      const items = [...document.querySelectorAll<HTMLElement>(selector)].filter((el) => el.getClientRects().length > 0);
      const texts = items.map(nameSources);
      return names.filter((name, i) =>
        texts.some((text) => {
          let rest = text;
          for (const longer of containers[i] ?? []) rest = rest.split(longer).join('\n');
          return rest.includes(name);
        }),
      );
    },
    [ITEM, filenames, containersOf(filenames)] as const,
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

  // The pagination control (brief requirement 8): outside the asset items,
  // not a menu trigger, named "more" or "next". Row actions such as
  // "More actions" are skipped.
  const candidates = page
    .getByRole('button', { name: /more|next/i })
    .or(page.getByRole('link', { name: /more|next/i }))
    .filter({ visible: true });
  const index = await candidates.evaluateAll(
    (els, itemSelector) =>
      els.findIndex((el) => {
        const popup = el.getAttribute('aria-haspopup');
        return !el.closest(itemSelector) && (popup === null || popup === 'false');
      }),
    ITEM,
  );
  if (index < 0) return false;
  await candidates.nth(index).click({ timeout: 10_000 });
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

export interface TouchTarget {
  label: string;
  tag: string;
  width: number;
  height: number;
  meetsMinimum: boolean;
}

/** The touch-target minimum from Apple's HIG and the design system's size.target.touch. */
export const TOUCH_TARGET_MIN = 44;

/**
 * Measures every visible interactive element's clickable area in CSS
 * pixels. A form control's associated <label> counts toward its area.
 * Design-fit evidence (P6), recorded rather than asserted.
 */
export async function measureTouchTargets(page: Page): Promise<TouchTarget[]> {
  return page.evaluate((min) => {
    const selector = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [role=menuitem], [tabindex]:not([tabindex="-1"])';
    const targets: TouchTarget[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (el.getClientRects().length === 0) continue;
      const rects = [el.getBoundingClientRect()];
      for (const label of (el as HTMLInputElement).labels ?? []) rects.push(label.getBoundingClientRect());
      const visible = rects.filter((r) => r.width > 0 && r.height > 0);
      if (visible.length === 0) continue;
      const left = Math.min(...visible.map((r) => r.left));
      const right = Math.max(...visible.map((r) => r.right));
      const top = Math.min(...visible.map((r) => r.top));
      const bottom = Math.max(...visible.map((r) => r.bottom));
      const width = Math.round((right - left) * 10) / 10;
      const height = Math.round((bottom - top) * 10) / 10;
      const label = (el.getAttribute('aria-label') ?? el.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      targets.push({ label, tag: el.tagName.toLowerCase(), width, height, meetsMinimum: width >= min && height >= min });
    }
    return targets;
  }, TOUCH_TARGET_MIN);
}

/** The upload result: a status region whose accessible name contains "upload" (brief requirement 7). */
export function uploadSummary(page: Page): Locator {
  return page.getByRole('status', { name: /upload/i }).filter({ visible: true }).first();
}

/** The upload summary's text, normalized, or null if it isn't on screen. */
async function summaryText(page: Page): Promise<string | null> {
  const summary = uploadSummary(page);
  if ((await summary.count()) === 0) return null;
  return (await summary.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
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
export const UPLOAD_SIZES = new Map(UPLOAD_BATCH.map((f) => [f.filename, f.sizeBytes]));

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

  // Every request must carry the file's real bytes, so sizes are checked too.
  const problems: string[] = [];
  const sentFor = (name: string) => sent.filter((e) => e.filename === name);
  const show = (es: LogEntry[]) => `[${es.map((e) => `${e.status} with ${e.sizeBytes ?? '?'} bytes`).join(', ')}]`;
  const fullSize = (name: string, es: LogEntry[]) => es.every((e) => e.sizeBytes === UPLOAD_SIZES.get(name));
  for (const name of SUCCEEDING) {
    const es = sentFor(name);
    if (es.length !== 1 || es[0]?.status !== 201 || !fullSize(name, es)) {
      problems.push(`${name}: expected one successful upload of ${UPLOAD_SIZES.get(name)} bytes, got ${show(es)}`);
    }
  }
  const transient = sentFor(TRANSIENT_FAILURE_FILENAME);
  if (transient.length !== 1 || transient[0]?.status !== 503 || !fullSize(TRANSIENT_FAILURE_FILENAME, transient)) {
    problems.push(`${TRANSIENT_FAILURE_FILENAME}: expected one failed attempt of ${UPLOAD_SIZES.get(TRANSIENT_FAILURE_FILENAME)} bytes, got ${show(transient)}`);
  }
  const oversized = sentFor(OVERSIZED_FILENAME);
  if (oversized.length > 1 || oversized.some((e) => e.status !== 413) || !fullSize(OVERSIZED_FILENAME, oversized)) {
    problems.push(`${OVERSIZED_FILENAME}: expected at most one rejected attempt of ${UPLOAD_SIZES.get(OVERSIZED_FILENAME)} bytes, got ${show(oversized)}`);
  }
  const unexpected = sent.filter((e) => !BATCH_NAMES.includes(e.filename ?? ''));
  if (unexpected.length) problems.push(`unexpected uploads: ${unexpected.map((e) => e.filename).join(', ')}`);
  expect(problems, 'the initial batch upload').toEqual([]);

  for (const filename of [TRANSIENT_FAILURE_FILENAME, OVERSIZED_FILENAME]) {
    await expect.poll(() => markScope(page, filename), { message: `no failed item with controls for ${filename}` }).not.toBeNull();
  }
  await expect
    .poll(() => summaryText(page), { message: 'the upload result is in a status region named "upload…" (brief requirement 7)' })
    .toBeTruthy();
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
 * failure (checked afresh, by filename). The upload summary itself (the
 * status region named "upload…") must still be on screen, because the other
 * failure remains, and must read differently. Other live regions changing,
 * such as an asset count, don't count.
 */
async function waitUntilCleared(
  page: Page,
  filename: string,
  itemText: string,
  summaryBefore: string | null,
  usedLabel: string | null,
): Promise<string | null> {
  let reason = '';
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const still = await failureStillShown(page, filename, itemText, usedLabel);
    // The other failure is still on screen, so the summary must be too.
    const summary = await summaryText(page);
    const summaryProblem =
      summary === null || summary === ''
        ? 'the upload summary is gone although a failure remains'
        : summary === summaryBefore
          ? `the upload summary still reads "${summaryBefore}"`
          : null;
    if (!still && !summaryProblem) return null;
    reason = [still, summaryProblem].filter(Boolean).join(' and ');
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
  const summaryBefore = await summaryText(page);
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
    ? await waitUntilCleared(page, filename, itemText, summaryBefore, path.length === 1 ? controlLabel : null)
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
  const expectedBytes = UPLOAD_SIZES.get(TRANSIENT_FAILURE_FILENAME);
  const wrongSize = mine.filter((u) => u.sizeBytes !== expectedBytes);
  if (wrongSize.length) problems.push(`${describeAttempt(a)} sent ${wrongSize[0]?.sizeBytes} bytes instead of ${expectedBytes}`);
  const sent = mine.length === 1 && mine[0]?.status === 201 && others.length === 0 && wrongSize.length === 0;
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

/** How long after the first assets render that requests still count as up-front loading. */
const STARTUP_WINDOW_MS = 3_000;

/**
 * The large library renders, doesn't fetch everything up front (including
 * in the background after the first rows appear), and reaches a later page.
 */
export async function checkLargeLibrary(page: Page, options: OpenOptions = {}): Promise<void> {
  await openLibrary(page, 'large', options);
  await expect.poll(async () => (await visibleItems(page, LARGE_SCAN)).length, { timeout: 5_000, message: 'assets render' }).toBeGreaterThan(0);
  // Watch the whole startup window before any interaction, so background
  // fetching that starts after the first render is counted too.
  await page.waitForTimeout(STARTUP_WINDOW_MS);
  const requested = (await mockLog(page))
    .filter((e) => e.path === '/api/assets')
    .reduce((sum, e) => sum + Math.min(Number(e.query['limit'] ?? 50), 200), 0);
  expect(requested, `assets requested up front (within ${STARTUP_WINDOW_MS / 1000} s of the first render)`).toBeLessThanOrEqual(1_000);

  const furthest = async () => Math.max(-1, ...(await visibleItems(page, LARGE_SCAN)).map((n) => LARGE_SCAN.indexOf(n)));
  const before = await furthest();
  expect(await loadMore(page, LARGE_SCAN), 'scrolling to the end, or a "more" or "next" control, shows more assets').toBe(true);
  await expect.poll(furthest, { message: 'assets from a later page appear' }).toBeGreaterThan(before);
}

/**
 * Searching "invoice" finds both invoices, which sit beyond any small first
 * page, following result pages if needed, and no page shows anything else.
 */
export async function checkSearchFinds(page: Page, options: OpenOptions = {}): Promise<void> {
  await openLibrary(page, 'default', options);
  await waitForItems(page, DEFAULT_NAMES);
  await searchField(page).fill('invoice');
  const expected = DEFAULT_NAMES.filter((n) => n.includes('invoice'));
  const onlyMatches = async () => {
    const shown = await visibleItems(page, DEFAULT_NAMES);
    return shown.length > 0 && shown.every((n) => expected.includes(n));
  };
  await expect.poll(onlyMatches, { message: 'items shown for "invoice"' }).toBe(true);

  const found = new Set<string>();
  for (let i = 0; i <= expected.length; i++) {
    const shown = await visibleItems(page, DEFAULT_NAMES);
    expect(shown.filter((n) => !expected.includes(n)), 'unrelated assets shown for "invoice"').toEqual([]);
    for (const name of shown) found.add(name);
    if (found.size === expected.length || !(await loadMore(page, DEFAULT_NAMES))) break;
  }
  expect([...found].sort(), 'matches found for "invoice"').toEqual([...expected].sort());
}

/**
 * Selects three assets, loading more pages if fewer are shown, then deletes
 * them together with one Delete or Remove control outside the items.
 */
export async function checkBulkDelete(page: Page, options: OpenOptions = {}): Promise<void> {
  await openLibrary(page, 'default', options);
  await waitForItems(page, DEFAULT_NAMES);
  const targets: Asset[] = [];
  for (let i = 0; i < 10 && targets.length < 3; i++) {
    const shown = await visibleItems(page, DEFAULT_NAMES);
    for (const asset of DEFAULT_ASSETS) {
      if (targets.length === 3) break;
      if (!shown.includes(asset.filename) || targets.includes(asset)) continue;
      const item = libraryItem(page, asset.filename);
      await selectItem(item);
      expect(await isSelected(item), `${asset.filename} reports selected`).toBe(true);
      targets.push(asset);
    }
    if (targets.length < 3 && !(await loadMore(page, DEFAULT_NAMES))) break;
  }
  expect(targets.map((a) => a.filename), 'three assets could be selected').toHaveLength(3);

  const outsideItems = page.locator('button, [role=button]').filter({ hasText: /delete|remove/i });
  const labelled = page.getByRole('button', { name: /delete|remove/i });
  const candidates = labelled.or(outsideItems).filter({ visible: true });
  const index = await candidates.evaluateAll((els, sel) => els.findIndex((el) => !el.closest(sel)), ITEM);
  expect(index, 'a visible Delete or Remove control outside the items').toBeGreaterThanOrEqual(0);
  await candidates.nth(index).click();

  const dialog = page.getByRole('dialog').or(page.getByRole('alertdialog')).filter({ visible: true });
  if (await dialog.count()) await dialog.getByRole('button', { name: /delete|remove/i }).first().click();

  await expect
    .poll(async () => (await mockLog(page)).find((e) => e.path === '/api/assets/delete')?.ids?.slice().sort(), {
      message: 'one delete request with the three selected assets',
    })
    .toEqual(targets.map((a) => a.id).sort());
  await expect.poll(() => visibleItems(page, targets.map((a) => a.filename))).toEqual([]);
}

// Helpers for the asset-library behavior tests. They rely only on the
// brief's testability requirements: roles, filenames and outcomes in the mock
// API's request log. Never on wording, layout or a particular design.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
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

const ITEM = 'tr, li, [role=row], [role=listitem], [role=option]';
const CONTROL = 'button, a[href], [role=button], [role=link]';

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

/** Filenames from the given list that currently appear as visible items. */
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

/** Uploads the 12-file batch and waits for both failures to show as items with controls. */
export async function uploadBatch(page: Page): Promise<void> {
  await page.locator('input[type=file][multiple]').first().setInputFiles(uploadFiles.batch);
  // 10 successes + the transient failure; the oversized file may be rejected in the browser.
  await settleUploads(page, UPLOAD_BATCH.length - 1);
  for (const filename of [TRANSIENT_FAILURE_FILENAME, OVERSIZED_FILENAME]) {
    await expect.poll(() => markScope(page, filename), { message: `no failed item with controls for ${filename}` }).not.toBeNull();
  }
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

/** A recovery path: a control, or a control that opens a menu plus one of its items. */
type Path = [control: number] | [control: number, menuItem: number];

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

interface Attempt {
  path: Path;
  label: string;
  uploads: LogEntry[];
  chooserOpened: boolean;
  controlGone: boolean;
}

/** Fresh session, upload the batch, activate one recovery path, and record what was sent. */
async function attempt(page: Page, filename: string, path: Path, replacement: string | null, options: OpenOptions): Promise<Attempt> {
  await openLibrary(page, 'default', options);
  await uploadBatch(page);
  const scope = await failedItem(page, filename);
  const before = uploadsIn(await mockLog(page)).length;
  const control = controlsIn(scope).nth(path[0]);
  let label = (await control.innerText().catch(() => '')).trim() || ((await control.getAttribute('aria-label')) ?? '');
  let target = control;
  if (path.length === 2) {
    await control.click();
    target = page.getByRole('menuitem').filter({ visible: true }).nth(path[1]);
    label += ` > ${(await target.innerText()).trim()}`;
  }
  const chooser = page.waitForEvent('filechooser', { timeout: 2_000 }).catch(() => null);
  await target.click();
  const opened = await chooser;
  if (opened && replacement) await opened.setFiles(replacement);
  const entries = await settleUploads(page, before);
  return {
    path,
    label,
    uploads: uploadsIn(entries).slice(before),
    chooserOpened: opened !== null,
    controlGone: !(await target.isVisible().catch(() => false)),
  };
}

const describe = (a: Attempt) => `control "${a.label}"`;

/**
 * Transient failure: some control in campaign-header.png's item resends only
 * that file, which then uploads and clears its failure. No control in the
 * item resends any other file.
 */
export async function checkTransientRecovery(page: Page, options: OpenOptions = {}): Promise<void> {
  const problems: string[] = [];
  let recovered = false;
  for (const path of await recoveryPaths(page, TRANSIENT_FAILURE_FILENAME, options)) {
    const a = await attempt(page, TRANSIENT_FAILURE_FILENAME, path, null, options);
    const others = a.uploads.filter((u) => u.filename !== TRANSIENT_FAILURE_FILENAME);
    const mine = a.uploads.filter((u) => u.filename === TRANSIENT_FAILURE_FILENAME);
    if (others.length) problems.push(`${describe(a)} also sent ${others.map((u) => u.filename).join(', ')}`);
    if (mine.length > 1) problems.push(`${describe(a)} sent ${TRANSIENT_FAILURE_FILENAME} ${mine.length} times`);
    if (mine.length === 1 && mine[0]?.status === 201 && !others.length) {
      if (a.controlGone) recovered = true;
      else problems.push(`${describe(a)} uploaded the file but its failure state did not clear`);
    }
  }
  expect(problems, 'recovery controls for the transient failure misbehaved').toEqual([]);
  expect(recovered, `no control in ${TRANSIENT_FAILURE_FILENAME}'s item resent only that file and cleared the failure`).toBe(true);
}

/**
 * Validation failure: no control in the oversized file's item resends it
 * (that can never succeed), and some control lets the person choose a valid
 * replacement, which then uploads.
 */
export async function checkOversizedRecovery(page: Page, options: OpenOptions = {}): Promise<void> {
  const problems: string[] = [];
  let replaced = false;
  for (const path of await recoveryPaths(page, OVERSIZED_FILENAME, options)) {
    const a = await attempt(page, OVERSIZED_FILENAME, path, uploadFiles.replacement, options);
    const resent = a.uploads.filter((u) => u.filename === OVERSIZED_FILENAME);
    const replacement = a.uploads.filter((u) => u.filename === REPLACEMENT_FILE.filename);
    const others = a.uploads.filter((u) => u.filename !== OVERSIZED_FILENAME && u.filename !== REPLACEMENT_FILE.filename);
    if (resent.length) problems.push(`${describe(a)} resent ${OVERSIZED_FILENAME}, which is over the limit and can never succeed`);
    if (others.length) problems.push(`${describe(a)} also sent ${others.map((u) => u.filename).join(', ')}`);
    if (a.chooserOpened && replacement.length === 1 && replacement[0]?.status === 201) {
      expect(replacement[0].sizeBytes).toBe(REPLACEMENT_FILE.sizeBytes);
      replaced = true;
    }
  }
  expect(problems, 'recovery controls for the oversized file misbehaved').toEqual([]);
  expect(replaced, `no control in ${OVERSIZED_FILENAME}'s item let the person upload a valid replacement`).toBe(true);
}

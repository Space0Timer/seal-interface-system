// Conformance app: an unstyled implementation of evals/briefs/asset-library.md
// written from the brief's functional contract alone. It proves the shared
// behavior tests can be passed without the design skill. It is NOT a design
// reference and is never given to generators.
//
// The page size defaults to 20, below the API default, so the tests must
// handle pagination. It also shows a live asset count, so the tests must
// tell the upload summary apart from other live regions.
//
// Valid variations, which the meta tests check the shared tests accept:
//   ?page=<n>        page size
//   ?prefetch=1      fetch the next page ahead; "Load more" reveals it with no request
//   ?labelledby=1    rows show a truncated filename; the full one comes from aria-labelledby
//
// Broken variants, which the meta tests check the shared tests reject:
//   ?variant=retry-everything      Retry for every failure, even oversized files
//   ?variant=stale-after-recovery  recovery uploads, but the screen doesn't change
//   ?variant=stale-rerender        recovery uploads, then re-renders the same failure
//                                  and adds a "Retry sent" message
//   ?variant=stale-summary         recovery clears the item, the asset count changes,
//                                  but the upload summary keeps its old text
//   ?variant=mouse-only-recovery   recovery controls can't be reached with Tab
//   ?variant=empty-search          any non-empty search shows nothing
//   ?variant=search-loaded-only    search filters only the pages already loaded
//   ?variant=fetch-all-later       renders the first page, then fetches all 10,000 in the background

interface Asset {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  updatedAt: string;
}

interface Upload {
  key: number;
  file: File;
  status: 'pending' | 'done' | 'failed';
  code?: string;
}

interface Page {
  total: number;
  items: Asset[];
}

const LIMIT_BYTES = 100 * 1024 * 1024;
const params = new URLSearchParams(location.search);
const PAGE = Number(params.get('page') ?? 20);
const prefetch = params.get('prefetch') === '1';
const labelledBy = params.get('labelledby') === '1';
const variant = params.get('variant');
const is = (name: string) => variant === name;

const state = {
  query: '',
  items: [] as Asset[],
  total: 0,
  /** Everything loaded without a query, for search-loaded-only. */
  loaded: [] as Asset[],
  /** A prefetched page, valid only for the query and offset it was fetched for. */
  buffer: null as { query: string; offset: number; items: Asset[] } | null,
  /** Increments on every fresh load, so responses for an older list are dropped. */
  generation: 0,
  selected: new Set<string>(),
  uploads: [] as Upload[],
  frozenSummary: null as string | null,
  nextKey: 1,
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) if (value !== undefined) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

// Static skeleton, built once so the search field keeps focus while typing.
const search = el('input', { type: 'search', 'aria-label': 'Search assets' });
const upload = el('input', { type: 'file', multiple: '', 'aria-label': 'Upload files' });
const uploadsRegion = el('section', { 'aria-label': 'Uploads' });
const selectionRegion = el('div');
const listRegion = el('div');
const fullNames = el('div', { hidden: '' });

document.body.append(
  el(
    'nav',
    { 'aria-label': 'Global' },
    el('a', { href: '/', 'aria-current': 'page' }, 'Assets'),
    ' ',
    el('a', { href: '#' }, 'Projects'),
    ' ',
    el('a', { href: '#' }, 'Settings'),
  ),
  el('main', {}, el('h1', {}, 'Assets'), search, ' ', upload, uploadsRegion, selectionRegion, listRegion, fullNames),
);

async function fetchPage(query: string, offset: number, limit = PAGE): Promise<Page> {
  const q = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (query) q.set('q', query);
  const res = await fetch(`/api/assets?${q}`);
  return (await res.json()) as Page;
}

async function load(append = false): Promise<void> {
  const query = state.query;
  if (query && (is('empty-search') || is('search-loaded-only'))) {
    const q = query.toLowerCase();
    state.items = is('empty-search') ? [] : state.loaded.filter((a) => a.filename.toLowerCase().includes(q));
    state.total = state.items.length;
    renderList();
    return;
  }

  if (!append) {
    state.generation++;
    state.buffer = null;
  }
  const generation = state.generation;
  const offset = append ? state.items.length : 0;
  const buffered = state.buffer?.query === query && state.buffer.offset === offset ? state.buffer.items : null;
  state.buffer = null;
  const page = buffered ? { total: state.total, items: buffered } : await fetchPage(query, offset);
  if (generation !== state.generation || state.query !== query) return;

  state.items = append ? [...state.items, ...page.items] : page.items;
  state.total = page.total;
  if (!query) state.loaded = state.items;
  renderList();

  const next = state.items.length;
  if (prefetch && next < state.total) {
    const items = (await fetchPage(query, next)).items;
    if (generation === state.generation && state.query === query && state.items.length === next) {
      state.buffer = { query, offset: next, items };
    }
  }
  if (is('fetch-all-later') && !append && !query) {
    window.setTimeout(async () => {
      for (let o = 0; o < state.total; o += 200) await fetchPage('', o, 200);
    }, 300);
  }
}

function filenameCell(asset: Asset): HTMLElement {
  if (!labelledBy) return el('td', {}, asset.filename);
  // Truncated in the DOM; the full name is only in the accessible name.
  return el('td', {}, asset.filename.length > 14 ? `${asset.filename.slice(0, 12)}…` : asset.filename);
}

function renderList(): void {
  const count = el('p', { role: 'status' }, `${state.total} assets`);
  if (state.items.length === 0) {
    listRegion.replaceChildren(count, el('p', {}, state.query ? `No results for "${state.query}".` : 'No assets.'));
    return;
  }
  if (labelledBy) fullNames.replaceChildren(...state.items.map((a) => el('span', { id: `name-${a.id}` }, a.filename)));
  const rows = state.items.map((asset) => {
    const name = labelledBy ? { 'aria-labelledby': `name-${asset.id}` } : { 'aria-label': `Select ${asset.filename}` };
    const box = el('input', { type: 'checkbox', ...name });
    box.checked = state.selected.has(asset.id);
    box.addEventListener('change', () => {
      if (box.checked) state.selected.add(asset.id);
      else state.selected.delete(asset.id);
      renderSelection();
    });
    return el(
      'tr',
      labelledBy ? { 'aria-labelledby': `name-${asset.id}` } : {},
      el('td', {}, box),
      filenameCell(asset),
      el('td', {}, asset.mimeType),
      el('td', {}, String(asset.sizeBytes)),
      el('td', {}, asset.updatedAt),
    );
  });
  const table = el(
    'table',
    { 'aria-label': 'Assets' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Select'), el('th', {}, 'Name'), el('th', {}, 'Type'), el('th', {}, 'Bytes'), el('th', {}, 'Updated'))),
    el('tbody', {}, ...rows),
  );
  const children: Node[] = [count, table];
  if (state.items.length < state.total) {
    const more = el('button', { type: 'button' }, 'Load more');
    more.addEventListener('click', () => void load(true));
    children.push(more);
  }
  listRegion.replaceChildren(...children);
}

function renderSelection(): void {
  if (state.selected.size === 0) {
    selectionRegion.replaceChildren();
    return;
  }
  const remove = el('button', { type: 'button' }, 'Delete selected');
  remove.addEventListener('click', async () => {
    await fetch('/api/assets/delete', { method: 'POST', body: JSON.stringify({ ids: [...state.selected] }) });
    state.selected.clear();
    renderSelection();
    await load();
  });
  selectionRegion.replaceChildren(el('p', {}, `${state.selected.size} selected `, remove));
}

async function send(entry: Upload): Promise<void> {
  entry.status = 'pending';
  delete entry.code;
  if (entry.file.size > LIMIT_BYTES && !is('retry-everything')) {
    entry.status = 'failed';
    entry.code = 'file_too_large';
    return;
  }
  const res = await fetch(`/api/uploads?filename=${encodeURIComponent(entry.file.name)}`, {
    method: 'POST',
    body: entry.file,
    headers: { 'Content-Type': entry.file.type || 'application/octet-stream' },
  });
  if (res.ok) {
    entry.status = 'done';
  } else {
    entry.status = 'failed';
    entry.code = ((await res.json()) as { error?: { code?: string } }).error?.code ?? 'unknown';
  }
}

function renderUploads(): void {
  if (state.uploads.length === 0) {
    uploadsRegion.replaceChildren();
    return;
  }
  const done = state.uploads.filter((u) => u.status === 'done').length;
  const failed = state.uploads.filter((u) => u.status === 'failed');
  const items = failed.map((entry) => {
    const actions: HTMLElement[] = [];
    const snapshot = { file: entry.file, code: entry.code };
    const recovered = async () => {
      if (is('stale-after-recovery')) return;
      if (is('stale-rerender')) {
        // The upload succeeded, but the screen re-creates the same failure.
        entry.file = snapshot.file;
        entry.status = 'failed';
        if (snapshot.code) entry.code = snapshot.code;
        renderUploads();
        uploadsRegion.append(el('p', { role: 'status' }, 'Retry sent'));
        return;
      }
      renderUploads();
      await load();
    };
    const keyboard = is('mouse-only-recovery') ? { tabindex: '-1' } : {};
    if (entry.code === 'file_too_large' && !is('retry-everything')) {
      const choose = el('button', { type: 'button', ...keyboard }, 'Choose another file');
      const picker = el('input', { type: 'file', hidden: '' });
      choose.addEventListener('click', () => picker.click());
      picker.addEventListener('change', async () => {
        const file = picker.files?.[0];
        if (!file) return;
        entry.file = file;
        await send(entry);
        await recovered();
      });
      actions.push(choose, picker);
    } else {
      const retry = el('button', { type: 'button', ...keyboard }, 'Retry');
      retry.addEventListener('click', async () => {
        await send(entry);
        await recovered();
      });
      actions.push(retry);
    }
    const dismiss = el('button', { type: 'button' }, 'Dismiss');
    dismiss.addEventListener('click', () => {
      state.uploads = state.uploads.filter((u) => u !== entry);
      renderUploads();
    });
    actions.push(dismiss);
    return el('li', {}, `${entry.file.name}: ${entry.code ?? ''} `, ...actions);
  });

  let summary = `${done} of ${state.uploads.length} uploaded`;
  if (is('stale-summary')) {
    // Freeze the first finished summary, so recovery never updates it.
    if (state.frozenSummary === null && !state.uploads.some((u) => u.status === 'pending')) state.frozenSummary = summary;
    summary = state.frozenSummary ?? summary;
  }
  uploadsRegion.replaceChildren(el('p', { role: 'status', 'aria-label': 'Upload results' }, summary), el('ul', {}, ...items));
}

upload.addEventListener('change', async () => {
  const files = [...(upload.files ?? [])];
  upload.value = '';
  const entries = files.map((file): Upload => ({ key: state.nextKey++, file, status: 'pending' }));
  state.uploads = entries;
  state.frozenSummary = null;
  renderUploads();
  await Promise.all(entries.map(send));
  renderUploads();
  await load();
});

let timer: number | undefined;
search.addEventListener('input', () => {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    state.query = search.value.trim();
    void load();
  }, 150);
});

void load();

// Conformance app: an unstyled implementation of evals/briefs/asset-library.md
// written from the brief's functional contract alone. It proves the shared
// behavior tests can be passed without the design skill. It is NOT a design
// reference and is never given to generators.
//
// The page size is 20, below the API default, so the tests must handle
// pagination.
//
// Broken variants, which the meta tests check the shared tests reject:
//   ?variant=retry-everything      Retry for every failure, even oversized files
//   ?variant=stale-after-recovery  recovery uploads, but the screen still shows the failure
//   ?variant=mouse-only-recovery   recovery controls can't be reached with Tab

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

const LIMIT_BYTES = 100 * 1024 * 1024;
const PAGE = 20;
const variant = new URLSearchParams(location.search).get('variant');
const retryEverything = variant === 'retry-everything';
const staleAfterRecovery = variant === 'stale-after-recovery';
const mouseOnlyRecovery = variant === 'mouse-only-recovery';

const state = {
  query: '',
  items: [] as Asset[],
  total: 0,
  selected: new Set<string>(),
  uploads: [] as Upload[],
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
  el('main', {}, el('h1', {}, 'Assets'), search, ' ', upload, uploadsRegion, selectionRegion, listRegion),
);

async function load(append = false): Promise<void> {
  const offset = append ? state.items.length : 0;
  const params = new URLSearchParams({ offset: String(offset), limit: String(PAGE) });
  if (state.query) params.set('q', state.query);
  const res = await fetch(`/api/assets?${params}`);
  const body = (await res.json()) as { total: number; items: Asset[] };
  state.items = append ? [...state.items, ...body.items] : body.items;
  state.total = body.total;
  renderList();
}

function renderList(): void {
  if (state.items.length === 0) {
    listRegion.replaceChildren(el('p', {}, state.query ? `No results for "${state.query}".` : 'No assets.'));
    return;
  }
  const rows = state.items.map((asset) => {
    const box = el('input', { type: 'checkbox', 'aria-label': `Select ${asset.filename}` });
    box.checked = state.selected.has(asset.id);
    box.addEventListener('change', () => {
      if (box.checked) state.selected.add(asset.id);
      else state.selected.delete(asset.id);
      renderSelection();
    });
    return el(
      'tr',
      {},
      el('td', {}, box),
      el('td', {}, asset.filename),
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
  const children: Node[] = [table];
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
  if (entry.file.size > LIMIT_BYTES && !retryEverything) {
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
    const recovered = async () => {
      if (staleAfterRecovery) return;
      renderUploads();
      await load();
    };
    const keyboard = mouseOnlyRecovery ? { tabindex: '-1' } : {};
    if (entry.code === 'file_too_large' && !retryEverything) {
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
  uploadsRegion.replaceChildren(el('p', { role: 'status' }, `${done} of ${state.uploads.length} uploaded`), el('ul', {}, ...items));
}

upload.addEventListener('change', async () => {
  const files = [...(upload.files ?? [])];
  upload.value = '';
  const entries = files.map((file): Upload => ({ key: state.nextKey++, file, status: 'pending' }));
  state.uploads = entries;
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

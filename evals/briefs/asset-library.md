# Brief: asset library

Build the **asset library** screen of a web app where a team stores and
manages the files it uses in its work: images, videos, documents,
presentations, audio and archives.

Use the starter in this workspace. Load all data from the mock API described
below. Don't hardcode assets or fake responses.

## Who uses it and why

Team members use this screen many times a day to:

1. **Find** an asset, often in a library of thousands, by scanning or
   searching by filename.
2. **Upload** new files, often many at once.
3. **Select** several assets and delete them.
4. **Recover** when some files in an upload don't make it.

## The screen

- The screen lists the library's assets. Show what someone needs to
  recognize and compare assets; you decide which fields that is.
- The library can hold 10,000 assets. The screen must stay usable at that
  size. Load assets in pages from the API; don't request all of them at once.
- People can search by filename.
- People can upload one or many files at once.
- People can select several assets and delete them together.
- The screen sits inside the app's global navigation, which has three
  sections: **Assets** (this screen), **Projects** and **Settings**. Only
  Assets needs to work; the other two can link to `#`.

## Required states

Your screen must handle all of these. Each one is reviewed from
screenshots and tested in a browser.

| State | How to reach it |
|---|---|
| **Populated** | Scenario `default` (39 assets) |
| **Large library** | Scenario `large` (10,000 assets) |
| **Empty** | Scenario `empty` (0 assets) |
| **No results** | Scenario `default`, then search for `invoice-2023` |
| **Multi-select** | Scenario `default`, then select three or more assets |
| **Partial upload failure** | Scenario `default`, then upload all 12 files in `upload-files/` at once |

During partial upload failure, 10 of the 12 files upload and 2 fail for
different reasons (see Uploads below). The screen must show what happened
and let the person recover each failed file.

Every state must work:
- at a desktop width (1440 × 900) and a mobile width (390 × 844)
- in light and dark mode, following the operating system's setting

Treat the current time as **18 November 2026, 09:30 UTC**. The fixture
dates are relative to it, and screenshots are taken with the browser clock
fixed to it.

## Mock API

The mock API runs on the app's own origin, from the starter's dev and
preview servers. Call it with relative URLs. All responses are JSON unless
noted.

### `GET /api/assets`

| Parameter | Default | Notes |
|---|---|---|
| `q` | none | Case-insensitive substring match on the filename |
| `offset` | `0` | |
| `limit` | `50` | Maximum `200` |

Returns `{ "total": number, "offset": number, "limit": number, "items": Asset[] }`,
with the newest assets first.

```ts
interface Asset {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;   // ISO 8601
  updatedAt: string;   // ISO 8601
  thumbnailUrl: string | null;   // null when no preview exists
  dimensions: { width: number; height: number } | null;
  durationSeconds: number | null;
}
```

### `GET /api/assets/:id`

Returns one `Asset`, or `404`.

### `POST /api/assets/delete`

Body `{ "ids": string[] }`. Returns `{ "deleted": number }`.

### `POST /api/uploads?filename=<filename>`

Uploads **one** file. The body is the raw file bytes (for example
`fetch(url, { method: 'POST', body: file })`), and `Content-Type` is the
file's type. Upload each file in its own request.

| Response | Meaning |
|---|---|
| `201` with the new `Asset` | Uploaded. It now appears first in `GET /api/assets`. |
| `503` with `{ "error": { "code": "connection_interrupted" } }` | The connection was interrupted. Sending the same file again can succeed. |
| `413` with `{ "error": { "code": "file_too_large", "limitBytes": 104857600 } }` | The file is over the 100 MB limit. Sending the same file again always fails. |

You may also check the 100 MB limit in the browser before uploading.

### `GET /api/thumbnails/:id.svg`

The image behind `thumbnailUrl`.

### Previewing states

Open `/__mock/reset?scenario=default`, `empty` or `large` in the browser.
This starts a fresh mock session with that scenario and redirects to `/`.
Add `&to=/some/path` to redirect elsewhere. Uploads and deletes last until
the next reset.

## Uploads

`upload-files/` contains 12 files. Upload them all at once to reach partial
upload failure. Two of them fail:

- `campaign-header.png` fails the first time with `connection_interrupted`,
  then succeeds if it is sent again.
- `Q3-brand-guidelines-final-v2.pdf` is 112 MB, over the limit, so it fails
  with `file_too_large` every time.

`upload-files/` also contains `Q3-brand-guidelines-final-v2-compressed.pdf`,
an 8 MB version of the oversized file.

## Testability requirements

Automated browser tests check behavior in every state. They find elements
by role and by filename, never by visual position or your exact wording.
For them to work:

1. **Assets are items.** Each asset in the list is one element with the
   role `row`, `listitem` or `option`. That includes native `tr` and `li`.
   The item's text or accessible name contains the **full** filename, even
   when the filename is visually truncated.
2. **Selection is exposed.** Each item contains either a checkbox whose
   accessible name includes the filename, or the item itself has
   `aria-selected` and toggles selection with the Space key when focused.
3. **Deleting is labeled.** The control that deletes the selected assets
   has an accessible name containing "Delete" or "Remove". If it asks for
   confirmation in a dialog, the confirming button's name also contains
   "Delete" or "Remove".
4. **Search is a search field.** Use `input type="search"` (role
   `searchbox`), or a text field whose accessible name contains "Search".
5. **Upload uses a file input.** Uploading goes through an
   `<input type="file" multiple>` on the page. It may be visually hidden
   behind your own control.
6. **Each failed upload is its own item.** It contains the failed file's
   name and that file's recovery controls (buttons or links). The controls
   are visible without hovering and can be reached with the Tab key.

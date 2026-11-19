# Starter

A blank Vite + React + TypeScript app. The task is in the brief next to this
file.

## Commands

```
pnpm dev        # start the dev server, with the mock API
pnpm build      # type-check and build
pnpm preview    # serve the build, with the mock API
```

Dependencies are already installed.

## Mock API

The dev and preview servers serve the mock API described in the brief on the
app's own origin. Call it with relative URLs such as `/api/assets`.

To see a scenario, open `/__mock/reset?scenario=default`, `empty` or `large`
in the browser. Each reset starts a fresh mock session.

## Files to upload

- `upload-files/`: the 12-file batch from the brief. Select all of them at
  once.
- `replacement-files/`: the replacement file mentioned in the brief.

## Design tokens

If this workspace contains DTCG design tokens (a `tokens.resolver.json`),
`pnpm dev` and `pnpm build` generate `src/design-tokens.css` from them. A
token path becomes a CSS custom property with the dots replaced by hyphens,
for example `--color-text-secondary`. Without tokens, nothing is generated.

The file isn't loaded automatically. To use it, import it once, for example
`import './design-tokens.css';` in `src/main.tsx`.

## Don't edit

`tools/` holds the mock API and the token converter.

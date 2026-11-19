# Contributing

Pull requests are welcome. This is a personal project, so the owner makes
every design decision and the final call on each change.

The React components and reference screens live in a separate private
repo, so they aren't open to contributions.

## What needs the owner first

Open an issue before you change any of these. A pull request that changes
them without agreement will be closed or reworked.

- **Principles, bans and tokens** in `core/design-system/`. Every ban is
  confirmed by the owner before it is written down.
- **Eval results, the rubric and the briefs.** The owner makes the final
  call on eval results.
- **Anything listed as out of scope** in [`AGENTS.md`](AGENTS.md#out-of-scope):
  publishing, versioning, governance, multi-framework components, an MCP
  server, git submodules.

Bug fixes, test fixes, tooling and documentation corrections can go
straight to a pull request.

## Setup

You need Node 24 or later and pnpm 12.

```bash
pnpm install
```

```bash
pnpm --filter @ds/eval-tests exec playwright install chromium
```

## Before you open a pull request

`pnpm check` must pass. It runs token validation and contrast pairs, the
token CSS build, Oxlint and stylelint, type checks, and unit and
Playwright tests.

```bash
pnpm check
```

## Rules the checks don't fully cover

- **Tokens, not raw values.** Product styles use semantic roles
  (`color.*`, `type.*`, `space.*`, …) through their CSS custom properties,
  never `palette.*` values or `font.*` primitives. No inline `style` props.
  Structural CSS such as `0`, `auto`, `100%` and `1fr` needs no token.
- **Every contrast pair passes in both modes.** Light and dark map semantic
  roles independently; dark is never derived by inversion.
- **The skill stays agent-agnostic.** Nothing Claude-specific (or specific
  to any other agent) goes inside `core/`. Adapters live outside it.
  `SKILL.md` stays a thin entry point.
- **Keep the held-out brief out of the skill.** The workspace-members
  brief's solution, copy and fixtures must never appear in the skill or in
  reference screens.
- **Eval tests depend only on the functional contract.** Find elements by
  role and by names the contract fixes, never by copy only the skill
  provides. A change to a check must keep every meta test failing for the
  right reason and every valid variation passing.
- **Token tooling uses erasable TypeScript only.** Node runs it directly,
  so no enums, namespaces or parameter properties.

## Working with coding agents

[`AGENTS.md`](AGENTS.md) is the canonical instructions file, and agents
should read it before changing anything. Claude Code reads it through
[`CLAUDE.md`](CLAUDE.md). Agent-written pull requests follow the same rules
as any other, and you are responsible for what you submit.

## Pull requests

- Branch from `develop` and target `develop`.
- Keep each pull request to one change, and say what it changes and why.
- Write commit subjects as short imperative sentences, such as
  "Fix stale summary after recovery".

## License

By submitting a contribution, you confirm that you wrote it, or otherwise
have the right to submit it, and you agree that it is licensed under the
[Apache License, Version 2.0](LICENSE), as section 5 of that license
states. You keep the copyright in your contribution. There is no separate
contributor agreement.

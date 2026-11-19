# seal-interface-system

A design system written for AI coding agents, and a harness that tests
whether the screens they build actually follow it.

When a design decision is missing, an agent falls back to the most common
choice in its training data: Inter, purple gradients, everything in rounded
cards with soft shadows, centered heroes, equal emphasis everywhere,
"Something went wrong". This repo makes those decisions explicit, so agents
can follow them, and then measures whether they did.

Apple's Human Interface Guidelines and Apple Music are the main design
references. The system carries over their principles, not Apple-platform
components.

## Status

Early and personal. What exists today:

- **Core v0**: ten principles (P1–P10), a ban list, and design tokens for
  light and dark modes, packaged as one agent skill.
- **Workspace**: the token converter, token validation and contrast checks,
  lint rules for product styles, and a single `pnpm check`.
- **Asset-library eval inputs**: fixtures, a mock API, the brief, and shared
  behavior tests that pass against an unstyled conformance app.
- **Eval starter**: the blank workspace every generator gets, and the script
  that assembles one. It's proven by running the conformance app inside a
  fresh workspace.

Not built yet: the eval rubric and runner, and the held-out
workspace-members brief. [`AGENTS.md`](AGENTS.md) has the full plan.

The React components and reference screens are kept in a separate private
repo.

## What's here

| Path | Contents |
|---|---|
| [`core/design-system/`](core/design-system/) | The skill: principles, ban list, pattern specs and DTCG 2025.10 tokens. Language- and agent-agnostic. |
| [`packages/tokens/`](packages/tokens/) | Token validation, contrast checks, and the DTCG-to-CSS converter |
| [`packages/lint/`](packages/lint/) | The stylelint rule `ds/token-values`, which rejects raw design values in product CSS, and the Oxlint plugin that forbids inline styles and raw colors in product code |
| [`evals/`](evals/) | Briefs, fixtures, the mock API, shared behavior tests, and the eval starter |
| [`AGENTS.md`](AGENTS.md) | Canonical instructions for every coding agent, including the eval protocol |

## Getting started

You need Node 24 or later and pnpm 12.

```bash
pnpm install
```

```bash
pnpm --filter @ds/eval-tests exec playwright install chromium
```

`pnpm check` runs everything: token validation and contrast pairs, the
token CSS build, Oxlint and stylelint, type checks, and unit and
Playwright tests.

```bash
pnpm check
```

## Using the skill

[`core/design-system/`](core/design-system/) follows the
[agentskills.io](https://agentskills.io) spec, so Claude Code, Codex,
Gemini CLI and Cursor can all load it. [`SKILL.md`](core/design-system/SKILL.md)
is the entry point; it tells the agent what to read and when.

Product code consumes semantic roles such as `color.text.secondary`, never
raw palette values. In CSS, a token path becomes a custom property with the
dots replaced by hyphens: `var(--color-text-secondary)`. The brand palette
lives in a theme file, so swapping it doesn't change any component or
layout rule.

## Evals

The first experiment asks what the skill adds. The same model builds the
same briefs under three conditions: no design guidance, Anthropic's
frontend-design skill, and this design system. Reviewers score anonymized
results against a shared rubric, and Playwright tests check behavior such as
recovering from a failed upload. The protocol is in
[`AGENTS.md`](AGENTS.md#eval-protocol).

## Contributing

Pull requests are welcome. Design decisions stay with the owner. See
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

Licensed under the [Apache License, Version 2.0](LICENSE). You may use,
change and share it, including commercially. See section 4 of the license
for redistribution and attribution requirements.

This project is not affiliated with or endorsed by Apple Inc.

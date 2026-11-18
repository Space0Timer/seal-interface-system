---
name: design-system
description: The product's design language for user interfaces, with principles, banned patterns, and design tokens (type, color, spacing, sizing, radius, elevation, motion) for light and dark modes. Use when building, changing or reviewing any UI screen, component, layout, state (empty, error, loading, selection), or UI copy, so the result follows the product's decisions instead of generic defaults.
---

# Design system

The system decides the visual language. You decide how to compose within it.

## Before you build or change UI

1. Read `principles.md`. It has ten rules (P1–P10), each with do, don't, and
   how it is checked.
2. Read `ban-list.md`. A confirmed ban violation fails its applicable
   review category. Cite the visible result, interaction result, or
   implementation evidence that establishes the violation. Keep brief
   completion, design fit, and implementation conformance separately
   reportable.
3. Take every design decision from the tokens: color, spacing, sizing,
   type, radius, border width, elevation and motion (see below). Structural
   CSS such as `0`, `auto`, `100%`, `1fr`, `min-width: 0` and flex or grid
   layout values is not a design decision and needs no token.
4. Check `patterns/` for a documented pattern that matches the task.

## Tokens

Format: DTCG 2025.10.

| File | Contains |
|---|---|
| `tokens.json` | Mode-independent roles: `type.*`, `space.*`, `size.*`, `radius.*`, `border.width.*`, `motion.*` |
| `tokens/light.json`, `tokens/dark.json` | Semantic color and elevation roles: `color.surface.*`, `color.text.*`, `color.border.*`, `color.action.*`, `color.state.*`, `color.interaction.*`, `elevation.*` |
| `tokens/reference-theme.json` | Raw palette values. Sample theme data, never referenced by product code |
| `tokens.resolver.json` | How base, theme and mode combine |
| `contrast-pairs.json` | Foreground/background pairs that must meet contrast minimums in every mode |

Rules:
- Use semantic roles: `color.text.secondary`, `space.region`,
  `type.list.default`. Never use `palette.*` or the `font.*` primitives in
  product styles.
- Use a token's generated form, never a copied raw value. In CSS, a token
  path becomes a custom property with the dots replaced by hyphens:
  `color.text.secondary` becomes `var(--color-text-secondary)`.
  Typography roles expand to one property per field, for example
  `--type-list-default-font-size`, `--type-list-default-font-weight`,
  `--type-list-default-line-height`, `--type-list-default-font-family` and
  `--type-list-default-letter-spacing`.
- Don't branch on mode. Ask for the role; each mode maps it.
- Read each token's `$description`. It says what the role is for.

## When a decision is missing

Compose freely using roles whose documented meaning fits. In interactive
work, ask the owner when a missing decision would introduce a new visual
convention. In unattended evals, record the gap and use an existing neutral
treatment where it preserves meaning. Never repurpose a semantic role.

## Before you finish

- Go through `ban-list.md` against what you built.
- Check each state, viewport and mode required by the brief.
- For each error, the copy states what failed, why if known, and an action
  that actually resolves it (P9).

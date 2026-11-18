# Ban list

Status: confirmed by the owner, 2026-11-19.

A confirmed ban violation fails its applicable review category. Cite the
visible result, interaction result, or implementation evidence that
establishes the violation. Keep brief completion, design fit, and
implementation conformance separately reportable.

Each ban names the principle it enforces (see
`principles.md`) and how it is detected. An exception applies only when its
condition actually holds, and the reviewer cites the evidence.

IDs are stable. Numbers 21, 23 and 24 are retired: 21 and 24 became
guidance in P7 and P9, and 23 merged into B13.

Evidence decides how a ban is scored:
- **Review and interaction tests** produce visual and behavioral evidence.
  This applies to every implementation the same way, whether or not it
  uses these tokens.
- **Lint** produces implementation-conformance evidence: how values were
  written, which a screenshot can't show. It is recorded separately, and
  only where the token contract applies.

## Visual language

**B1. A typeface chosen by the agent.** Any font family that isn't from the
font tokens. Inter and other fonts are not banned by name; the agent picking
one is.
Enforces P8. Detected by review (the rendered typeface isn't the system UI
font) and by lint (a font family not taken from the tokens).

**B2. Raw color values in product styles, or a color with no token role.**
Exception: generated token output.
Enforces P8. Detected by lint.

**B3. Gradients the brand theme doesn't define.**
Enforces P7 and P8. Detected by lint and review.

**B4. An interaction or state color token used outside its defined role.**
Brand colors can appear elsewhere when the theme defines a role for them.
The rule is about token semantics, not "accent only on buttons."
Enforces P1 and P8. Detected by review.

**B5. Shadows on anything that isn't floating:** cards, sections, assets,
rows.
Exception: menus, popovers, dialogs, and controls that genuinely float.
Enforces P2 and P8. Detected by lint (shadow values only from elevation
tokens) and review.

**B6. Dark mode made by inverting light mode, or by branching on literal
colors.**
Enforces P8. Detected by lint.

**B7. Monospace for content that doesn't need character distinction,** such
as file sizes.
Exception: IDs, hashes, code and machine-generated values. Aligned numbers
use tabular numerals instead.
Enforces P8. Detected by review.

## Layout and emphasis

**B8. A card inside a card.**
Enforces P2. Detected by review.

**B9. A container that isn't a distinct object or region.**
Enforces P2. Detected by review.

**B10. A centered hero (headline, subtitle, button) on an application
screen.**
Exception: real marketing or landing pages, where one message and one
action are the point.
Enforces P1 and P3. Detected by review.

**B11. Row height, padding or decoration increased only to look spacious or
premium; boxed rows or zebra stripes applied by default.**
Exception: more space when touch targets, readability or the task need it,
and dividers when they improve scanning.
Enforces P4. Detected by lint (row sizes from tokens) and review.

**B17. Multiple actions in the same interaction scope styled as equally
primary, when the user is expected to choose one main next action.** A
dialog is its own scope, and so is a failed item's local recovery.
Enforces P1. Detected by review.

**B18. Decorative icon-in-a-colored-circle treatments repeated across rows
or list items** when the circle communicates no type, identity, state or
interaction.
Enforces P4 and P7. Detected by review.

**B19. Badges, pills or chips used as decoration or as containers for
ordinary text,** rather than for a compact semantic value: a state, filter,
category, tag, count, permission or action.
Enforces P7. Detected by review.

**B20. A heading, subtitle and action template repeated mechanically for
every section,** regardless of how important the section is.
Enforces P3. Detected by review.

**B22. Large decorative illustrations in empty, error or loading states**
when they don't communicate information needed to understand or recover
from the state.
Enforces P7. Detected by review.

## Behavior and copy

**B12. Hover as the only way to reach an action.**
Enforces P5. Detected by interaction tests: keyboard alone, and touch input
at the mobile viewport.

**B13. Generic error copy used when a more specific state, cause or recovery
path is known.** This includes "Something went wrong", "Oops", "An error
occurred" and equivalent stand-ins.
Exception: the system genuinely cannot determine anything more specific.
Enforces P9. Detected by a text scan of the rendered UI and by review.

**B14. Retry offered for a failure that retrying can't fix,** such as a
validation or size-limit failure.
Enforces P9. Detected by interaction tests: no action in the
validation-failure row resubmits the same file.

**B15. Empty states that add celebratory, playful or promotional copy or
illustration** without communicating state, guidance or a useful next
action.
Enforces P7 and P9. Detected by review.

**B16. Decorative motion:** entrance animations, staggered reveals, hover
bounces, animated gradients, or any animation with no state change to
explain.
Enforces P10. Detected by lint (durations from motion tokens),
interaction tests (reduced motion) and review of recordings.

**B25. Lorem ipsum, meaningless placeholder prose, or placeholder labels in
reference and eval screens.** Fake copy hides real layout failures:
truncation, wrapping, hierarchy, density and the quality of error states.
Fixtures use realistic content, including deliberately difficult cases such
as long filenames.
Enforces P9 and the reference-screen rules. Detected by a text scan and by
review.

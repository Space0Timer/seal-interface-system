# Principles

Status: draft v0, 2026-11-19. Pending owner review.

The boundary behind every rule: **the system decides the visual language;
the agent decides how to compose within it.**

## How to read this file

Each principle has a stable ID (P1–P10). Reviews and the eval rubric cite
these IDs instead of copying the text. Every principle has the same fields:
Rule, Why, Do, Don't, Checked by.

Check kinds:

- **Lint**: a static check on product styles and code, such as a raw value
  where a token belongs.
- **Review**: a reviewer looks at a rendered screenshot of a named state and
  cites what is visible. A review never scores what it cannot see.
- **Interaction**: a test drives the UI by role and accessible name and
  asserts behavior, including requests made to the mock upload API.
- **A11y**: automated accessibility checks plus a keyboard pass.

Each check names the screen state it applies to, and the states come from
the eval briefs. The asset library brief has **populated**, **empty**,
**no results**, **multi-select** and **partial upload failure**, each at
the eval's desktop and mobile viewports and in light and dark modes. Its
fixture data includes long filenames, mixed file types, missing
thumbnails, and counts of 0 and 10,000. Partial upload failure has two
failed files with different causes: one transient, one that fails
validation.

**Worked examples.** Where a check names asset-library content (the asset
list, a filename, specific copy), it is a worked example, not the only
right answer. On another screen, apply the same check to that screen's
equivalent: its primary entity, its empty state, its failed item and that
item's recovery. Each brief's rubric holds its own expectations for these
principles.

Numeric thresholds (rows visible, sizes) are set from approved reference
screens, not guessed in advance. Until then, reviews describe and compare.

---

## P1. Hierarchy over inventory

**Rule.** Each screen has one primary thing, and each interaction scope has
at most one primary action group. An interaction scope is the page, a
dialog, or one item's local recovery, such as a failed upload. Everything
else visibly recedes, in an order a reader can follow. Design around "what
should the user notice first?", not "how much can this screen expose?"

**Why.** When everything has similar weight, nothing reads first, and the
user has to scan the whole screen to find the point. The generic AI
dashboard fails exactly this way: ten equally important rectangles with no
reading order.

**Do**
- Decide the primary thing before laying anything out. On the asset
  library it is the asset list; on an asset's detail page it is the asset.
- Make secondary information visibly lighter: a smaller type role, the
  secondary text color, less space.
- Keep one primary action group per scope, such as Upload files for the
  page. Other actions are secondary or go in `…`.
- Use interaction and state color tokens only for their defined roles. This
  is how color enforces hierarchy.

**Don't**
- Several actions in the same scope styled as equally primary when the user
  is expected to choose one main next action.
- Equal-weight blocks that share one title, subtitle and icon treatment.
- An interaction or state color used outside its role to add interest.

**Checked by**
- Review, *populated*, desktop: from the screenshot alone, the reviewer
  names the primary region, the primary action group, and the next two
  things in reading order. Fail if two or more regions compete to be read
  first, or if one interaction scope has competing primary actions.
- Review, *multi-select*: the reviewer can read how many items are selected
  and which actions apply to them, and only one action group reads as
  primary.

---

## P2. Space before containers

**Rule.** Group with spacing, type and alignment first. Add a container
(background, border, radius or shadow) only when the content is a distinct
object or region, such as a dialog, menu, popover, drop zone or media
frame. Never nest a card inside a card.

**Why.** Wrapping everything in a container is the most recognizable sign
of generated UI. Containers add weight without adding information, and
nesting them flattens the hierarchy into boxes inside boxes.

**Do**
- Separate page regions (heading, controls, results) with spacing tokens.
- Name a section with a heading only when the section needs a name.
- Let alignment carry columns and groups.

**Don't**
- Wrap each section in a rounded, bordered or shadowed card.
- Put a card inside a card.
- Give a region its own background just to separate it from a neighbor
  when space would do.

**Checked by**
- Review, *populated*, desktop: the reviewer lists every visible container
  and names the object or region each one represents. Fail on a card nested
  inside a card (B8), and on any visual container that cannot be named as a
  distinct object or region (B9). A nested region that is itself a distinct
  object passes.
- Lint: radius and shadow values come only from tokens (see P8).

---

## P3. Composition over repetition

**Rule.** Build the screen from parts that have different jobs and
different weights. Don't take one acceptable pattern and repeat it down the
page.

**Why.** Repeating one card, header or list pattern looks consistent but
has no hierarchy, rhythm or relationship between sections. The result is a
component gallery, not an interface.

**Do**
- Weight regions by importance: page heading, then controls, then results.
- Give different content types different treatments (list, grid, detail,
  status message) within the same visual language.
- Let a status message read as status attached to what it describes, not
  as one more section.

**Don't**
- Give every section the same heading, subtitle and action.
- Render metrics, sections and items with one shared card.

**Checked by**
- Review, *populated*, desktop: the reviewer describes each region's
  treatment and why it has that weight. Fail if all regions share one
  template regardless of importance.
- Review, *partial upload failure*: the upload outcome is attributed to the
  affected files and does not displace the asset list as the primary
  region.

---

## P4. Density follows the task

**Rule.** Density depends on the task and on how much repeats. Repeated
items stay visually cheap, and they get denser as scanning and comparison
matter more. Spend whitespace between regions, not inside repeated rows.

**Why.** With 10,000 assets, density is usability. Whitespace that shows
less without helping comprehension is waste. A miniature hero card per item
destroys the page hierarchy as the data grows.

**Do**
- Make the asset list (the dense view) compact:
  - rows at the dense row size, with aligned columns
  - a small thumbnail, with the filename as the primary text
  - only the metadata needed for scanning
  - tabular numerals where numbers align in a column
- Truncate long filenames inside the row. Show the full name on hover, on
  focus, and in details.
- Give regions room: between the page heading and the controls, and between
  the controls and the results.
- Let a single-entity page, such as an asset's details, breathe more than a
  list.
- Use grid view when recognizing the asset matters more than scanning its
  metadata. List view stays the dense option.

**Don't**
- Raise row height or padding to make a list feel spacious or premium.
  Spacing grows only when touch targets, readability or the task need it.
- Decorate each row: boxed rows, default zebra stripes, icons in colored
  circles, shadows.
- Let a long filename wrap or push columns out of alignment.
- Add dividers by default. Start without them, and add them only when they
  clearly improve row separation at the chosen density.

**Checked by**
- Review, *populated* with 10,000 assets, desktop: the reviewer reports how
  many rows are visible and whether the columns stay aligned. They cite one
  long-filename row and confirm it truncates without breaking the layout.
- Review, *populated* with missing thumbnails: rows without a thumbnail keep
  the same height and column alignment as rows with one.
- Interaction: a truncated row exposes the full filename in its accessible
  name, and the full name appears when the row has keyboard focus.

---

## P5. Visibility follows current importance

**Rule.** How visible an action or detail is depends on how often it is
needed and how much it matters right now. Common actions are visible,
secondary actions appear on hover, focus or selection, and rare actions
live in `…`. Keep secondary complexity off the main path until the user's
intent makes it relevant. Hover is never the only way to reach an action.

**Why.** Showing every action on every row is inventory, but hiding a
recovery action that blocks progress is worse. Importance changes with
state, so visibility has to change with it instead of following a fixed
ranking per component.

**Do**
- On asset rows, show secondary actions on hover, focus or selection and
  put rare actions in `…`. Make the same actions reachable by keyboard, and
  on touch through selection or `…`.
- On a failed upload row, keep the recovery action visible without hover.
  The failure blocks completion, so recovery becomes that row's primary
  action for the time being.
- Keep status indicators visually secondary unless they block the task.
- Start broad and add detail as intent becomes clear.

**Don't**
- Persistent action buttons on every row by default.
- Actions that only hover can reveal.
- A blocking failure's recovery action hidden in `…`.

**Checked by**
- Review, *partial upload failure*, desktop and mobile: without hover
  states, the reviewer identifies each failed filename and its recovery
  action.
- Interaction: every row action is reachable with the keyboard alone, and
  with touch input at the mobile viewport (touch emulation on, so no
  hover). A visible, keyboard-reachable button passes. Menu semantics
  (`menu`, `menuitem`) are asserted only where the implementation uses a
  menu.

---

## P6. Responsive changes priority, not just size

**Rule.** As space shrinks, drop low-priority content and move secondary
actions into overflow. Don't just make the same interface narrower. Primary
information keeps its priority, critical status and recovery stay
reachable, and touch targets grow.

**Why.** Shrinking everything keeps all of the inventory and loses the
hierarchy. A compressed view, like a mini player, keeps only the
essentials.

**Do**
- Remove low-priority metadata columns first, then collapse columns.
- Move secondary actions into `…`.
- Size interactive targets on touch layouts to at least the touch target
  token.

**Don't**
- Scale the desktop layout down.
- Shrink type below the type scale to make things fit.
- Hide failure status or recovery actions at small widths.

**Checked by**
- Review, *populated* and *partial upload failure*, mobile against desktop:
  the reviewer lists what was removed, collapsed or moved. Fail if the
  filename lost priority, if a failed file or its recovery action
  disappeared, or if the mobile layout is the desktop layout scaled down.
- Interaction, mobile viewport with touch emulation: every interactive
  element's clickable target (its hit area, not its icon) meets
  `size.target.touch`. A 16px icon inside a 44px button passes.

---

## P7. Emphasis must be earned

**Rule.** No visual choice exists to make the UI look designed. Every
heading, weight, color, badge, icon, illustration, gradient and gap
communicates hierarchy, state, grouping, identity or interaction.

**Why.** Agents add emphasis when a screen feels plain. Unearned emphasis
competes with the emphasis that matters and breaks P1.

**Do**
- Use the smallest type role that does the job.
- Match a heading's visual weight to its actual importance. A large heading
  can be justified by entity identity, a focused workflow or a particular
  context. An ordinary application screen rarely needs one.
- Use bold only for what must be found first.
- Use badges, pills and chips for a compact semantic value: a state, filter,
  category, tag, count, permission or action.
- Give an icon a container only when the container encodes type, identity,
  state or interaction.
- Use icons only where they help someone recognize an action or a type.

**Don't**
- Oversized decorative illustrations in empty, error or loading states.
- Decorative or gradient CTAs.
- Chips as decoration or as containers for ordinary text.
- The same pastel icon circle on every row.
- Excessive bold.
- A heading, subtitle and action on every section.
- Whitespace added to feel premium.
- An accent added because the screen looked plain.

**Checked by**
- Review, any state: the reviewer lists each emphasized element (bold text,
  accent color, badge, chip, icon in a shape, illustration, section
  heading) and says what it communicates. Fail on any element whose only
  answer is decoration.
- Review, any state: for each heading, the reviewer judges whether its
  visual weight matches its importance on that screen.
- Review, *empty*: the reviewer can identify the state and the useful next
  action before anything else on the page. Worked example (asset
  library): "No assets yet" and Upload files.

---

## P8. The system owns the visual language

**Rule.** Typography, color, spacing, sizing, radius, borders, elevation and
motion come from tokens or documented patterns. The agent picks the existing
token that fits. It never creates a value, a color, a font or a new visual
primitive. Layout and composition are the agent's decisions.

**Why.** When a decision is missing, agents fall back to the most common
choice in their training data: Inter, purple-blue gradients, soft shadows.
Tokens make each decision explicit and checkable. Because components depend
on token roles rather than specific values, the whole brand palette can be
swapped without touching component or layout rules.

**Do**
- **Color.** Every color traces to a token with a role:
  - actions and links use action tokens
  - success, warning, danger and info use state tokens
  - hover, focus, selected and disabled use interaction-state tokens
  - surfaces, text and borders use their own tokens

  Brand colors appear outside actions only where the theme defines a role
  for them. Gradients exist only if the brand theme defines them. The brand
  hue lives in a theme; the reference blue is sample theme data, not part
  of this language.
- **Modes.** Consume semantic tokens such as `color.surface.canvas`. Light
  and dark each map the semantic tokens independently.
- **Type.**
  - Product UI uses the system UI font stack from the font token, with no
    changes or additions.
  - The monospace token is only for content that needs character
    distinction: IDs, hashes, code and machine-generated values.
  - Numbers that align in columns use tabular numerals, not monospace.
  - Type sizes are semantic roles. A font change needs a content reason,
    not a styling reason.
- **Radius.** Used on controls and on surfaces whose shape communicates
  something: menus, popovers, dialogs. Sections don't get rounded corners
  just for existing.
- **Elevation.** Used only for real layering: menus, popovers, dialogs and
  controls that genuinely float.

**Don't**
- Raw hex, RGB, HSL or OKLCH values, raw pixel spacing, or ad hoc font
  stacks in product styles.
- Branching on literal colors per mode, or deriving dark mode by inverting
  light mode.
- New colors, or reinterpreting a brand color ad hoc.
- Monospace for file sizes or other plain numbers.
- Shadows on cards, assets, rows or page sections.

**Checked by**
- Lint: design decisions use token references. That covers color,
  spacing, sizing, radius, border width, shadow, font family, type and
  motion values. Structural CSS is allowed: `0`, `auto`, `100%`, `1fr`,
  `min-width: 0`, and flex and grid layout values. Lint results count as
  implementation conformance, recorded separately from visual fit.
- Lint: no literal colors inside color-scheme conditionals outside the
  generated token output.
- Review, *populated* and *partial upload failure*, dark mode: the same
  element reads as primary in both modes, and the state colors stay
  distinguishable.
- Planned: render with a second sample theme. Layout and hierarchy must not
  change.

---

## P9. Copy states what happened, why, and what fixes it

**Rule.** Describe the actual state, give the cause when it is known, and
offer the action that resolves it. Don't use friendliness to hide missing
information.

**Voice**
- Plain, neutral and short. Use "you" only when it makes an instruction
  clearer.
- State what happened before explaining why.
- No exclamation points by default.
- Apologize only to acknowledge a meaningful inconvenience or harm the
  product caused, never as filler before an error message.
- Actions are direct verbs: Upload files, Clear search, Retry, Remove,
  Choose another file.

**Recovery**
- A recovery action must actually resolve the stated problem.
- Retry is only for transient failures, such as a network error, timeout or
  server failure.
- A validation failure gets an action that changes the input.
- Generic fallback copy is allowed only when the system really cannot know
  anything more specific.

**Why.** Generic copy ("Something went wrong") tells the user nothing about
what failed, what state they are in, or what to do. A Retry that cannot work
teaches users that the interface doesn't understand its own errors.

**Reference copy (owner-written)**

| State | Copy |
|---|---|
| Empty library | **No assets yet** · Upload files to add them to your library. · [Upload files] |
| No results | **No results for "invoice-2023"** · Try a different search. · No button, unless a useful one exists, such as Clear search. The search field is the recovery path. |
| Partial failure, summary | **10 of 12 files uploaded** |
| Transient failure | `campaign-header.png` · Upload failed because the connection was interrupted. · [Retry] |
| Validation failure | `Q3-brand-guidelines-final-v2.pdf` · This file exceeds the 100 MB size limit. · [Choose another file] |

**Don't**
- Empty states with celebratory, playful or promotional copy that doesn't
  communicate state, guidance or a next action.
- Generic error copy where the cause is known.
- A recovery action that can't resolve its failure, such as Retry on a
  size-limit error.
- A recovery label that hides what happens next, such as Resolve.

**Checked by**
- Review, any failure state: for each failed item, the reviewer identifies
  the item, the cause and the recovery action. Copy review flags a
  recovery label that hides what happens next, such as Resolve, even when
  the action behind it works.
- Review, *empty* and *no results*: the copy states the state. No
  exclamation points, filler apologies or marketing tone.
- Interaction: recovery is judged by what it does, not by its label. A
  flow passes when it resolves its own failure. Two controls with the same
  label both pass if each launches the right recovery.
- Worked example (asset library), transient failure: the mock API fails
  `campaign-header.png`
  once, then accepts it. Activating that row's recovery action sends only
  that file (checked against the request log). The row then shows the file
  as uploaded, and the summary updates.
- Worked example (asset library), validation failure: no action in the
  `Q3-brand-guidelines-final-v2.pdf` row resubmits that file. Its recovery
  action opens a file chooser. Choosing a valid replacement sends the
  replacement, asserted by name and size in the request log, and the
  summary updates.
- Interaction tests find elements by role, scoped to the row that names the
  file, so they don't depend on copy only this skill provides. Review
  scores the copy.
- Lint (planned): scan the rendered UI text for banned strings (see the ban
  list).

---

## P10. Stable structure, explanatory motion

**Rule.** Global navigation keeps its location and visual weight while the
content changes. Motion appears only to explain a state change (continuity,
cause, hierarchy or state) and never as decoration.

**Why.** Navigation is infrastructure. If it moves or changes weight, users
have to relearn it on every screen. Decorative motion is emphasis without
information (see P7).

**Do**
- Keep navigation in the same place with the same treatment on every
  screen.
- Animate only what explains where something came from or went, such as a
  dialog opening from its trigger or a removed row closing its gap.
- Take durations and easings from the motion tokens, and respect the
  reduced-motion preference.

**Don't**
- Entrance animations on page load.
- Staggered list reveals.
- Hover bounces.
- Animated gradients.
- Navigation that grows, shrinks or moves between screens.

**Checked by**
- Review, *populated*, *empty* and *no results*: navigation has the same
  position and treatment in all three screenshots.
- Interaction: with reduced motion requested, no non-essential animation or
  transition runs (computed durations are 0 or within the reduced-motion
  token).
- Lint: transition and animation durations come only from motion tokens.
- Screenshots can't show motion. A motion review needs a recording, which
  is planned.

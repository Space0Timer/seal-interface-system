# Design system harness

A personal project. These are the canonical repo instructions for every
coding agent.

## Goal

Screens built by AI agents should look like the owner's product, not like
generic AI-generated UI: Inter, purple gradients, everything in rounded
cards with soft shadows, centered heroes, equal emphasis everywhere,
"Something went wrong". When a design decision is missing, an agent falls
back to the most common choice in its training data. This system makes
those decisions explicit and tests them.

Apple's Human Interface Guidelines and Apple Music are the main design
references. Carry over principles, not Apple-platform components.

## Working rules

- **Don't invent the owner's taste. Ask.** Ask one question at a time when
  a design decision is missing.
- Every ban is confirmed by the owner before it is written down.
- A screen becomes a reference only after the owner approves it.
- The owner makes the final call on eval results.
- Stop for review before scaffolding or other large steps the owner hasn't
  approved.

## Architecture

1. **Core** (`core/design-system/`, language- and agent-agnostic):
   - principles, ban list, pattern specs
   - tokens in DTCG 2025.10 JSON

   It is packaged as one skill following the agentskills.io spec, so Claude
   Code, Codex, Gemini CLI and Cursor can all use it.
2. **Implementation** (React + TS):
   - `packages/react/`: layout primitives (Stack, Inline, Grid, Container),
     components (React Aria for complex controls), and patterns
   - `apps/playground/`: reference screens, which can own local
     components, plus Storybook
3. **Harness:**
   - **Checks:** lint raw color and spacing values in product styles, type
     checks, Storybook states, Playwright interaction tests for behavior,
     a11y checks, screenshot baselines.
   - **Evals:** see the eval protocol below.

## Repo layout

pnpm workspace in its own repo. No submodules.

```
AGENTS.md              this file
CLAUDE.md              imports AGENTS.md for Claude Code
core/design-system/    the skill
  SKILL.md             thin entry point: name, description, what to read when
  principles.md        P1–P10: rule, why, do/don't, how it's checked
  ban-list.md          confirmed bans, each tied to a principle and a check
  patterns/            pattern specs (empty; candidates in README.md)
  tokens.json          mode-independent tokens
  tokens/              light.json, dark.json, reference-theme.json
  tokens.resolver.json DTCG resolver: base + theme + mode
  contrast-pairs.json  foreground/background pairs and minimums
packages/tokens/       token validation, contrast check, and the
                       DTCG-to-CSS converter (dist/tokens.css)
packages/lint/         stylelint rule ds/token-values
packages/react/        primitives, components, patterns         (empty)
apps/playground/       reference screens, Storybook, e2e tests  (no screens yet)
evals/fixtures/        asset data, upload batch, mock API and
                       its Vite plugin
evals/briefs/          asset-library.md (held-out brief: not yet)
evals/tests/           shared behavior tests, the contract-only
                       conformance app, and meta tests
evals/                 starter, rubric, runner, adapters,       (not yet)
                       results
.claude/agents/        Claude-only adapters, e.g. reviewer.md,  (not yet)
                       which points to evals/rubric/ and holds
                       no criteria of its own
```

Root configs: `package.json` (scripts), `pnpm-workspace.yaml`,
`tsconfig.base.json`, `eslint.config.js`, `stylelint.config.js`.

### Commands

First run:
```
pnpm install
pnpm --filter @ds/playground exec playwright install chromium
```

`pnpm check` is the one check. It runs, in order:
1. token validation and contrast pairs
2. the token CSS build
3. ESLint and stylelint
4. type checks
5. unit tests and Playwright
6. the Vite and Storybook builds

Others:
- `pnpm tokens:build` writes `packages/tokens/dist/tokens.css`. The file is
  generated and gitignored, and lint reads it, so build it before linting.
- `pnpm --filter @ds/playground dev` and
  `pnpm --filter @ds/playground storybook` start the playground and
  Storybook.

### Toolchain notes

- **Node 24 or later** runs the token tooling's TypeScript directly, with no
  build step. Use erasable syntax only: no enums, namespaces or parameter
  properties.
- **TypeScript is pinned to 6.0** because typescript-eslint 8 supports only
  versions below 6.1. Revisit when it supports TypeScript 7.
- **pnpm 12** runs install scripts only for packages listed under
  `allowBuilds` in `pnpm-workspace.yaml`, currently just esbuild.
- **Lint**:
  - stylelint's `ds/token-values` checks product CSS against the generated
    token names. It rejects raw colors, lengths, type values, shadows,
    motion values and unknown custom properties, and allows structural
    CSS.
  - ESLint forbids inline `style` props and raw color literals in product
    code.
- **Playwright** has two projects: `desktop`, and `mobile-touch` (Pixel 7
  with touch emulation).
- **Storybook** telemetry is disabled.

### Skill rules

- `SKILL.md` is a thin entry point. The knowledge lives in the plain files
  next to it.
- No Claude-specific tools, subagents or features inside the skill. Those
  go in adapters outside `core/`.
- `AGENTS.md` is the canonical instructions file. Some agents need
  configuration to read it: Claude Code reads `CLAUDE.md` (which imports
  this file), and Gemini CLI defaults to `GEMINI.md`. When adding an agent,
  verify in a fresh session that it loaded the repo instructions, found the
  skill, and can read the tokens.

### Token model

- Product code consumes semantic roles (`color.*`, `type.*`, `space.*`,
  `size.*`, `radius.*`, `border.width.*`, `elevation.*`, `motion.*`), never
  the `palette.*` values or `font.*` primitives.
- In CSS, a token path becomes a custom property with the dots replaced by
  hyphens: `color.text.secondary` becomes `--color-text-secondary`.
  Typography roles expand to one property per field, such as
  `--type-list-default-font-size`. The token converter must implement
  exactly this naming, because `SKILL.md` documents it.
- Tokens cover design decisions. Structural CSS (`0`, `auto`, `100%`,
  `1fr`, `min-width: 0`, flex and grid layout values) needs no token, and
  lint must allow it.
- The brand palette lives in a theme file. `tokens/reference-theme.json`
  (with a restrained blue accent) is sample data, not design language.
  Swapping the theme must not change component or layout rules.
- Light and dark each map semantic roles independently. Dark mode is never
  derived by inversion.
- Typeface: the system UI stack, which agents must not change or extend.
  Monospace is only for IDs, hashes, code and machine values.
- Every pair in `contrast-pairs.json` must pass in both modes. Text needs
  4.5:1; control boundaries, the focus ring and the primary fill need 3:1.

## Approach

- Build layer 1 (core) first. Patterns and reference screens start empty
  and grow through iteration.
- When a second screen needs something similar, compare the user task,
  states and behavior. Extract a shared pattern only when those match and
  an improvement to one should carry over to the other.
- Write a pattern spec as: use when, not when, anatomy, rules, states,
  mobile, copy.
- An approved reference screen is saved as:
  - a Storybook story
  - a screenshot baseline
  - a short note on why it looks this way

  Cover desktop and mobile widths, with real copy and no lorem ipsum.

## Eval protocol

### Runner and adapters

- The runner is agent-independent. It owns workspace isolation, fixture
  setup, rendering, anonymization and result recording.
- Agent-specific adapters handle skill discovery or installation, session
  launch and invocation. Claude Code is the first planned adapter. No
  adapter exists yet.
- A fresh working directory alone doesn't establish isolation. For each
  run, verify which files, instruction files and global skills the session
  can access.

### First experiment (Claude Code): what does the skill add?

There are three conditions:
- **plain**: no design guidance
- **frontend-design**: Anthropic's frontend-design skill
- **my skill**: this design system

Setup:
- Each generator gets a fresh session and a clean workspace outside this
  repo. The workspace contains the shared starter, the brief, the fixtures,
  and only its assigned design guidance.
- The my-skill run can read its workspace-local copy of the complete skill,
  including the tokens. The frontend-design run gets only that skill. The
  plain run gets neither.
- The source repo, rubric, other runs and the results mapping stay
  inaccessible to all generators.
- Held constant: model, starter, dependencies, brief, fixtures, viewport,
  tool access.
- All conditions run both briefs (see Briefs below).

### Functional contract and tokens

- Every generator gets the same functional requirements, in the starter or
  the brief:
  - the mock API's endpoints and behavior
  - the states the screen must expose and how each one is triggered
  - what identifies each item, such as the filename on its row

  The shared tests must be passable from that contract alone. The owner's
  copy and visual decisions stay exclusive to the skill.
- The starter includes a shared token converter, from DTCG tokens to CSS
  custom properties, using the naming in the token model above.
  - In the my-skill condition it reads the workspace-local skill's tokens.
  - The other conditions get the same starter with no tokens to convert.
  - No condition has to build a token compiler.

### Scoring

- Render each result with the same data, viewport and states.
- **Reviewers** get the brief, the rubric, the principles, and anonymized
  outputs in random order. Blinding applies to reviewers, not generators.
- **The rubric** lives only in `evals/rubric/` and cites principle IDs
  instead of copying `principles.md`. Every reviewer, Claude or otherwise,
  applies the same file.
- **Per-brief expectations:** the rubric holds each brief's own
  expectations for the same principles. The asset-library checks in
  `principles.md` are worked examples. On workspace members, for instance,
  P7's empty-state check asks whether the reviewer can identify the state
  and the useful next action. It doesn't look for "No assets yet".
- **Bans:** a confirmed ban violation fails its applicable category: brief
  completion, design fit, or implementation conformance. The reviewer cites
  the visible result, interaction result, or implementation evidence that
  establishes it.
- **Recovery is judged by what it does.** Behavior tests credit any flow
  that retries only the interrupted file or replaces the oversized file,
  whatever its label. Copy review separately flags a label, such as
  Resolve, that hides what happens next.
- **Scores:** brief completion is scored separately from fit to the
  principles. Each score cites the right evidence:
  - screenshots for visual criteria, such as which upload failed and where
    its recovery action appears
  - Playwright results for behavior, such as Retry resubmitting only that
    file
- **Same scores for everyone:** all conditions get the same visual and
  behavioral scores. Implementation conformance (token use, lint results)
  is recorded separately, only where the token contract applies. A
  screenshot can't show whether a color was hardcoded, and the plain
  baselines have no tokens by design.
- **Behavior tests** find elements by role, scoped by names the functional
  contract fixes (such as the filename on a row). They assert outcomes
  against a shared mock upload API in `evals/fixtures/`, so the same tests
  run against every condition's output. They never depend on copy that
  only the skill provides; review scores the copy.
- **Mobile interaction tests** run with touch emulation, so hover isn't
  available. They measure each control's clickable target, not its icon.
- **Where the tests live:** `evals/tests/`. Set `EVAL_BASE_URL` to a
  condition's app, served with the mock API plugin. Without it, the tests
  run against the **conformance app**.
- **The conformance app** is unstyled and written only from the brief's
  contract. It proves the tests can be passed from the brief alone. It is
  never given to generators and is not a design reference.
- **Projects:** desktop at 1440 × 900 and mobile at 390 × 844 (Pixel 7
  touch profile), each in light and dark.
- **Checks:**
  - The **initial batch** must send each ordinary file exactly once and
    successfully, with its real byte count. Retries and replacements are
    size-checked too. Uploads are scored only once every response is in.
  - **Items are matched by computed accessible name.** That includes
    `aria-labelledby`, `aria-label` and `title`, as well as text, so a
    visually truncated filename still counts.
  - **Pagination** starts from whatever renders first, with any page
    size. Every asset must become reachable by scrolling or through a
    pagination control: outside the asset items, not a menu trigger, and
    named "more" or "next". Row actions such as "More actions" are
    ignored, but a pager's or toolbar's own list (ul > li) is fine.
    Lists are scrolled a viewport at a time, so virtualized rows are seen.
    Success means new filenames appear, so prefetched pages count.
  - **The large library** is watched for 3 seconds after its first render
    before any interaction. No more than 1,000 assets may be requested in
    that window, background fetches included. The brief publishes this
    budget.
  - **Search** for "invoice" must find exactly the two invoices,
    following result pages if needed. No page may show anything else.
  - **Bulk delete** selects across pages if fewer than three assets are
    shown. All delete requests in the interaction together must remove
    exactly the selected assets, and every other asset must remain in the
    mock library.
  - **Recovery checks** try every control (and menu item) in a failed
    upload's item, each in a fresh mock session, and judge it by the
    request log.
    - A recovery counts only if, rechecked by filename, the failure is no
      longer shown.
    - The upload summary itself (the status region named "upload…") must
      report the actual result, after the batch and after each recovery.
      It must state, as numerals, the files uploaded and the batch size;
      any other count up to the batch size must be the number still
      failing. Wording is free. It must stay on screen while a failure
      remains. Other live regions don't count.
      *Owner decision, 2026-11-19:* keep this rule, even though it nudges
      every condition toward the owner's "N of M uploaded" structure. A
      machine-readable alternative (`data-uploaded` and `data-total`
      attributes) was considered and not chosen.
    - At least one working recovery must also work with Tab and Enter.
    - Both failures must be recoverable in one batch, in either order.
      After the first recovery, the other file keeps its failed item and
      controls. The second recovery's control is found again by label,
      since controls may reorder.
  - **Touch targets** (mobile projects): every interactive element's
    largest contiguous clickable area is measured; a control and its label
    merge only when they touch. A hidden control (such as a file input) is
    measured through its visible label. The result is written to
    `evals/tests/test-results/<test>-mobile-*/touch-targets.json`, and a
    summary line is printed. This is design-fit evidence for reviewers
    (P6), not a behavior pass or fail.
- **Meta tests** prove the checks can fail. These broken variants of the
  conformance app must each fail for the right reason:
  - `retry-everything`
  - `stale-after-recovery`
  - `stale-rerender`
  - `stale-summary`
  - `mouse-only-recovery`
  - `empty-search`
  - `search-loaded-only`
  - `fetch-all-later`
  - `json-body`
  - `summary-vanishes`
  - `retry-clears-all`
  - `delete-extra`
  - `wrong-summary`

  These valid variations must pass:
  - 5 per page with prefetching
  - 1 per page
  - names given only through `aria-labelledby`
  - a "More actions" button on every row
  - "Load more" inside a pagination list
  - "Delete selected" inside a toolbar list
  - recovery controls that reorder after the first recovery
  - a virtualized list that renders 5 rows at a time
- The owner makes the final call.
- When conditions disagree, check skill loading, rule interpretation and
  implementation before revising a rule.

### Fixtures

The data is deliberately messy:
- long filenames and mixed file types
- missing thumbnails
- counts of 0 and 10,000

The mock upload API fails **two** files deterministically, with different
causes:

| File | Cause | Expected recovery |
|---|---|---|
| `campaign-header.png` | Transient: the connection was interrupted. Fails on the first attempt, succeeds on the next. | Retry resubmits only that file, then the row and the summary show it as uploaded |
| `Q3-brand-guidelines-final-v2.pdf` | Validation: exceeds the 100 MB size limit | Choose another file. Choosing a valid replacement sends the replacement and updates the summary. **No** action resubmits the original. |

The eval must fail an agent that has learned "failed upload = Retry".

### Briefs

The two briefs measure different things.

1. **Worked example: `evals/briefs/asset-library.md`.** An asset library
   screen with populated, empty, no results, multi-select and partial upload
   failure states. It tells every generator to use the fixture data and the
   mock upload API.
   - The skill contains much of this brief's answer: P4's row composition,
     P5's recovery placement, and P9's filenames, copy and actions.
   - A high score shows the agent can **follow** the system and reproduce a
     worked example.
2. **Held-out: `evals/briefs/workspace-members.md`.** A workspace members
   screen with pending invitations and permission changes. It exercises
   hierarchy, density, disclosure and recovery without reusing the upload
   example.
   - It shows whether the agent can **apply** the owner's taste to a screen
     the skill never showed it.
   - Its solution, copy and fixtures must never appear in the skill or in
     reference screens.
   - Freeze the skill before running it, and record the skill's content
     hash with the results.

### Harness sanity check

Inspect the **plain condition on workspace members** by hand first. The
harness measures what was intended only if both of these hold:
- That output can pass every functional test using only the shared brief.
- Its design score can be explained without mentioning an asset-library
  filename, a token name, or private reference copy.

If either fails, fix the brief, contract or rubric before trusting any
comparison.

### Later experiments

- **Full harness:** the owner's components and reference screens, against
  the same baselines.
- **Cross-agent:** each agent gets its own plain baseline (same agent and
  model, plain vs. this skill). To see whether the decisions transfer,
  compare which individual principles each agent satisfies with the skill.
  Keep the original three-way Claude experiment for comparison with
  Anthropic's guidance.
- Adding an agent should only need a new adapter. The skill, brief,
  fixtures, renderer and rubric stay the same.

## Status and next steps

**Done:**
- Core v0, reviewed by the owner: principles, ban list, tokens, the skill
  package, and this file.
- Workspace scaffolding:
  - git, pnpm workspace, Vite + React + TS, Storybook, Playwright
  - the token converter, plus token validation and contrast checks
  - lint rules
  - `pnpm check`

- Asset-library eval inputs: the fixtures and mock API, the brief, and the
  shared behavior tests, which pass against the conformance app.

Next:
1. Build these, following the eval protocol:
   - `evals/starter/`: Vite + React + TS, the mock API plugin, the token
     converter, and `upload-files/` plus `replacement-files/` (written with
     `writeUploadFiles` from `evals/fixtures/src/files.ts`)
   - `evals/rubric/`, for the owner to approve
   - the runner and the Claude Code adapter
   - `.claude/agents/reviewer.md`, pointing to the rubric
2. The held-out workspace-members brief, with its fixtures and behavior
   tests. It stays out of the skill.
3. Don't install the skill machine-wide yet. When a real UI repo needs it,
   link `core/design-system` into that agent's skills folder (a directory
   junction on Windows), and confirm that baseline eval runs still can't
   see it.

## Out of scope

Publishing, versioning, governance, multi-framework components, an MCP
server, git submodules.

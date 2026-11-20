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
2. **Implementation** (React + TS), in a separate private repo:
   - `packages/react/`: layout primitives (Stack, Inline, Grid, Container),
     components (React Aria for complex controls), and patterns
   - `apps/playground/`: reference screens, which can own local
     components, plus Storybook

   That repo links to `@ds/tokens`, `@ds/lint` and the skill from a
   checkout of this repo next to it. Nothing from it is copied here.
3. **Harness:**
   - **Checks:** lint raw color and spacing values in product styles, type
     checks, Storybook states, Playwright interaction tests for behavior,
     a11y checks, screenshot baselines.
   - **Evals:** see the eval protocol below.

## Repo layout

pnpm workspace in its own repo. No submodules. The React package and the
playground live in the private repo (see Architecture).

```
AGENTS.md              this file
CLAUDE.md              imports AGENTS.md for Claude Code
README.md              overview for people visiting the repo
CONTRIBUTING.md        how outside contributions work
LICENSE, NOTICE        Apache-2.0 text and the copyright notice
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
packages/lint/         stylelint rule ds/token-values and the
                       Oxlint plugin for product code
evals/fixtures/        asset data, upload batch, mock API and
                       its Vite plugin
evals/briefs/          asset-library.md (held-out brief: not yet)
evals/tests/           shared behavior tests, the contract-only
                       conformance app, and meta tests
evals/starter/         template/ (the blank app every generator
                       gets), src/materialize.ts, which
                       assembles a generator workspace, and
                       src/leaks.ts, the leak-word list
evals/runner/          the agent-independent runner, its
                       screenshots, and prompt.md (the one
                       generator prompt)
evals/adapters/        types.ts (the runner–adapter contract),
                       fake/ and claude-code/
evals/guidance/        pinned third-party skill and its license
evals/results/         one folder per run and mapping.jsonl
                       (gitignored)
evals/rubric/          shared reviewer criteria and scoring rules
.claude/agents/        Claude-only adapters, e.g. reviewer.md,  (not yet)
                       which points to evals/rubric/ and holds
                       no criteria of its own
```

Root configs: `package.json` (scripts), `pnpm-workspace.yaml`,
`tsconfig.base.json`, `.oxlintrc.json`, `stylelint.config.js`.

### Commands

First run:
```
pnpm install
pnpm --filter @ds/eval-tests exec playwright install chromium
```

`pnpm check` is the one check. It runs, in order:
1. token validation and contrast pairs
2. the token CSS build
3. Oxlint and stylelint
4. type checks
5. unit tests and Playwright

Others:
- `node evals/runner/src/cli.ts run --brief asset-library --condition plain --adapter <name>`
  runs one condition end to end. See "Running a condition".
- `pnpm tokens:build` writes `packages/tokens/dist/tokens.css`. The file is
  generated and gitignored, and lint reads it, so build it before linting.
  The private repo's build writes the same file.

### Toolchain notes

- **Node 24 or later** runs the token tooling's TypeScript directly, with no
  build step. Use erasable syntax only: no enums, namespaces or parameter
  properties.
- **TypeScript 7** is the native compiler. Its package has no stable
  JavaScript compiler API, so tools that load `typescript` in-process
  can't run here. typescript-eslint is one: it requires a version below 6.1.
- **pnpm 12** runs install scripts only for packages listed under
  `allowBuilds` in `pnpm-workspace.yaml`, currently just esbuild.
- **Lint**:
  - stylelint's `ds/token-values` checks product CSS against the generated
    token names. It rejects raw colors, lengths, type values, shadows,
    motion values and unknown custom properties, and allows structural
    CSS. This repo has no product CSS, so its run allows empty input.
  - Oxlint runs the JavaScript and TypeScript rules. Its
    `ds/no-inline-style` and `ds/no-raw-color` rules (a JS plugin in
    `packages/lint/`) forbid inline `style` props and raw color literals
    in product code. The private repo enables them, with the React Hooks
    rules, on its components and screens.
  - Oxlint's JS plugin API is alpha and outside semver, so `oxlint` is
    pinned to an exact version. The plugin's tests run in `pnpm check`.
- **Playwright** runs the shared behavior tests in `evals/tests/` and the
  runner's screenshots. Both use the projects in `evals/tests/projects.ts`,
  listed under Scoring.

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
- An approved reference screen is saved in the private repo as:
  - a Storybook story
  - a screenshot baseline
  - a short note on why it looks this way

  Cover desktop and mobile widths, with real copy and no lorem ipsum.

## Eval protocol

### Runner and adapters

- The runner is agent-independent. It owns workspace isolation, fixture
  setup, rendering, anonymization and result recording.
- Agent-specific adapters handle skill discovery or installation, session
  launch and invocation. Each implements `evals/adapters/types.ts`:
  - `fake` copies the conformance app instead of calling a model, so the
    whole pipeline runs inside `pnpm check`.
  - `claude-code` runs Claude Code headless (see "Claude Code isolation").
  - `claude-code-stub` runs the same CLI against a local stub model that
    writes the conformance app. It costs nothing.
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

### The starter

`evals/starter/src/materialize.ts --out <dir>` assembles one generator
workspace. It must be outside this repo for real runs. The workspace gets:

- `template/`: a blank Vite + React + TS app that renders nothing, with no
  styles. Dependencies are pinned exactly and installed from its own
  lockfile.
  - Only the files named in `TEMPLATE_FILES` in `materialize.ts` are
    copied, one by one. Local extras in the template folder (`.env`
    files, build output, OS junk) never reach a workspace.
  - A test keeps `TEMPLATE_FILES` equal to the template's git-tracked
    files, so add any new template file to both.
- `tools/`: the mock API (Vite plugin) and the token converter, copied
  from their single sources (`evals/fixtures/src/`, `packages/tokens/src/`).
  - Generators can read these files, so their comments must stay neutral.
    Don't even note the neutrality rule in the files themselves.
  - The converter's header reads "Generated by the token converter", with
    no internal package names.
- the brief, plus `upload-files/` and `replacement-files/`
- optional design guidance, set with `--guidance-from <dir>` and
  `--guidance-to <dir>`. For my-skill under Claude Code, that's
  `core/design-system` → `.claude/skills/design-system`.
  - It's copied as real files, never links, so nothing points back into
    this checkout.
  - A link inside the guidance that leaves its own tree, or loops back on
    itself, is rejected.

Every input is checked before anything is created:
- `--brief` must be a single brief name from `evals/briefs`, not a path.
- `--guidance-to` must name a folder strictly inside the workspace. The
  workspace root (`.`) is rejected.
- If the guidance contains tokens, they must land where `prepare.ts` will
  find them: at most 4 folders deep, and not inside a skipped folder. A
  destination such as `.claude/plugins/local/skills/design-system` (5
  deep) or `src/design-system` is rejected, so a run can never silently go
  without its tokens.
- After copying, the workspace's own search confirms it finds those tokens.

`pnpm dev` and `pnpm build` run `tools/prepare.ts`:
- If any `tokens.resolver.json` is in the workspace, it writes
  `src/design-tokens.css`. The search lives in `tools/find-tokens.ts`,
  which the materializer also uses. It goes 4 folders deep, follows linked
  folders, and skips `node_modules`, `dist`, `src`, `tools`, the upload
  folders, `.git` and `.vite`.
- Otherwise it removes only a stale file it generated itself, recognized by
  the converter's header. It never touches a file someone else wrote.
- The README tells the app to import the file; it isn't loaded
  automatically.

The mock API logs an upload whose connection closes mid-body as status 499
(`aborted`), instead of leaving it in flight. It isn't counted as an
attempt.

Tests (`pnpm --filter @ds/eval-starter test`):
- **Contents:** a workspace contains exactly the expected files.
- **No leaks:** nothing in a plain workspace has the owner's copy, or
  words that reveal the eval (eval, condition, rubric, generator, SKILL.md
  and others).
- **Tokens:** the token file is generated only when tokens are present.
- **Build:** the blank app installs and builds.
- **Proof:** the conformance app, dropped into a fresh workspace, built,
  and served by that workspace's own `vite preview`, passes the shared
  behavior tests. This proves the starter itself can't make a condition
  fail.
  - A production build, as the runner will use, so no dev-server reload
    can interrupt an upload.
  - The server runs on an OS-assigned port with `--strictPort`, and the
    tests target the URL that this process announces.
  - If that server exits, the proof fails, so concurrent proofs in other
    worktrees can't stand in for it.
- **Guarding the fixes:** each of these has a test:
  - linked guidance and escaping links
  - path-like brief names and a root guidance destination
  - template junk
  - generator-written token CSS
  - `.git` and linked folders in `prepare.ts`
  - a full build with the skill installed
- **Cleanup:** tests and the proof delete their temp workspaces.

### Running a condition

```
node evals/runner/src/cli.ts run --brief asset-library --condition plain \
  --adapter <fake|claude-code-stub|claude-code> [--model <id>] \
  [--effort <level>] [--max-budget-usd <n>] [--timeout-minutes <n>] \
  [--project <name> ...]
```

Conditions are `plain`, `frontend-design`, and `my-skill`. The runner
copies only the assigned guidance into the adapter's project skill
directory. Claude Code discovers it under `.claude/skills/`.
The vendored frontend-design skill and license come from
[Anthropic's pinned plugin revision](https://github.com/anthropics/claude-plugins-official/tree/44490cccaf6d9f82fdeec9416fbf7c9bd72575dc/plugins/frontend-design/skills/frontend-design).
The runner verifies the skill's file hash before each run. A live adapter
needs `--model` (an exact model ID) and
`--max-budget-usd`. `--effort` pins the reasoning effort; without it the
agent's default for the model applies. The manifest records both.

The build isolation backend currently uses macOS `sandbox-exec`. The
runner stops if the backend is unavailable or its toolchain probe fails.

Each run:
1. Checks every input. Then it assembles a workspace with `materialize.ts`
   in a new folder in the OS temp dir:
   - `work-*/app`: the workspace
   - `work-*/shared/notes.txt`: a canary with a random token, just
     outside the workspace
   - `work-*/state/`: the adapter's private state
2. Calls the adapter with `evals/runner/prompt.md`:
   - It's one neutral text for every condition. Only the brief's filename
     is filled in.
   - A test scans it with the starter's leak list (`evals/starter/src/leaks.ts`).
3. Copies all of `src/`, and every other file the generator added or
   changed, into the results. It never edits them. Links are recorded,
   never copied.
4. Runs `pnpm build` with a fresh environment. The OS sandbox allows
   workspace and private build-state writes, reads from the workspace and
   the toolchain, and denies network access. A product build failure is
   recorded for brief completion.
5. Collects the static `dist/` output inside that sandbox. The runner
   serves a snapshot of those files and its canonical mock API on one
   loopback origin. The browser loads resources from that origin. The
   Node-side test code authenticates reset and log requests.
6. Runs the shared behavior tests in all four projects. It saves a JSON
   report and the touch-target evidence.
7. Takes full-page screenshots of the six states in all four projects
   (`evals/runner/screenshots/`), with the clock fixed to the fixtures'
   NOW.
   - A PNG is saved only once its state is confirmed by the mock API's log
     and by what renders.
   - A state that can't be reached is recorded with the reason.
8. Runs the repo's CSS token and product-code lint rules for my-skill.
   Findings describe authored code. The rubric also checks how the
   rendered app uses semantic roles.
9. Writes `manifest.json`, then deletes the temp folder. This happens even
   when a step fails or the run is stopped.

Statuses:
- `complete`: every applicable step ran. The build or tests may still have
  failed.
- `invalid`: an isolation check failed. Nothing was built or scored.
- `error`: the runner itself failed, including when a Playwright command
  produces no report or has a global execution error.

### Results

```
evals/results/            gitignored
  mapping.jsonl           private run ID → brief, condition, adapter, model
  review-<id>.json        private sample alias → run ID for an exported packet
  <run-id>/               12 random hex characters
    manifest.json
    prompt.md             the exact prompt sent
    generation/           the adapter's logs (Claude Code: invocation,
                          transcript, probe and its recorded requests)
    output/               the generator's files, byte for byte
    build-sandbox.log, build.log
    token-lint.json       where the token contract applies and lint ran
    tests/                report.json, output.log, and artifacts/ with
                          touch-targets.json for each mobile project
    screenshots/          <project>/<state>.png and report.json
```

`manifest.json` holds:
- the run ID, brief, condition, adapter, model, limits, and browser projects
- Node, pnpm, Playwright and agent versions
- hashes:
  - skill: a SHA-256 over the assigned skill's sorted files, plus the
    pinned upstream revision when applicable
  - the starter, the brief and the prompt
- step timings
- the isolation report
- generation outcome, usage and cost
- summaries of the output, build, tests and screenshots
- every file, with its size and sha256

### Blinded review

```
node evals/runner/src/cli.ts export-review --out <new-dir> <run-id> ...
```

Export checks that the runs share the brief, starter, prompt, model
settings, limits, versions, and browser projects. It randomizes sample
order and includes the brief, rubric, principles, ban list, screenshots,
test outcomes, and touch measurements. Give reviewers only the exported
directory. Keep the alias key and raw results private until every sample's
visual and behavioral judgments are locked.

### Claude Code isolation

The adapter (`evals/adapters/claude-code/`) runs one `claude --print
--output-format stream-json` session per run, in the workspace, with the
prompt on stdin. The CLI is `claude` on PATH, or `CLAUDE_CODE_BIN`.

- **Fixed:**
  - `--model`, and `--effort` when given
  - `--tools Read,Write,Edit,Glob,Grep,Bash,Skill`: no web tools, no
    subagents
  - `--permission-mode dontAsk`, with allow rules for those tools, and
    `--permission-prompts none`
  - `--max-budget-usd`
- **Not loaded:**
  - The owner's `~/.claude`, `~/.claude.json` and credentials. HOME and
    `CLAUDE_CONFIG_DIR` are fresh folders in the run's private state.
  - Any settings but the workspace's own `.claude/` (for project skills):
    `--setting-sources project`.
  - MCP: `--strict-mcp-config` with no servers, and claude.ai connectors
    off.
  - CLAUDE.md files, auto memory, bundled skills and the built-in plugins.
  - Telemetry and auto-update.
- **Sandboxed:**
  - The file tools are blocked outside the workspace.
  - Bash runs in the OS sandbox. It can't read the owner's home, the
    system temp folder (which holds the canary) or Claude Code's shared
    temp folder (`/tmp/claude-<uid>`, which holds other sessions' files).
  - It can't write outside the workspace, and has no network except local
    ports.
- **Environment:** built from scratch. PATH holds only node, pnpm and
  system folders, so no inherited variable carries the repo path.
- **Auth:** the owner's subscription token from `claude setup-token`.
  - The runner reads `CLAUDE_CODE_OAUTH_TOKEN` from the shell that starts
    it and passes it only to the session.
  - It's never written to the results.
  - *Owner decision, 2026-11-19.*

Some of these switches aren't in the public docs: `CLAUDE_CODE_TMPDIR`,
`CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` and the built-in plugin names. So
before every real session, a **probe** session runs with the same command,
settings and workspace against a local stub model, at no cost.
- The stub makes the probe try to:
  - read the canary and a repo file
  - list the repo, the owner's home and the shared temp folder
  - write outside the workspace
  - reach the network
- Then it runs node and pnpm, reads a workspace file, and invokes the
  assigned skill when present. The probe verifies that the stub receives
  the skill body.
- Every forbidden attempt must fail and every ordinary step must work, or
  the run stops before any model is called.

**Isolation checks.** All are recorded in the manifest. Any failure makes
the run `invalid`.
- **Runner, for every adapter:**
  - The workspace is outside the repo and the results.
  - Its path, the prompt, and every workspace file except the condition's
    guidance carry no leak words, owner copy or repo path.
  - No file the generator wrote carries the canary's token.
- **Init event,** for the probe and the session:
  - the exact model and the fixed tool list
  - no MCP servers and no plugins
  - no skills except the condition's own, plus `doctor`, a user-only
    command the probe confirms the model is never shown
  - the workspace as working directory, dontAsk mode, and the expected
    CLI version
- **First request,** recorded by the stub:
  - The system prompt and messages carry the prompt unchanged.
  - They name no repo, results or `~/.claude` path, and carry no leak
    words or owner copy.
  - Reviewed lines of Claude Code's own system prompt are allowed, in
    `SYSTEM_PROMPT_LINES_ALLOWED` (today only `# Harness`). A new match
    fails until someone reviews it.
- **Transcript:**
  - Every path a tool call read or wrote is inside the workspace. Refused
    attempts are listed, not failed.
  - The canary's token and forbidden paths appear in no tool result.

When Claude Code updates, the probe fails closed on anything new, such as a
plugin, a skill or a system prompt line. Review it before adding it to an
allowlist.

`pnpm check` runs the fake adapter end to end on macOS. With
`CLAUDE_CODE_BIN` set, it also runs all three conditions through the real
CLI against the local stub and verifies the blinded export.

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
  the same baselines. They live in the private repo, so the runner takes a
  path to its checkout.
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
- The eval starter and `materialize.ts`, proven by running the conformance
  app inside a fresh workspace.
- The runner and the Claude Code adapter, with the isolation probe. The
  fake adapter runs the whole pipeline inside `pnpm check`.
- Owner-approved asset-library rubric, pinned frontend-design skill,
  isolated build and trusted preview, blinded export, and token lint.
- The React package and the playground moved to a private repo
  (2026-11-19), before any component or screen was written.

Next:
1. The first real plain run on asset-library, after the owner approves
   the command, model and cost.
2. Add `.claude/agents/reviewer.md` pointing to the approved rubric.
3. The held-out workspace-members brief, with its fixtures and behavior
   tests. It stays out of the skill.
4. Don't install the skill machine-wide yet. The private repo links
   `core/design-system` into its `.claude/skills/design-system`. Link it
   the same way into any other UI repo that needs it (a directory junction
   on Windows), and confirm that baseline eval runs still can't see it.

## Out of scope

Publishing, versioning, governance, multi-framework components, an MCP
server, git submodules.

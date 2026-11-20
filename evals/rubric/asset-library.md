# Asset library rubric

Approved by the owner. Use the [brief](../briefs/asset-library.md),
[principles](../../core/design-system/principles.md), and
[ban list](../../core/design-system/ban-list.md).

## Evidence and reporting

Review each anonymous sample in the supplied random order. Use the same
fixtures, state triggers, and fixed clock from the brief. Check desktop
(1440 × 900) and mobile (390 × 844, touch emulation), each in light and
dark. Read full-page screenshots at viewport scale. For a judgment about
what appears immediately after an action, use a viewport capture or
interaction at that point.

Use state and project labels on screenshots, behavior results, and touch
measurements. Keep run metadata, raw logs, and source out of the visual
and behavioral packet. Lock the visual and behavioral judgments for
every sample before opening theme or implementation evidence for any
sample. Record later ban findings with their evidence alongside the
locked criterion counts.

For each criterion, record **Meets**, **Misses**, or **Unverified**, with
the state, project, and a screenshot detail, test assertion, interaction
observation, or source location. Preserve the verdicts for required
observations within a criterion. Mark the criterion **Misses** if a
required observation establishes a miss, **Unverified** if required
evidence is missing and the observed checks meet, and **Meets** if all
required observations meet.

Report each category verdict with its counts of **Meets**, **Misses**,
and **Unverified**, counting each criterion once. Record **N/A** where
a category does not apply.

- A confirmed ban violation fails its applicable category. Cite the ban
  ID, the evidence, and any applicable exception.
- **Brief completion** fails on any verified failure of a brief
  requirement, including a product build failure. With all requirements
  verified, use **Meets** if they all pass. Use **Unverified** when some
  required evidence is missing and the verified requirements pass.
- **Design fit** fails on a confirmed applicable ban. Use **Unverified**
  when required evidence is missing, including unresolved gradient
  authorization under B3, unless a confirmed ban already fails the
  category. With complete evidence and no confirmed ban, use **Meets**
  if every criterion meets and **Mixed** if any criterion misses. Publish
  the criterion counts and the recovery and selection observations with
  the verdict.
- **Implementation conformance**, where applicable, fails on a verified
  violation of the token contract. Use **Meets** when all applicable
  checks pass and **Unverified** when the verified checks pass and some
  required evidence is missing.

If a capture or test fails, check whether it establishes a product
failure or leaves the criterion unverified.

## Brief completion

Apply the same brief requirements to every sample. Use the shared
Playwright results and their mock API assertions for behavior. Use a
targeted interaction when a brief requirement has no matching assertion.

| Criterion and state | Evidence | Judgment |
| --- | --- | --- |
| Build and screen shell, all states | Build result, rendered states, and a browser check of navigation and OS color preference | The build serves the screen. Assets is the current section and works. Projects and Settings are present. The required states work in all four projects and follow the OS color preference. |
| Browse, populated and large library | `populated`, `pagination`, and `large library` behavior results and API evidence | Real mock assets appear as items exposing their full filenames. Every default asset is reachable. The large library loads in pages, reaches later items, and requests at most 1,000 assets through the first three seconds after rows appear and before interaction, including prefetch. Scrolling and a qualifying More or Next control are both valid. |
| Find, populated, large library, and no results | `search` and `no results` behavior results, plus a fresh large-library interaction and its page request log | The search field finds exactly the two invoices for `invoice`. `invoice-2023` shows zero items and clearing it restores the list. For whole-library coverage, start a fresh large-library session, search for a known filename absent from the pages fetched so far, and verify it appears. Mark that observation **Unverified** until exercised. |
| Upload, empty and partial upload failure | `empty` and `partial failure` behavior results and batch request assertions | Empty begins with zero assets and a single real-byte upload adds its asset. The multiple-file input sends the ten ordinary files once each, successfully and at their real sizes. The interrupted file fails once. The oversized file is rejected in the browser or by the API. |
| Apply a bulk action, multi-select | `multi-select` behavior result and delete request assertions | Select three files through the supported item controls, across pages if needed. Activate the labeled deletion path. The interaction deletes exactly the selected IDs and preserves all other assets. |
| Recover, partial upload failure (P5, P9, B12, B14) | `partial failure`, `transient failure`, and `validation failure` behavior results and recovery request assertions | Each named failed item exposes its own action without hover and has a working Tab and Enter path. The interrupted file's recovery resends only its bytes. The oversized file's action accepts the valid replacement and sends only that replacement at its correct size. No action resubmits the oversized original. Both recoveries clear the corresponding failure and work within one batch in either order. |
| Report progress, partial upload failure and after each recovery (P9) | Upload status and UI assertions in the recovery tests | The named upload status reports 10 of 12 uploaded, then the accurate totals after each recovery. Any other count in the summary is the number still failing. The summary and the other failed item remain available while a failure remains. A valid replacement counts toward the original batch. |

## Design fit

Use visible or interaction evidence for every sample. Apply the principle
IDs below to the asset-library task. Cite a concrete observation about the
state, even when the judgment is favorable.

| Criterion and state | Evidence | Judgment |
| --- | --- | --- |
| Hierarchy, populated and large library (P1, P3, B10, B17, B20) | Desktop opening viewport and mobile counterpart | Name the primary region, its main action group, and the next two things that draw attention. The library reads as the main work and its controls are easy to locate. Each scope has a clear emphasis, with each region weighted for its job. |
| Grouping, populated and partial upload failure (P2, P3, B5, B8, B9) | Screenshots of the page, results, and upload outcome | Name the distinct object or region each visible container represents. The batch outcome reads as a result of the upload, the affected files read as a group, and the library retains its place as the main region. Elevation corresponds to actual layering. |
| Scanning, populated and large library (P4, P8, B7, B11, B18) | Opening viewport, one long filename, a row with a thumbnail and one without, and keyboard focus if the name is truncated | Report the visible item count and cite how filenames and comparable metadata line up. Rows stay compact for scanning. The missing thumbnail preserves alignment, and long names stay within their row and are available in full on focus if shortened. Judge any extra space by the task, readability, or touch. |
| Recovery association, partial upload failure (P1, P3, P5, P6, P9, B17) | Desktop and mobile screenshots with both failures settled and the pointer away from controls | Starting at each failed filename, trace to its specific cause and recovery action. Identify what makes that pairing evident and whether a neighboring action could be mistaken for it. Both recoveries are findable without hover and the controls read as actions for their respective files. |
| Selection scope, populated into multi-select (P1, P3, P5, P6, B17) | The immediate viewport from the selection interaction below, supported by the unselected and selected screenshots | Starting at the selected item, trace to the selected count and the bulk action. Explain what changed and how checked or highlighted items, the count, and the action show which files it affects. Record what the person can find from that viewport. |
| Action access, populated and multi-select (P5, B12) | Keyboard-only and touch interactions with enabled row and bulk controls | Secondary actions are reachable when needed. The person can discover and use them without a mouse hover. Cite the control and the path used. |
| Responsive priority, populated, large library, multi-select, and partial upload failure (P6) | Compare mobile and desktop screenshots of the same state | Name what moves, collapses, or is removed. Filenames, selection, and recovery remain usable on mobile. |
| Touch targets, populated, large library, multi-select, and partial upload failure (P6) | Measured hit areas for each state in mobile light and mobile dark | Interactive hit areas meet 44 × 44 CSS px. Identify any undersized control and cite its measured dimensions. Record coverage as described below. |
| Purposeful emphasis, all states (P7, B18, B19, B22) | Screenshots | Name the information or action conveyed by prominent headings, badges, accent, icons, and illustrations. Their prominence matches their job. If a gradient is visible, record its location and what it draws attention to. |
| State copy, empty, no results, and partial upload failure (P7, P9, B13, B15, B25) | Rendered messages, status, and action labels | Empty communicates that the library has no assets and how to add one. No results communicates that the active search has no matches and how to continue. Each failure names the known cause and gives an action whose label explains what happens next. Cite the wording and check it against P9's voice guidance. Equivalent wording that meets the guidance passes. |
| Visual language, populated, multi-select, and partial upload failure (P1, P8, B1, B4, B5, B7) | Matching light and dark screenshots and the computed font family if needed | Compare reading order, system UI typography, and the appearance of selection, controls, and errors. Record whether the roles remain distinguishable, and cite any misuse observed. |
| Navigation stability, populated, empty, no results, multi-select, and partial upload failure (P10) | Same-project screenshots across states | Navigation keeps its place and visual weight as the library changes state. |
| Motion, selection and upload recovery (P10, B16) | An interaction or recording at regular and reduced motion | Motion explains changes, and reduced motion suppresses nonessential movement. Mark motion **Unverified** when only still images are available. |

### Selection scope

Use the same interaction in every sample and project.

1. Start from a fresh populated library with no selected rows. Scroll the
   asset list until its initial controls leave view, if the layout permits.
   If the controls stay pinned, scroll one viewport or to the end of the
   list, whichever comes first. Record which controls stayed visible.
2. Select a visible row and capture the resulting viewport before scrolling
   again. Record whether the selected state, the count, and the bulk action
   or a cue to find it are visible from that position.

Mark this observation **Unverified** when the interaction was never
observed. Use the full-page multi-select image as supporting evidence of
the group and its scope.

If deletion opens a confirmation dialog, inspect the viewport with the
dialog open. Can the reviewer tell what will be deleted and which action
confirms it, with any visible page content behind the dialog?

### Touch coverage

For each applicable state in mobile light and mobile dark, record the
verdict and which controls were measured. Mark unmeasured controls
**Unverified**. The existing `touch-targets.json` measures the partial
upload failure state in the project named in the report. For multi-select,
include **Delete** and **Clear selection** when present.

### Comparing recovery and selection

For **recovery association**, report one observation per failed filename
and project. Trace the path from `campaign-header.png` to the action that
sends it again, and from `Q3-brand-guidelines-final-v2.pdf` to the action
that lets the person choose a replacement. For **selection scope**,
start where the row was selected and report how the person finds the
count and bulk action. Use these descriptions alongside the criterion
verdict.

- **Direct.** The pairing or selection scope is clear on the first
  reading path. Cite the cue that connects the elements.
- **Extra scan.** The pairing or scope becomes clear after the eye
  crosses a gap, passes another control, or looks to another region.
  Cite where the extra scan happens.
- **Ambiguous.** The reviewer cannot tell which action belongs to a file
  or which items the action applies to, or cannot find the action when
  needed. Cite the competing cue or the point where the path breaks.

Direct and Extra scan can both meet the criterion. Ambiguous misses it.
Consistent alignment, proximity, grouping, and explicit labels can each
establish association. Compare recovery by filename and project, and
selection by project. Include the cue or scan path alongside each
observation, and carry forward any **Unverified** observations.

### Theme evidence

After the blinded judgments for every sample are locked, resolve **B3**
(P7, P8) for each recorded gradient. Compare the locked screenshot
observation with the applicable brand theme. Record **Authorized**,
**Violation**, or **Unverified** and cite the evidence or name what is
missing. Record **N/A** if the reviewed evidence shows no gradient.
Report B3 beside the locked design-fit criterion counts. A confirmed B3
violation fails design fit. An unverified authorization gives design fit
an **Unverified** verdict when no ban has been confirmed. Keep the
recorded visual judgment on emphasis and its count.

## Implementation conformance

Apply this category where the token contract applies. Record **N/A** for
other samples. Use product source, generated CSS, and lint evidence tied
to the reviewed build. If token lint is unavailable, report the uncovered
checks as **Unverified** and record any source-backed findings.

| Criterion and state | Evidence | Judgment |
| --- | --- | --- |
| Semantic values, all states (P8, B1, B2, B5, B11, B16) | Token-value and product-code lint, with file and line inspection for violations and exceptions | Authored type, spacing, sizing, radius, border, elevation, motion, and color use the applicable semantic roles. Generated token definitions and structural layout values are allowed. Verify the rendered interface consumes those roles. |
| Color and modes, populated, multi-select, and partial upload failure (P8, B2, B3, B4, B6) | Product declarations for surfaces, text, primary controls, selected rows, and failure states, plus the resolver and mode definitions | The app loads and consumes the semantic token CSS. Role references match what the declarations communicate. Both modes use their role mappings. Any gradient is defined by the theme. |

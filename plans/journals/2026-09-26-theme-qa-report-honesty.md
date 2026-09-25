# Journal — Theme QA Report Honesty: Stop Certifying What Was Never Measured

Date: 2026-09-26. Scope: `src/main/qa/theme-qa-workflow.ts`, `test/unit/qa-matrix-viewports.test.ts`, `test/unit/theme-qa-fail-closed-adjudication.test.ts`, `test/unit/theme-qa-sanitize-pii.test.ts` (new), `test/main/theme-qa-parity.test.ts`, `scripts/smoke-theme-qa-gate.cjs`, `docs/operations.md`.

## Symptom (user report)

The QA report claimed capabilities the workflow never measured: `checklist.interactions` was just the Haravan HTML static-scan result, the `domSemantics` / `cssModularity` / `interactiveOperability` matrix dimensions were derived from the layout-overflow and Haravan checks, so a storefront could carry a green "interaction" and "DOM semantics" verdict with no interaction probe, no semantic tree and no stylesheet analysis ever run.

Separately, persisted QA artifacts were found to contain invalid JSON: `createdAt` epoch values (13 digits) had run through the phone redactor, turning `1790356373134` into `179[REDACTED_PHONE]`.

## Root cause

1. `validate()` performed `checklist.interactions = hsResult.passed` — one measurement (Liquid/HTML static scan) published under two unrelated capability labels.
2. `computeQaMatrix()` derived `domSemantics` / `cssModularity` / `interactiveOperability` scores from the same foreign measurements, so unmeasured dimensions always carried a number and could never be reported as unmeasured.
3. `sanitizePii()`'s phone pattern `(?:\+?84|0)(?:3|5|7|8|9)[0-9]{8}` had no digit boundaries and matched inside longer numeric fields (proven by calling the exported function directly with a 13-digit epoch).

## What changed

- Single cutover in `theme-qa-workflow.ts`:
  - `ThemeQaChecklist.interactions` is optional and no longer set by `validate()`; `hsCompliant: hsResult.passed` keeps the scan's own label.
  - The enabled-checks filter (line ~1052) only pushes measured booleans; an explicitly enabled but unmeasured check lands in `explicitlyRequestedUnmeasured` (line ~1069) and produces an evidence gap plus `summaryVerdict = 'INCONCLUSIVE'` (lines ~1079–1110) instead of a false PASS or FAIL.
  - `computeQaMatrix()` (lines ~1278–1300) no longer dresses foreign measurements as `domSemantics` / `cssModularity` / `interactiveOperability`: those are `score: null` with explicit "unmeasured" details, except `interactiveOperability`, which stays null unless a caller supplies a real boolean probe result.
  - `sanitizePii()` (lines ~175–183) gained digit boundaries: `(?<!\d)(?:\+?84|0)(?:3|5|7|8|9)[0-9]{8}(?!\d)`.
- `overallScore` aggregates only finite scores and `coverage.measuredDimensions` reports the true count (lines ~1345–1355) — a clean run still scores from its measured dimensions only.
- Tests: +3 cases in `qa-matrix-viewports` (unmeasured dimensions stay null, `measuredDimensions` honest, no grading from the overflow result), +2 fail-closed adjudication cases (16: unmeasured check omitted from a default run keeps PASS; 17: explicitly enabled unmeasured check yields INCONCLUSIVE with 0 critical), a new 3-case `theme-qa-sanitize-pii` suite, one corrected parity assertion (an overflow/HS page must not be reported as an interaction outcome), and the Electron smoke gate now logs `UNMEASURED` and asserts `hsCompliant`.

## Verification

- `npx tsc -p ./` exit 0; `.compiled` artifacts verified newer than their sources for every touched module.
- Scoped suites: 60 tests / 60 pass / 0 fail across `qa-matrix-viewports`, `theme-qa-sanitize-pii`, `theme-qa-fail-closed-adjudication`, `theme-qa-parity`, `theme-qa-fresh-target`, `theme-qa-vertical-slice`.
- `npm run smoke:theme-qa` PASS in real Electron; prints `Interactions check: UNMEASURED` on a page whose Liquid scan fails.
- External-consumer sweep: no consumer outside the touched files reads `checklist.interactions` or assumes a numeric dimension score. `packages/site-clone/src/schemas/qa-matrix.schema.json` already declares every score as `["number", "null"]`; `packages/site-clone/src/qa/dod-validator.ts` filters checklist entries for explicit `false` values, so an absent key is not a failure; `native-tab-host.ts`, `browser-capabilities.ts`, `theme-qa-repair-coordinator.ts` and `renderer/toolbar.ts` read only `summary`/`findings`.
- Adversarial redaction probe (independent): digit lookarounds stop epoch corruption while real `0xxxxxxxxx` / `+84xxxxxxxxx` phones, emails and bearer tokens are still redacted; serialized reports stay parseable. No bypass found.
- Code review: no blockers, no critical/high/medium findings; one low-priority note that the single-key unmeasured check is intentionally not generalized yet.

## Pre-existing red lanes (not caused by this change — for a separate decision)

Reproduced identically at a pristine `HEAD` (`5a774113`) checkout in a temporary worktree, and independently triaged:

- `test:fast` — 4 fail: `native-tab-host-viewport.test.ts` "lays a helper-attached pane out…" (`enforceZOrder` → `TypeError: Right-hand side of 'instanceof' is not an object`, `.compiled/src/main/browser/native-tab-host.js:3337`) and "measures every breakpoint of a background tab…" (`Undoing the emulation must reach the tab… 2 !== 1` at `native-tab-host-viewport.test.js:922`); `canary-evidence-provenance.test.mjs` "reclaims a lock whose live pid now carries a different start token"; `mcp-proxy-emitter.test.mjs` "P6: rotation keeps at most the retained ring…" — both pass in isolation, i.e. order/pid-file dependent.
- `test:main` — 4–5 fail depending on run: `bridge-attachment-dispatch.test.ts:840` (self-heal rebind), `bridge-pairing-queue-concurrency.test.ts:315` (30 s timeout under parallel load; passes in isolation), `phase-02-agent-plane-authority.test.ts:431` (`TabDevToolsHost.sendCdpCommand` reads `isAttached` of an undefined debugger), `render-surface-and-viewport-gates.test.ts:284` (throws `SESSION_STALE` where the test expects `POLICY_DENIED`), and intermittently `resource-stability.test.ts:364`.
- None of these files import `theme-qa-workflow`; `native-tab-host.ts` was last modified at HEAD (after its test's last update), which is consistent with a source/test drift introduced by `5a774113` / `c881e6a3`.

## Known residual risks

- The interaction signal itself is still absent: the report now says "unmeasured" instead of lying, but no probe produces it yet. `interactiveOperability` stays null until a caller supplies a probe result, so the QA matrix reports 5 of 8 dimensions on a clean run.
- `enabledChecks.interactions === true` is the only explicitly-requested-unmeasured key handled by name; a second such key needs the same treatment when added.
- Two foreign worktrees remain registered: `E:/Work/apps/AntiFan-wt-08c4d541`, `E:/Work/apps/AntiFan-wt-0f8c51ca`. The temporary `HEAD` verification worktree was removed and pruned.

## Commit status

NOT committed. The working tree still holds the user's own in-flight changes (`extension/background.js`, `src/renderer/terminal-write-dispatcher.js`) plus telemetry JSONs rewritten by running the lanes, so a commit would need selective staging of the seven files listed under Scope.

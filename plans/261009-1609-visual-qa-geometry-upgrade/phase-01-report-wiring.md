---
title: "Phase 1: Report wiring — width map, checklist"
status: done
---

# Phase 1: Report wiring — width map, checklist

## Goal

The QA report stops contradicting itself: the per-width map reads the host sweep correctly,
widths the integrity scan did not measure say `null` instead of `0`, and `checklist.layout`
agrees with the integrity criticals that already FAIL the verdict.

## Context

- The host sweep `runResponsiveCheck` (`src/main/browser/native-tab-host.ts:15061-15067`) returns
  `breakpoints` keyed by id (`mobile-small`, `mobile-standard`, `tablet-portrait`,
  `tablet-landscape`, `desktop-laptop`); each value has a numeric `width` and
  `hasHorizontalOverflow`. The workflow looks them up by `String(width)` at
  `src/main/qa/theme-qa-workflow.ts:894`, so every lookup misses and every width reports
  `documentOverflow: false`.
- `overflowResult.viewport` is overwritten with the first failing sweep width
  (`theme-qa-workflow.ts:817-838`), so `isActive` at `:896-897` can point at the wrong width.
  The integrity scan's own measured width is `integrityResult.viewport.width`.
- The only consumer of `ThemeQaDetailedFindings.responsive` is the workflow itself (grep of
  `src`, `test`, `packages`, `scripts` for `criticalOverlap` / `findings.responsive`), so making
  its values nullable breaks no caller.
- The CLS witness bug (observer disconnected before delivery) is fixed by the Phase 3 port, whose
  reference scan already reads `observer.takeRecords()`; patching the old script here would be
  deleted one phase later.

## Constraints

- Do not touch the running AntiFan instance: no `npm run compile`, no `npm test`,
  no `npm run verify`, no app or daemon restart. Run tests from source with `npx tsx --test`.

## Files

- Modify `src/main/qa/theme-qa-workflow.ts` (type `ThemeQaDetailedFindings.responsive` at `:81-88`;
  responsive map block at `:878-906`; checklist at `:1189-1192`).
- Modify `test/unit/theme-qa-fail-closed-adjudication.test.ts` (test `10.` at `:754-797`).

## Tasks

### Task 1.1 — Add failing assertions for the width map (red)
- Goal: a test proves the width map is wrong before the fix.
- Target: `test/unit/theme-qa-fail-closed-adjudication.test.ts`, test whose name starts with
  `'10. Responsive overflow without culprits'`.
- Steps:
  1. Directly after the line `assert.strictEqual(report.summary.criticalCount >= 1, true, ...);`
     (currently `:785`) insert:
     ```ts
     assert.strictEqual(report.findings?.responsive?.['768']?.documentOverflow, true, 'Width 768 overflow must reach the per-width map');
     assert.strictEqual(report.findings?.responsive?.['320']?.documentOverflow, false);
     assert.strictEqual(report.findings?.responsive?.['768']?.criticalOverlap, null, 'Width the integrity scan did not measure must be null, not 0');
     ```
- Success criteria: the test file fails, and the failure is the first new assertion.
- Verify: `npx tsx --test test/unit/theme-qa-fail-closed-adjudication.test.ts` exits non-zero and
  its output contains `Width 768 overflow must reach the per-width map`. A passing run here is a
  failure of this task.

### Task 1.2 — Read breakpoints by width; mark unmeasured widths null
- Goal: `findings.responsive` mirrors the host sweep and never fabricates zero counts.
- Target: `src/main/qa/theme-qa-workflow.ts`.
- Steps:
  1. In `ThemeQaDetailedFindings.responsive` (`:81-88`) change the value type to:
     `documentOverflow: boolean | null; criticalOverflow: number | null; criticalOverlap: number | null; criticalClipping: number | null; criticalOcclusion: number | null; criticalOffscreen: number | null;`
  2. Apply the same type to the local `responsiveMap` declaration (`:883-890`).
  3. Replace the loop at `:893-906` with:
     ```ts
     const bpByWidth = new Map<number, Record<string, unknown>>();
     if (responsiveBreakpoints && typeof responsiveBreakpoints === 'object') {
       for (const value of Object.values(responsiveBreakpoints)) {
         if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).width === 'number') {
           bpByWidth.set((value as Record<string, unknown>).width as number, value as Record<string, unknown>);
         }
       }
     }
     const integrityWidth = integrityResult?.measured === true ? integrityResult.viewport.width : undefined;
     for (const w of QA_RESPONSIVE_WIDTHS) {
       const bp = bpByWidth.get(w);
       const docOverflow = bp ? bp.hasHorizontalOverflow === true : null;
       const isIntegrityWidth = integrityWidth === w;
       responsiveMap[String(w)] = {
         documentOverflow: docOverflow,
         criticalOverflow: docOverflow === null ? null : (docOverflow ? 1 : 0),
         criticalOverlap: isIntegrityWidth ? countKind('overlap') : null,
         criticalClipping: isIntegrityWidth ? countKind('clipping') : null,
         criticalOcclusion: isIntegrityWidth ? countKind('occlusion') : null,
         criticalOffscreen: isIntegrityWidth ? countKind('offscreen') + countKind('zero-size') : null,
       };
     }
     ```
  4. Update the comment at `:878-882` to say: integrity counts are `null` for every width other
     than the one the integrity scan measured, and widths the sweep did not return report
     `documentOverflow: null`.
- Success criteria: the three assertions from Task 1.1 pass.
- Verify: `npx tsx --test test/unit/theme-qa-fail-closed-adjudication.test.ts` exits 0 and the
  output contains `# fail 0`.

### Task 1.3 — `checklist.layout` honours integrity criticals
- Goal: `checklist.layout` is `false` whenever an integrity critical exists.
- Target: `test/unit/theme-qa-fail-closed-adjudication.test.ts`, then
  `src/main/qa/theme-qa-workflow.ts:1190`.
- Steps:
  1. In the test file, import `LayoutIntegrityEngine` from
     `'../../src/main/qa/scanners/layout-integrity-engine'` and add, directly after test `10.`:
     ```ts
     it('10b. Integrity criticals clear checklist.layout', async () => {
       const integrityScript = LayoutIntegrityEngine.getBrowserScanScript('active');
       const base = createMockPorts();
       const ports = createMockPorts({
         eval: async (target, script) => script === integrityScript
           ? { measured: true, viewport: { name: 'active', width: 1440, height: 900 }, findings: [{ kind: 'overlap', severity: 'critical', selector: 'h3', details: 'Text "a" is painted over text "b"' }] }
           : base.browser.eval(target, script),
       });
       const report = await new ThemeQaWorkflow(ports).validate({
         runId: 'run-integrity-layout',
         attemptId: 'att-integrity-layout',
         workspaceRoot: 'E:/Work/test-theme',
         target: makeTarget(1),
       });
       assert.strictEqual(report.checklist.layout, false, 'Integrity critical must clear checklist.layout');
       assert.strictEqual(report.summary.verdict, 'FAIL');
       assert.strictEqual(report.findings?.responsive?.['1440']?.criticalOverlap, 1);
       assert.strictEqual(report.findings?.responsive?.['375']?.criticalOverlap, null);
     });
     ```
     The workflow evaluates exactly `LayoutIntegrityEngine.getBrowserScanScript('active')`
     (`theme-qa-workflow.ts:854`), so the equality check routes only the integrity scan.
  2. Run `npx tsx --test test/unit/theme-qa-fail-closed-adjudication.test.ts`: it must exit
     non-zero with `Integrity critical must clear checklist.layout` in the output (red).
  3. In the workflow, change `layout: !overflowResult.hasOverflow,` to
     `layout: !overflowResult.hasOverflow && integrityCriticals.length === 0,`.
     (`integrityCriticals` is declared at `:873`, before the checklist.)
- Success criteria: `10b` fails at step 2 and passes after step 3; every other test in the file
  still passes.
- Verify: `npx tsx --test test/unit/theme-qa-fail-closed-adjudication.test.ts` exits 0 with
  `# fail 0`, and the output lists `10b. Integrity criticals clear checklist.layout` as passing.

## Phase exit

- Verify: `npx tsx --test test/unit/theme-qa-fail-closed-adjudication.test.ts` exits 0 and
  `npm run typecheck` exits 0.

## Failure Protocol
If any Verify step does not meet its stated pass condition, STOP this phase.
Do not improvise a fix, retry blindly, or reason around the failure.
Spawn the `kongming` subagent for next-step counsel and pass:
- the phase and task id,
- what you attempted (the steps you ran),
- the exact command and its full output,
- the pass condition it failed to meet.
Apply kongming's guidance, then re-run the Verify step.
If `kongming` cannot be spawned in this environment, STOP and report the same
failure evidence to the user. Never continue by self-reasoning.

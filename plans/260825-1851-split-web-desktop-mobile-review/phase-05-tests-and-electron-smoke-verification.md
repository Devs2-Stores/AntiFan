---
title: "Phase 5: Tests and Electron smoke verification"
status: completed
---

# Phase 5: Tests and Electron smoke verification

## Overview

Prove the split contract at pure-state, host-lifecycle, integration, and real Electron runtime levels. Do not treat TypeScript compilation as evidence that paired native views work.

## Requirements

- [x] Add focused unit tests for split state transitions, URL canonicalization, transaction loop guards, duplicate/stale event handling, authority/mirror failure envelopes, legacy persistence migration, malformed-record fallback, and transient-state exclusion.
- [x] Add geometry tests for responsive mode, desktop/mobile presets, differing aspect ratios, narrow/zero available bounds, gap/centering, shared logical zoom handling, and CSS viewport dimensions versus rendered bounds.
- [x] Extend NativeTabHost lifecycle tests for two-view creation, attach/remove ordering, listener disposal, toggle-off restoration, close cleanup, crash/load failure, non-activating restore, and no orphaned split records.
- [x] Extend BrowserControlPort/capability tests for focused-pane default, internal pane selection, stale logical document generation, missing pane, screenshot/DOM/agent routing, and unchanged single-view behavior.
- [x] Add an Electron integration/smoke harness or script using a deterministic local fixture page. Exercise cookie/localStorage sharing, independent inputs/forms/scroll/focus, same-URL navigation, back/forward/reload, duplicate-event suppression, resize, inspect/screenshot/DOM/agent targeting, persistence restore, security guards, and toggle/close cleanup.
- [x] Run the repository gates in order: focused compiled tests, `npm run typecheck`, `npm test`, `npm run verify`, then the split integration/smoke command. Record the exact command and result in the implementation report.

## Implementation Steps

1. Build pure helper tests first so geometry and transaction behavior are deterministic without Electron.
2. Add host tests using the existing `Object.create(NativeTabHost.prototype)` seam or a narrowly scoped fake Electron view; assert observable lifecycle behavior, not private source text.
3. Run the real Electron fixture smoke test on Windows/Electron 43. Capture raw failures for unavailable APIs, focus routing, session sharing, security guard regressions, or platform-specific bounds behavior.
4. If runtime disproves an Electron API assumption, stop at the failing contract, revise the affected phase, and do not mask it with retries or a screenshot-only fallback.
5. Review the final diff for public contract compatibility, persisted schema safety, helper/refactor overlap, one-generation BrowserTarget semantics, non-activating restore, and process cleanup before marking the plan complete.

## Todo

- [x] Add pure state/geometry and persistence tests.
- [x] Add host lifecycle and target-routing tests.
- [x] Run Electron fixture smoke and repository verification gates.
- [x] Review risks, docs impact, and final acceptance criteria.

## Success Criteria

All focused and repository tests pass; the real Electron smoke run proves the end-to-end split behavior and cleanup; failures are either fixed at their mechanism or explicitly recorded as a blocked runtime prerequisite. No test relies on fake screenshots, cloned state, or weakened assertions.

---
phase: 1
title: "Preflight Audit & Baseline Inventory"
status: in-progress
priority: P1
effort: "30m"
dependencies: []
---

# Phase 1: Preflight Audit & Baseline Inventory

## Overview
Ground the current codebase against HEAD `8a0d893` and verify baseline invariants across capability transport, scheduler policy, security web preferences, and test runners.

## Requirements
- Enumerate all affected files and exported symbol callsites.
- Verify existing test suites pass cleanly before introducing surgical mutations.
- Confirm zero untracked git mutations conflict with the hardening surface.

## Architecture
```text
HEAD 8a0d893
  ├─ capability-transport.ts (Step 6 Context Packager)
  ├─ browser-capabilities.ts (Browser Policy Registration)
  ├─ workflow-engine.ts (Child Step Intent Generator)
  ├─ security-policy.ts (WebPreferences Context Isolation)
  └─ soak-test.test.ts (E2E Test Definition)
```

## Related Code Files
- Inspect: `src/main/tools/capability-transport.ts`
- Inspect: `src/main/tools/browser-capabilities.ts`
- Inspect: `src/main/workflow/workflow-engine.ts`
- Inspect: `src/main/security/security-policy.ts`
- Inspect: `test/e2e/soak-test.test.ts`

## Implementation Steps
1. Run `npx tsc -p .` and `npm test` to capture baseline green state.
2. Confirm clean working tree on `main` branch.
3. Validate audit findings against live lines in inspected files.

## Success Criteria
- [ ] Baseline compilation exits with code 0.
- [ ] Target line ranges mapped and confirmed in context.

## Risk Assessment
- Risk: Baseline test failure due to external state.
- Mitigation: Inspect local port bindings and temporary directories before execution.

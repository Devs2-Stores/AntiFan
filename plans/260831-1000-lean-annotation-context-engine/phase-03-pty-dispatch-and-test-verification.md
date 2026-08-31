---
phase: 3
title: "PTY Terminal Dispatch & Comprehensive Test Verification"
status: pending
priority: P1
effort: "1h"
dependencies: ["phase-2"]
---

# Phase 3: PTY Terminal Dispatch & Comprehensive Test Verification

## Overview
Ensure PTY terminal command generation cleanly references the markdown and target image artifacts without polluted prefix repetition, and write unit tests to benchmark the new slim markdown size (< 1.5KB) and regression-test element picker resolution.

## Requirements
- Format prompt dispatch string in `native-tab-host.ts`:
  `/queue <userComment> @.antifan/annotations/<id>.md @.antifan/snapshots/<id>_target.png`
- Do not append unverified `@path/to/source.liquid` to the terminal command (keep as a heuristic hint in markdown).
- Update unit tests in `test/main/element-picker-resolution.test.ts` to assert `contract_version: "3.2.0-lean"` and verify generated markdown size.

## Architecture
```
[User clicks Send in Modal]
          │
          ▼
[NativeTabHost.startInspect / stopInspect]
          │
          ▼
[TerminalManager PTY Stream]
  └── Dispatches: `/queue <prompt> @.antifan/annotations/<id>.md @.antifan/snapshots/<id>_target.png`
```

## Related Code Files
- Modify: `src/main/browser/native-tab-host.ts`
- Modify: `test/main/element-picker-resolution.test.ts`

## Implementation Steps
1. In `native-tab-host.ts`, ensure prompt formatting adheres to the clean dispatch rule.
2. In `test/main/element-picker-resolution.test.ts`:
   - Update version checks to `'3.2.0-lean'`.
   - Add size assertion: `assert.ok(content.length < 2500, 'Markdown should be under 2.5KB')`.
   - Add assertion verifying `ACTIVE_CSS_PROPERTIES` filtering.
3. Run test suite: `npm test`.

## Success Criteria
- [ ] 100% tests passing in `npm test`.
- [ ] Generated markdown size is rigorously verified under automated testing.
- [ ] No regression on carousel canonical resolution or multi-docking.

## Risk Assessment
- **Risk:** Path formatting mismatch between Windows backslash and POSIX forward slash in terminal `@path` tags.
- **Mitigation:** Use `normalizeTerminalPath` helper to always produce forward slashes for terminal agent compatibility.

---
phase: 3
title: "Production Packaging & Release Certification"
status: completed
priority: P2
effort: "4h"
dependencies: [1, 2]
---

# Phase 3: Production Packaging & Release Certification

## Overview
Perform project-wide test convergence, package the standalone Windows binary via `npm run package`, verify packaged executable startup, and certify the final production release with an updated audit register.

## Requirements
- Functional: `npm run package` must build clean production binaries without bundling errors or missing dependencies, outputting to the artifacts directory configured in `scripts/package-windows.mjs`.
- Functional: Standalone packaged executable (`antifan-browser-desktop.exe`) must boot successfully and initialize NativeTabHost.
- Test Convergence: Run official compiled test suites (`npm run compile && npm run test:fast && npm run test:site-clone && node --test .compiled/test/main/mutation-routing-enforcement.test.js .compiled/test/main/behavior-verification-core.test.js`).
- Documentation: Update audit register with the certified release HEAD signature and test pass telemetry.

## Architecture
- Electron Packager compilation via `scripts/package-windows.mjs`.
- Binary signature verification and asset staging integrity checks.
- Audit register certification linking the verified git commits.

## Related Code Files
- Read/Execute: `scripts/package-windows.mjs`, `package.json`
- Target: Packaged directory output by `scripts/package-windows.mjs`
- Documentation: `plans/reports/260903-production-certification-final.md`

## Implementation Steps
1. Run full TypeScript compilation across workspace:
   `npm run typecheck` and `npm run typecheck:site-clone`.
2. Compile TypeScript tests:
   `npm run compile`.
3. Run official test suites:
   `npm run test:fast`, `npm run test:site-clone`, and compiled main regression tests.
4. Execute production packaging:
   `node scripts/package-windows.mjs`.
5. Verify packaged executable existence and integrity (`antifan-browser-desktop.exe`).
6. Run smoke verification on the packaged executable via `node scripts/smoke-packaged-theme-developer.cjs`.
7. Write final certification report in `plans/reports/260903-production-certification-final.md`.

## Success Criteria
- [x] Zero TypeScript errors across root and `@antifan/site-clone`.
- [x] 100% test pass rate across official suites.
- [x] Windows packaged distribution created successfully with all required assets.
- [x] Packaged application smoke test completes with code 0.
- [x] Release certified and documented with git commit signature.

## Risk Assessment
- *Risk:* Binary packaging size exceeds target budget.
- *Mitigation:* Verify `electron-packager` ignore rules exclude `plans/`, `.tmp*`, and build caches.

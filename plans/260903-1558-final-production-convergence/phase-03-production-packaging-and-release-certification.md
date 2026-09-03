---
phase: 3
title: "Production Packaging & Release Certification"
status: pending
priority: P2
effort: "4h"
dependencies: [1, 2]
---

# Phase 3: Production Packaging & Release Certification

## Overview
Perform project-wide test convergence, package the standalone Windows binary via `npm run package`, and certify the final production release with an updated audit register.

## Requirements
- Functional: `npm run package` must build clean production binaries in `dist/` without bundling errors or missing dependencies.
- Functional: Standalone executable starts cleanly, renders split review pane, and loads MCP capabilities without developer flags.
- Documentation: Update audit register and documentation with the certified release HEAD signature and test pass telemetry.

## Architecture
- Electron Packager / Builder compilation via `scripts/package-windows.mjs`.
- Binary signature verification and asset staging integrity checks.
- Audit register certification linking the verified git commits.

## Related Code Files
- Read/Execute: `scripts/package-windows.mjs`, `package.json`
- Target: `dist/AntiFan-win32-x64/`
- Documentation: `docs/audit-certification-head.md` (or audit register)

## Implementation Steps
1. Run full typecheck: `npm run typecheck` and `npm run typecheck:site-clone`.
2. Run full fast test suite: `npm run test:fast`.
3. Run site clone test suite: `npm run test:site-clone`.
4. Run integration tests: `npx ts-node --transpile-only test/main/mutation-routing-enforcement.test.ts` and `test/main/behavior-verification-core.test.ts`.
5. Execute production packaging: `npm run package`.
6. Smoke test packaged binary startup via `npm run smoke:native-messaging` or equivalent.
7. Record final audit certification report.

## Success Criteria
- [ ] Zero TypeScript errors across root and `@antifan/site-clone`.
- [ ] 100% test pass rate across all suites.
- [ ] Windows packaged distribution created successfully.
- [ ] Release certified and documented with git commit signature.

## Risk Assessment
- *Risk:* Binary packaging size exceeds target budget.
- *Mitigation:* Verify `electron-packager` ignore rules exclude `plans/`, `.tmp*`, and build caches.

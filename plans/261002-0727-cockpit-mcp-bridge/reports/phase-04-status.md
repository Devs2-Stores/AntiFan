# Phase 4 — E2E Verification Status

## Automated gates — GREEN (2026-10-02 ~17:10)

| Gate | Result |
|---|---|
| `npm run compile` | clean, `.compiled` fresh, toolbar.js carries `ThemeChecklistShared` prelude |
| `npx tsc -p tsconfig.json --noEmit` | 0 errors project-wide |
| `scripts/check-mcp-budget-dominance.mjs` | OK — 138 advertised vs 258 registered, parity with `recordingCockpitPort` stub |
| `test/main/theme-checklist-store.test.js` | 17/17 pass (CAS, interleave F6, caps, provisional, corrupt, sweep, deep-copy) |
| `test/main/theme-mcp-capabilities.test.js` | 19/19 incl. 8 new cockpit cases (SCOPE_MISMATCH, INVALID_ARGUMENT, ROUTE_UNRESOLVED, TARGET_REQUIRED, bound-tab scan) |
| `test/main/chrome-ipc-routes.test.js` | our criteria pass; 2 fails are **pre-existing unrelated**: `pet-preload.ts` (untracked user feature) missing push/route rows; route count updated 120→123 for LOAD/SAVE/SHOW_MENU_BAR |

## Known incident fixed this session (blocker, resolved)

`HEALTH_PID_DEAD` / 4001 chain: bare `whoami` PATH-shadowed by `Git\usr\bin\whoami.exe` → `resolveCurrentUserSid` threw → every DACL'd write failed → `persistQueued` wedged on rejected promise → `bridge-dev.json`/`bridge-auth.json` froze on dead pid. Fixed:
- `windows-acl.ts`: pinned `System32\whoami.exe` (smoke: SID VALID)
- `bridge-server.ts`: `persistQueued` clears on rejection; `bridgeInfoPayload()` inside try (no silent throws)
- Verified: pid 15344 records live, MCP `tabs.list` returns 9 tabs, 16/16 windows-acl tests pass.

## Pending — live E2E (waiting app restart for new bundle)

- [ ] `cockpit_mark` flips checkbox live (broadcast repaint)
- [ ] `cockpit_scan {page}` bound≠active tab navigation + THEME_QA_STATE findings
- [ ] Migration union + boot sweep on real localStorage
- [ ] XSS inert render
- [ ] Provisional unknown-workspace no-disk
- [ ] ATTACHMENT_REQUIRED / SCOPE_MISMATCH live
- [ ] Report parity vs 📋 Báo Cáo
- [ ] Reload survival

## Ultra audit repair wave — COMPLETE (2026-10-02)

Verifier verdict was CONDITIONAL GO (22/22 claims validated, `agent://AuditVerifier`); the condition was repairing the defects the audit proved. All landed and re-verified:

| Finding | Fix | File |
|---|---|---|
| A | `baseUpdatedAt` moved inside `checklistSaveChain` — CAS base read at execution, not enqueue; two rapid mutations no longer self-conflict | `src/renderer/toolbar.ts` |
| B | `workspaceRoot` confined to the active tab's resolved root inside THEME_CHECKLIST_LOAD/SAVE routes; unresolvable host root fails closed to `''` | `src/main/browser/native-tab-host.ts` |
| C | `runThemeQa` fails closed when no root resolves (no pass-through) | `src/main/browser/native-tab-host.ts` |
| D | `cockpit_scan` throws `NAVIGATION_FAILED` when `navigateAndWait` returns false; new error code registered | `src/main/tools/cockpit-capabilities.ts`, `src/shared/control-plane-contracts.ts` |
| E | `resolveScope` memoizes origin only; `workspaceRoot` re-resolved every call; provisional identities never memoized; dead tabs self-release memo | `src/main/tools/cockpit-port.ts` |
| F | `checklistIpcUnavailable` latches only on missing API surface — thrown load/save degrades once, never wedges the bridge | `src/renderer/toolbar.ts` |
| G/H | Legacy keys deleted only after the union persists; provisional scopes never delete keys; conflict folds winner∪legacy and retries once; `done` overlay gated on `existed` | `src/renderer/toolbar.ts` |
| I | `setScopeCas` + provisional twin fail closed: existing record + absent/NaN/stale base → `conflict:true` | `src/main/qa/theme-checklist-store.ts`, `native-tab-host.ts` |
| M | `standalone.*` restored to `filesToCopy`; missing sources throw; new `scripts/check-renderer-assets.mjs` gate wired into `npm run compile` | `scripts/copy-static.mjs`, `package.json` |
| R | Load/save adoption guarded `>=` — a mid-flight push can no longer be rolled back by a stale response | `src/renderer/toolbar.ts` |

Test repairs (AU1–AU12): jsdom bridge stub extended (CAS records, deferred loads/saves, push injection); NAVIGATION_FAILED red→green; route-harness confinement cases; store CAS contract relabelled; new `test/main/cockpit-port.test.ts` (4 memo-contract tests). Suite: **72/72 pass** across the five touched files; `tsc --noEmit` clean; asset gate green.

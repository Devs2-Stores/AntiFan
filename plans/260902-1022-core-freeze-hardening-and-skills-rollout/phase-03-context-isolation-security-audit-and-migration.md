---
phase: 3
title: "Context Isolation Security Audit & Probe"
status: pending
priority: P1
effort: "1h"
dependencies: [2]
---

# Phase 3: Context Isolation Security Audit & Probe

## Overview
Perform a deep security audit and empirical probe of `contextIsolation` in `getSecureWebPreferences()` (`src/main/security/security-policy.ts`). Assess the compatibility of enabling `contextIsolation: true` against `tab-preload.ts`, `element-picker.ts`, `ruler.ts`, and IPC communication.

## Requirements
- Inspect `tab-preload.ts` and ensure DOM bridges / `contextBridge.exposeInMainWorld` or isolated preload contexts work without prototype pollution.
- Verify whether `contextIsolation: true` breaks any existing toolbar, element picker, font finder, or theme QA scanners.
- If compatible, migrate `contextIsolation: true` in `security-policy.ts` and update `test/main/security-policy.test.ts`. If blocked by legacy architectural constraints, document the exact boundary invariant as a tracked decision.

## Architecture
```text
Electron WebPreferences:
  contextIsolation: true (Default Electron Security Best Practice)
    ├─ Main World (Untrusted Storefront Web Content)
    └─ Isolated World (Preload Scripts + AntiFan Bridge)
        └─ contextBridge / IPC dispatch
```

## Related Code Files
- Inspect/Modify: `src/main/security/security-policy.ts`
- Inspect: `src/main/preload/tab-preload.ts`
- Inspect: `src/main/preload/standalone-preload.ts`
- Modify: `test/main/security-policy.test.ts`

## Implementation Steps
1. Read `src/main/security/security-policy.ts` lines 100-160 and `src/main/preload/tab-preload.ts`.
2. Analyze all `window.__antifan*` globals injected by preload scripts.
3. Test setting `contextIsolation: true` in `security-policy.ts` and run full E2E / Chromium smoke suite (`npm run smoke:theme` and `npm run test:e2e`).
4. Update `security-policy.test.ts` to assert the verified security posture.

## Success Criteria
- [ ] Security audit completed with concrete telemetry.
- [ ] `contextIsolation` invariant verified against live storefront DOM interaction.
- [ ] No regressions across split-review, element picker, and Theme QA scanners.

## Risk Assessment
- Risk: Injected UI scripts (`ruler.ts`, `element-picker.ts`) failing if executed in isolated worlds without main-world DOM access.
- Mitigation: Chromium `WebContents.executeJavaScript` natively runs in the main world unless specified; verify script injection paths.

---
phase: 1
title: "Canonical Ownership & Transient Lifetime"
status: pending
priority: P0
effort: "1-1.5d"
dependencies: []
---

# Phase 1: Canonical Ownership & Transient Lifetime

## Overview

Eliminate split-brain terminal state and prevent Agent Plane resources from entering user persistence or implicit terminal affinity.

## Requirements

- Functional: One Main-owned `TerminalManager` instance serves UI IPC, Bridge, NativeTabHost, control-plane capabilities, and theme transactions.
- Functional: `offscreen` or `ephemeral` tabs are filtered before persistence serialization and never restored.
- Functional: Agent tabs do not adopt the active terminal automatically; ownership/affinity is explicit.
- Non-functional: No fallback constructor or shadow singleton; existing user terminal restoration remains compatible.

## Architecture

`src/main/index.ts` owns construction. `ControlPlaneRuntime` receives the canonical manager through required constructor options. User-visible `tabOrder`, recently-closed state, keyboard tab traversal, and bulk-close operate only on user tabs; agent tabs stay in the internal tab registry for exact lookup but never become UI navigation candidates. `NativeTabHost.persistTabs()` classifies transient state before `sanitizeTabForPersistence()`.

## Related Code Files

- Modify: `src/main/index.ts`
- Modify: `src/main/control-plane/control-plane-runtime.ts`
- Modify: `src/main/browser/terminal-manager.ts`
- Modify: `src/main/browser/native-tab-host.ts`
- Modify: `src/main/bridge/bridge-server.ts`
- Modify: `src/main/browser/tab-devtools-host.ts`
- Modify: `src/main/browser/app-menu.ts`
- Modify: `src/main/browser/split-review-coordinator.ts`
- Modify: affected bootstrap and terminal tests under `test/main/`
- Delete: obsolete direct `new TerminalManager()` construction outside the composition root

## Implementation Steps

1. Enumerate all `TerminalManager` constructors, `getInstance()` consumers, persistence writers, and event subscribers; define the composition-root contract.
2. Make `ControlPlaneRuntime` require the canonical manager and register terminal capabilities against that instance.
3. Ensure static access, if retained temporarily inside Main, returns the already-created canonical instance and cannot instantiate a second owner; migrate all reachable callers in this phase.
4. Structurally exclude offscreen/ephemeral tabs from user-visible `tabOrder`, `getTabList()`, recently-closed history, keyboard traversal, fallback activation, and bulk-close actions while retaining exact internal lookup.
5. Add persistence eligibility check before sanitization and exclude transient `activeTabId`/terminal-affinity records.
6. Ensure restore logic defensively ignores historical transient records when flags exist; never guess unflagged user state.
7. Exclude offscreen/ephemeral creation from implicit active-terminal adoption; preserve explicit affinity only.
8. Add behavior tests for shared terminal visibility, single persistence writer, transient exclusion, restart non-restoration, and explicit-only affinity.
9. Run focused tests and a reproducible runtime probe: UI-created terminal is writable through capability transport and closure is observed by both surfaces.

## Success Criteria

- [ ] Exactly one terminal session registry and persistence writer exist at runtime.
- [ ] UI-created and capability-created terminal operations address the same session identity.
- [ ] Saved tab state contains user tabs only when user and agent tabs coexist.
- [ ] Restart restores no offscreen/ephemeral tab.
- [ ] Agent tab creation never binds the active terminal without explicit affinity.
- [ ] Existing user tab and terminal restoration behavior remains intact.

## Risk Assessment

- **Singleton migration order:** a consumer may initialize before the canonical manager. Signal: constructor/startup test throws or an empty terminal list appears in one surface. Response: move construction earlier in `index.ts`; do not add lazy fallback construction.
- **Historical persistence ambiguity:** old entries may have already lost transient flags. Signal: restart restores unexpected blank tabs from existing files. Response: create a one-time evidence-backed migration only if a stable discriminator exists; otherwise do not guess and delete user state.
- **Cleanup coupling:** closing one owner may close another session's tab. Signal: two-session lifecycle test observes cross-close. Response: key cleanup by exact attachment/session owner and fail closed on missing ownership.

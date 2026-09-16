---
phase: 4
title: "DOM Raycast & IssueRegister Remediation"
status: pending
priority: P1
effort: "1-2d"
dependencies: [3]
---

# Phase 4: DOM Raycast & IssueRegister Remediation

## Overview

Resolve all 87 open IssueRegister issues: occlusion-aware raycast interaction with modal auto-dismiss (63), full multi-touch pointer lifecycle for mobile drawers (16), font/asset settle gate for layout parity (4), and retry-with-settle for transient network glitches (4).

## Requirements

- Functional: `anti.agent.cursor.type/click` succeeds through dismissible overlays; mobile drawer toggles open under touch emulation; hero-section parity waits for fonts/images; transient network errors retry.
- Non-functional: max 2 auto-dismiss attempts; containment guard prevents closing dialogs that own the target; opt-out flag per session.

## Architecture

**Metaphor: game-engine raycast & collision — with containment rules.** `document.elementFromPoint` is the broadphase raycast. A covering node matching overlay selectors triggers a collision interrupt → auto-dismiss → reflow wait → re-cast. **Critical guard**: if the target element is *inside* the covering node (auth modal, checkout form, confirmation dialog), the overlay is the legitimate container — do NOT dismiss; dispatch into it instead. Global `Escape` is a last resort and never fires when the target is contained in the overlay. Non-dismissible overlays or `type` actions use deep-piercing dispatch (direct focus + `beforeinput`/native setter/`input`/`change`).

## Related Code Files

- Modify: `src/main/browser/semantic-ref-executor.ts` (~627-637 `resolveInputReceiver`/TARGET_OBSCURED; ~650-660 mouse-only dispatch)
- Modify: `src/main/browser/tab-automation-host.ts` (~925 `deltaY` default; touch lifecycle helpers)
- Modify: `src/main/session/issue-register.ts` (reconcile 87 records → RESOLVED with evidence refs; dedupe identical `toolName`+`errorMessage`)
- Create: `test/unit/semantic-ref-occlusion.test.mjs`, `test/unit/touch-lifecycle.test.mjs`

## Implementation Steps

1. **Containment check first**: on `TARGET_OBSCURED`, if `coveringNode.contains(targetElement)` → skip dismissal entirely, dispatch into the overlay (the modal IS the interaction surface).
2. **Raycast auto-dismiss** (only when target is NOT contained): covering node matches `[aria-modal="true"]`, `.modal`, `.popup`, `.cookie-banner`, `[class*="overlay"]`, `[class*="backdrop"]` → find dismiss control (`[aria-label="Close"]`, `.modal-close`, `.close-btn`, `button:has(.fa-times)`) → click → 150ms reflow → re-cast. No control → `Escape` keydown (scoped: only when no editable element has focus). Cap 2 attempts → step 3.
3. **Deep-piercing dispatch**: for `type` and non-dismissible overlays — `targetElement.focus()` + native value setter + `beforeinput`/`input`/`change`. Programmatic typing never required pointer traversal.
4. **Opt-out**: `session.noAutoDismiss = true` flag (per tab/session) disables steps 1-2; piercing dispatch still allowed for `type`.
5. **Multi-touch lifecycle**: on mobile viewport/preset — `pointerover → pointerenter → pointerdown(touch) → touchstart → touchend → pointerup → click`, `isPrimary`, `pointerType:'touch'`, 44×44px target dilation; check `defaultPrevented` before `click`.
6. **Frustum & asset settle gate** (theme.qa parity): `await document.fonts.ready`, `img.decode()` on visible images, zero `getBoundingClientRect` delta across 2 animation frames before compare.
7. **Network resilience**: 3-attempt exponential retry with settle verification on CDP/asset assertions.
8. **IssueRegister reconciliation**: mark 87 records RESOLVED with evidence refs after verification; dedupe future identical records.

## Success Criteria

- [ ] `node --test --test-force-exit .compiled/test/unit/semantic-ref-occlusion.test.js` — type/click through dismissible modal; contained target NOT dismissed; piercing fallback works
- [ ] `node --test --test-force-exit .compiled/test/unit/touch-lifecycle.test.js` — drawer opens under `phone-iphone14pro` with full touch sequence
- [ ] Live smoke: storefront QA scenario → 0 new `TARGET_OBSCURED`/`MENU_INOPERATIVE`
- [ ] `issue-register.jsonl`: 87 records → RESOLVED; `npm run typecheck` clean

## Risk Assessment

- **Auto-dismiss closes a needed dialog**: containment guard (step 1) is the primary defense; selector list requires `aria-modal`/backdrop class; every dismissal logged to lifecycle journal. Signal it broke: legitimate dialogs auto-closed → narrow selectors, require both `aria-modal` AND backdrop.
- **Touch lifecycle double-fires**: `touchend`→`click` mirrors real browsers; guard via `defaultPrevented`.
- **Mutation-loop circuit breaker**: >5 DOM mutations/sec after dismiss → disable auto-dismiss for that tab, fall back to manual.

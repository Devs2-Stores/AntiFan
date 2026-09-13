# Multi-Viewport Verification & Acceptance Reporting Reference

## 1. Multi-Viewport Standards Matrix
Clone surfaces must be audited against 3 standard responsive breakpoints:
1. **Desktop Viewport**: 1440 × 900 (DPR 1).
2. **Tablet Viewport**: 1024 × 768 (DPR 1).
3. **Mobile Viewport**: 390 × 844 (DPR 3, mobile: true).

---

## 2. Quiescence & Media Freeze Protocol
To prevent visual diff flakiness and `IMAGE_IDENTITY_UNSTABLE` errors during screenshot capture:
1. **Freeze Motion**:
   ```typescript
   await anti.media.freeze({ freeze: true, normalizeSliders: true });
   ```
2. **Capture Evidence**:
   ```typescript
   await anti.screenshot.viewport({ format: 'png' });
   ```
3. **Restore Motion (Mandatory)**:
   ```typescript
   await anti.media.freeze({ freeze: false });
   ```

---

## 3. Telemetry Pass Criteria
A surface achieves `VERIFIED` status only if all criteria are satisfied:
1. **Zero Remote Dependencies**: Remote image count $= 0$ (all images served from `/assets/`).
2. **Zero Broken Images**: `brokenImgs.length === 0` (`naturalWidth > 0` for all images).
3. **Zero SVG Skeleton Loaders**: `document.querySelectorAll('svg .loading').length === 0`.
4. **Zero Horizontal Overflow**: `document.documentElement.scrollWidth === document.documentElement.clientWidth`.
5. **Full native-browser E2E gate**: A visible popup or changed class is not proof of operability. Record the reference inventory before stripping reactive attributes. Every discovered control must have an explicit state/transition coverage record on Desktop, Tablet and Mobile.
   - Pointer: parent hover, incremental path across the boundary into every submenu child, diagonal movement, return, exit, click destination, close and reopen. Check visibility and `elementFromPoint` throughout traversal; synthetic DOM events do not prove reachability.
   - Keyboard: focus order, Enter/Space, supported arrows, Escape, focus restoration and overlay containment.
   - Touch and scrolling: tap, swipe/drag where supported, sticky and overlay behavior, scroll-lock restoration, viewport changes and reload while scrolled.
   - Lifecycle: initial/loading/settled, open/closed, selected/disabled, empty/error/recovery and interactions between components, where present on the source.
   - Every result names the tested transition, reference expectation, clone observation, before/after evidence and reset state. An unexecuted transition is UNVERIFIED, never PASS. Backend actions without an authorized real backend are BLOCKED, not simulated.
   - Re-run the complete recorded suite after the last regeneration. Unit tests, DOM checks and screenshots support but never replace this gate. Any FAIL, BLOCKED or UNVERIFIED prevents full-E2E VERIFIED.

---

## 4. Final Acceptance Report Format
Every run must yield an evidence-backed technical report containing:
1. Architecture Classification (`data-device="web"` vs `data-device="mobile"`).
2. Quality Metrics Table (Desktop vs Mobile, Live vs Clone).
3. Debris Cleaned Audit (Livewire attributes, SSR comments, trackers removed).
4. Interactive Telemetry Proof (Megamenu, Mobile Drawer, Video Modal).
5. Core/MCP Evolutions (exact files and functions improved).
6. Final Verdict (`VERIFIED` | `INCONCLUSIVE` | `HARD_FAILED`).

## 5. Solo Dev Local execution contract
Reuse the existing local server. Keep automation in background tabs or isolated hidden workers; never activate the user's tab. Close owned test windows and processes. Routine repairs within the approved scope proceed without repeated option interviews; ask only for material scope/data decisions or irreversible external actions.

Use the reusable Core suite in `packages/site-clone/src/qa/interaction-suite.ts` through `scripts/test-clone-features.cjs`. Store reference inventories, per-transition receipts, screenshots and the content-hashed provenance manifest together. The ledger proves artifact integrity, not behavioral correctness by itself.

Integrate only applicable `theme-qa-az` frontend-common checks: visible hover delta (C7), stable geometry (C8), close/reopen (D5), overflow (D6), correct navigation (D9), slider boundaries and meaningful actions. Do not apply Sapo/Haravan platform requirements to an independent HTML clone. Reference fidelity and accessibility findings must remain distinct.

---
phase: 2
title: "Low-Spec Hardware Optimization (Chromium flags, Throttling & Cooperative Yields)"
status: complete
effort: "2h"
dependencies: ["1"]
---

# Phase 2: Low-Spec Hardware Optimization (Chromium flags, Throttling & Cooperative Yields)

## Overview
Optimize resource consumption for developer machines with Intel Core i5-9300H (4 physical cores) and Intel UHD Graphics 630 (shared system VRAM). Bound Chromium processes to 4, reduce disk and media caches, enable background tab lifecycle throttling, and insert cooperative event-loop yields in theme scanners to eliminate CPU spikes and UI stuttering.

## Requirements
- **Functional:**
  * Configure Chromium command line switches: `renderer-process-limit=4`, `process-per-site`, `disk-cache-size=134217728` (128MB), `media-cache-size=67108864` (64MB), and `disable-gpu-memory-buffer-video-frames`.
  * Enable `setBackgroundThrottling(true)` on inactive `WebContentsView` instances; disable throttling only on active foreground views.
  * Insert cooperative event-loop yields (`await new Promise((r) => setImmediate(r))`) between Theme QA scanner stages and heavy DOM parsing loops.
- **Non-functional:**
  * Memory footprint remains $< 1.2\text{GB}$ with 5 open tabs.
  * Event-loop delay remains $< 50\text{ms}$ during full Theme QA scans on heavy storefronts.

## Architecture
```text
+------------------------------------------------------------------------+
|                          Electron Main Process                         |
|  - renderer-process-limit=4      - process-per-site                    |
|  - disk-cache-size=128MB         - media-cache-size=64MB               |
|  - disable-gpu-memory-buffer-video-frames                              |
+------------------------------------------------------------------------+
                                    |
      +-----------------------------+-----------------------------+
      |                                                           |
+-----v---------------------------+         +---------------------v------+
| Foreground Active Tab           |         | Background Inactive Tabs   |
| - WebContentsView               |         | - WebContentsView (Tab 2)  |
| - setBackgroundThrottling(false)|         | - WebContentsView (Tab 3)  |
| -> Full 60fps interaction       |         | - setBackgroundThrottling  |
+---------------------------------+         |   (true)                   |
                                            | -> 1 tick/sec timer clamp  |
                                            | -> Throttled animations    |
                                            +----------------------------+
```

## Related Code Files
- **Modify:**
  * `src/main/index.ts`
  * `src/main/browser/native-tab-host.ts`
  * `src/main/qa/theme-qa-workflow.ts`
  * `src/main/qa/scanners/liquid-error-scanner.ts`
  * `src/main/qa/scanners/layout-overflow-engine.ts`
  * `src/main/qa/scanners/broken-asset-scanner.ts`
- **Create:**
  * `test/main/low-spec-optimization.test.ts`

## Implementation Steps
1. Append low-spec Chromium switches in `src/main/index.ts` before app readiness.
2. In `NativeTabHost` (`src/main/browser/native-tab-host.ts`), enforce `setBackgroundThrottling(!activate)` on tab creation and dynamically toggle throttling in `switchTab` and `toggleSplitReview`.
3. In `ThemeQaWorkflow.validate` (`src/main/qa/theme-qa-workflow.ts`), insert cooperative yields between scanner phases.
4. In `LiquidErrorScanner` and `LayoutOverflowEngine`, ensure batch processing yields to the event loop on large payloads.
5. Create `test/main/low-spec-optimization.test.ts` to assert process limits, throttling state transitions, and event loop latency.

## Success Criteria
- [x] Maximum concurrent renderer processes is bounded to $\le 4$.
- [x] Disk cache size is capped at 128MB.
- [x] Background tabs consume $< 1\%$ CPU while idle.
- [x] Event loop delay monitor reports 0 stalls exceeding $50\text{ms}$ during theme audits.
## Risk Assessment
- **Risk:** `process-per-site` sharing renderer process across same-origin tabs.  
  *Mitigation:* `render-process-gone` recovery in `NativeTabHost` automatically detects and restores crashed views.

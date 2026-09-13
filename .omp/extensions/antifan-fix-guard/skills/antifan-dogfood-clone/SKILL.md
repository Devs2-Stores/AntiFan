---
name: antifan-dogfood-clone
description: "AntiFan Autonomous Dual-Surface Clone, DOM Sanitization, Adaptive Routing and Core Parity Verification protocol. Use when dogfooding AntiFan clone capabilities, sanitizing Livewire/SSR, generating 100% offline standalone clones, verifying desktop and mobile dual-surface parity, localizing subresources with Asset Core, or testing mobile drawer and modal interactions."
---

# AntiFan Dogfooding Protocol: Autonomous Dual-Surface Clone & Parity Verification

You are operating **directly inside the AntiFan project** as Principal Systems & Theme Reliability Engineer.

* **User Role**: Solo Dev Local — maximum priority on smooth, reliable interactions, no screen flickering, automated error recovery, and zero artificial authorization barriers.
* **Goal**: Execute the definitive AntiFan Dogfooding protocol — utilizing AntiFan's MCP ecosystem and Core engine (`packages/site-clone/`) to clone any target website into a **100% independent, offline-first HTML/CSS/JS standalone package, completely free of Livewire/SSR debris, strictly achieving Desktop & Mobile dual-surface parity with local assets and interactive fidelity**.

---

## Pre-Flight Check & Restart Condition (Fail-Closed)
1. **Verify Core Capabilities**: Call `anti.browser.tabs.list` and `anti.theme.export_clean`.
2. **Trigger Restart Alert on Missing Load**:
   If a tool responds with `CAPABILITY_NOT_FOUND` (Electron has not loaded `.compiled/` into RAM):
   **STOP IMMEDIATELY AND NOTIFY USER**:
   > "[YÊU CẦU RESTART]: Mã nguồn Core mới đã biên dịch trong .compiled/ nhưng Electron chưa nạp vào RAM. Vui lòng bấm Ctrl + Shift + U (hoặc đóng mở lại app) để nạp Core mới!"
   Any modifications to `src/main/` requiring Electron reload must be reported before proceeding.


## Universal CLI Entrypoint
To clone any arbitrary target website into a 100% standalone, offline-ready package:
```bash
# Generic clone for any URL (auto-detects Adaptive vs Responsive, harvests & localizes all assets):
npm run clone:site -- <targetUrl> [--out <outputDir>] [--refresh] [--concurrency 10] [--serve]

# Or run directly:
node scripts/clone-site.mjs <targetUrl> [--out <outputDir>] [--serve]

# Preview the generated clone locally on an adaptive routing server:
npm run serve:clone -- [outputDir]
```
---

## 6 Inviolable Invariants

1. **CORE-ENGINE ONLY (Fix Core, Never Hand-Edit Store Files)**:
   * **NEVER** manually edit HTML/CSS files in `clone/` to pass tests.
   * All DOM extraction improvements, CSS parity locks, multi-viewport handling, and JS compensation **MUST reside in Core** (`packages/site-clone/src/generators/independent-html-clone-generator.ts`, `packages/site-clone/src/models/*`, `src/main/*`).
   * Core logic must be **100% platform-agnostic and generic** (supporting Alpine, Vue, Livewire, React, Shopify, Haravan, WordPress). Never hardcode site-specific selectors into Core.
2. **SOLO DEV LOCAL & MATERIAL DECISION GATE**:
   * Prioritize accurate, smooth local operation: background automation, existing server reuse, no tab stealing or orphan processes.
   * Investigate and repair routine technical failures within the approved scope without repeatedly asking the user to select the same approach.
   * Report gaps immediately. Ask only for material scope/data tradeoffs or irreversible external actions; never silently weaken acceptance criteria or fake backend behavior.
3. **ZERO TAB-STEAL & TAB-AFFINITY LOCK**:
   * Preserve the user's active tab. All test/capture tabs must be created with `activate: false`.
   * **NEVER** trigger tab switching (`switchTab`, `anti.browser.tabs.activate`) during capture, visual compare, or evaluation.
   * Pass the exact `tabId` to prevent `TARGET_MISMATCH`. If a tab becomes stale, rebind automatically to the valid session tab.
4. **MCP-FIRST**:
   * All navigation, measurement, inspection, screenshotting, and extraction must prioritize MCP tools (`anti.browser.*`, `anti.inspect.*`, `anti.theme.export_clean`, `anti.screenshot.*`, `anti.media.freeze`).
5. **NO SILENT TOOL-CALLING**:
   * Report gaps immediately: `[PHÁT HIỆN GAPS]: Tool name, error code, root cause, resolution`.
   * When modifying Core/MCP code: report modified file, modified function, changes made, and `npm run compile` result.
6. **ASSET CORE LOCALIZATION MANDATE**:
   * Standalone clones must NOT hotlink to remote reference servers (`https://img.example.com/...`).
   * All subresources (images, fonts, stylesheets) must be harvested via `AssetHarvester`, downloaded via `AssetLocalizer` with SSRF protection, and rewritten to local `assets/...` paths.

---

## The 5-Phase Execution Workflow

### Phase 0: Dual-Surface Architecture Probe (Adaptive vs Responsive)
1. Probe target site body attributes and headers:
   * Inspect `document.body.getAttribute('data-device')`: `'web'` vs `'mobile'`.
   * Probe Desktop UA vs Mobile UA (`sec-ch-ua-mobile: ?1`).
2. If server delivers distinct DOM trees (Adaptive site):
   * **Desktop Surface**: `<body data-device="web">`, ~400KB+ DOM.
   * **Mobile Surface**: `<body data-device="mobile">`, containing `.category-navigation__block` (drawer) and `.bottom-navigation` (dock).
   * Activate Dual-Surface Pipeline: generate both `index.html` and `mobile/index.html`.
3. If pure Responsive: use single unified template.
*See `references/dual-surface-adaptive.md` for exact contracts.*

### Phase 1: Initialization & Full-Page Materialization
1. Measure baseline scroll height via `anti.inspect.page_inventory`.
2. **Full Scroll Walk**: Step-by-step scrolling ($y = 0 \to \text{scrollHeight}$, step: 300px, interval: 120ms) combined with lazy image decoding to trigger all `IntersectionObserver` callbacks and populate dynamic SSR/Livewire components.
3. Re-measure `page_inventory` to establish the definitive **Baseline Height**.
4. Before sanitization, persist a reference feature inventory and state-transition ledger. Include hidden controls and their opening prerequisites; discovery is not a PASS. Record unsupported and backend-dependent transitions explicitly.

### Phase 2: Core Extraction, Sanitization & Asset Localization
1. **Strip 100% Livewire/SSR Debris**:
   * Remove `wire:*`, `x-data`, `x-bind`, `x-on`, `x-show`, `x-intersect`, and `<!--[if BLOCK]>`.
   * **Regex Safety Rule**: ALWAYS mandate leading whitespace `\s+` and explicit Alpine whitelists to protect utility class names (e.g., `flex-center-between` must NOT be truncated to `fle`).
2. **Preserve Media Embed URLs**:
   * Do not wipe YouTube/Vimeo URLs to empty strings. Preserve authentic embed URL in `data-src` and initialize `src="about:blank"` to prevent recursive self-loading.
3. **Eagerize Images**:
   * Convert `loading="lazy"` and `data-src` to eager `src`.
4. **Universal CSS Parity Locks (`#antifan-clone-parity`)**:
   * Viewport safety: `html, body { max-width: 100vw !important; overflow-x: hidden !important; }`
   * Universal declarative targets: `[data-antifan-target]:not(.active) { display: none !important; }` and `[data-antifan-target].active { display: block !important; }`
   * Universal modals/popups/drawers: `.modal:not(.active):not(.show), .popup:not(.active):not(.show) { display: none !important; }`
   * Active fixed overlays centering and backdrop management without blocking normal page flow.
5. **Universal Vanilla JS Interactivity (`#antifan-clone-interactivity`)**:
   * Wrap in `document.readyState` lifecycle check.
   * Universal Declarative Toggle Engine (`[data-antifan-toggle]` <-> `[data-antifan-target]`).
   * Universal Outside-Click Dismissal for popups, dropdowns, and tooltips.
   * Universal Modal Dialog & Drawer Open/Close with body scroll locks.
   * Dropdown menus and navigation hover/click handlers.
6. **Asset Core Localization**:
   * Run `AssetHarvester.harvestFromHtml` to discover all subresources (images, fonts, stylesheets).
   * Run `AssetLocalizer.downloadAssets` with SSRF guard, bounded concurrency, and sha256 checksums.
   * Run `AssetLocalizer.rewriteFiles` to map all remote references to local offline paths.
   * Preserve separate stylesheets per surface (desktop vs mobile) to prevent cascade collisions.
*See `references/dom-sanitization-rules.md`, `references/css-parity-locks.md`, `references/vanilla-interactivity.md`, and `references/asset-core-pipeline.md`.*

### Phase 3: Adaptive Local Serving & Parity Verification
1. Start clone server (`scripts/serve-clone.mjs`) with adaptive routing:
   * Client Mobile UA / `sec-ch-ua-mobile: ?1` / `?device=mobile` $\to$ serves `mobile/index.html`.
   * Desktop client $\to$ serves `index.html`.
   * Universal fallback resolution: `/css/*` and `/mobile/css/*` $\to$ `css/`; `/assets/*` and `/mobile/assets/*` $\to$ `assets/`.
2. Inspect target tab at `http://127.0.0.1:3300/`:
   * Height Parity: $\ge 90\%$ (target $\ge 99\%$) of baseline height.
   * DOM Purity: 0 Livewire attributes, 0 broken images (`naturalWidth === 0`), 0 horizontal overflow (`scrollWidth === clientWidth`), 0 remote image references.

### Phase 4: Multi-Viewport Visual QA & Media Lifecycle
Test across 3 standard breakpoints:
* **Desktop**: 1440 × 900
* **Tablet**: 1024 × 768
* **Mobile**: 390 × 844 (`mobile: true`)
**Quiescence & Snapshot Protocol**:
1. Set viewport: `anti.browser.set_viewport({ width, height, mobile })`.
2. **Freeze Motion**: `anti.media.freeze({ freeze: true, normalizeSliders: true })`.
3. Capture evidence: `anti.screenshot.viewport({ format: 'png' })`.
4. **Restore Motion (Mandatory)**: `anti.media.freeze({ freeze: false })`.
*See `references/verification-and-reporting.md`.*

### Phase 5: Full Native-Browser E2E Regression Gate
Execute the entire recorded feature/state inventory against the live reference and regenerated clone, not a sample of controls. Follow `references/verification-and-reporting.md` for the authoritative gate.
1. Use native pointer trajectories through parent, boundary and every dropdown child; verify hit-testing, visible content, click destinations and close/reopen. A class toggle or synthetic event is insufficient.
2. Cover keyboard, touch, scroll, resize, loading/empty/error states and component interactions where present. Capture before/after evidence and reset state for each journey.
3. Run Desktop, Tablet and Mobile. Report exact executed/total state transitions, PASS/FAIL/BLOCKED/UNVERIFIED and all uncovered controls.
4. After the final Core change and clone regeneration, rerun the full suite. Any unexecuted or blocked required transition prevents full E2E VERIFIED; do not replace backend workflows with mocks.

---

## Acceptance Report Deliverable
Every run concludes with a technical acceptance report:
1. **Architecture Classification** (evidence of `data-device` or server-side adaptive UA branching).
2. **Clone Quality Metrics Table** (Desktop & Mobile, Live vs Clone: heights, sections, assets).
3. **Debris Cleaned Audit** (Reactive framework attributes removed $= 0$, remote dependencies $= 0$).
4. **Interactive Verification Proof** (telemetry traces of menus, drawers, popups, modals).
5. **Core/MCP Evolutions** (files and capabilities improved in Core engine).
6. **Final Verdict** (`VERIFIED` | `INCONCLUSIVE` | `HARD_FAILED`).

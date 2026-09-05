# Immutable Evidence Packet: AntiFan Browser Desktop Gap & Enhancement Analysis (Full Session Toda)

## 1. Context & Scope
- **Target Application:** AntiFan Browser Desktop (Electron + MCP Companion for Theme & Web Application Engineering).
- **Target Session Log:** `C:/Users/Admin/.omp/agent/sessions/--E--Work-customizes-Toda--/2026-09-05T05-05-10-088Z_01a06ff4-cfc8-709a-8baf-2d4d0e3cceb1.jsonl`
- **Session Volume:** 1,804 records, 13 user turns, 340 assistant turns, 695 tool results, 36 errors, 13 MB.
- **Target Project:** Haravan Storefront Toda Thailand (`https://todathailand.vn/`), executing:
  - Multi-tab Google Sheets feedback extraction & lead form integration (`assets/toda-leadform.js`)
  - Order sample page refactoring (`templates/page.about-03.liquid`)
  - 3D Online Catalogue section (`templates/page.toda-catalogue.liquid`, `assets/toda-catalogue.css`, `assets/toda-catalogue.js`)
  - Repositioning rail below list and matching An Cường reference (`https://ancuong.com/`)
  - Strict visual compare requirement from user: "áp Visual Compare" and "visual compare < 5%"
  - Dynamic motion/speed tuning: "Về hiệu ứng thì sao, thấy đang chạy chữ chậm hơn ref mẫu"
  - Settings documentation in `config/settings.html`
  - Visual element annotations via `@.antifan/annotations/` and `@.antifan/snapshots/`
  - User concluding directive: "Done, ghi lại report issue các vấn đề AntiFan".
- **Workstation Environment:** Windows 11 Pro, running active `hrv theme dev` file watcher.

---

## 2. Quantitative Telemetry & Tool Invocations
- **Total Tool Calls (692 calls across session):**
  - `write` (MCP tool invocations + file writes + issues): 324 calls (46.8%)
  - `read` (files, schemas, annotations): 216 calls (31.2%)
  - `grep`: 63 calls (9.1%)
  - `edit`: 34 calls (4.9%)
  - `todo`: 25 calls (3.6%)
  - `bash`: 21 calls (3.0%)
  - `glob`: 9 calls (1.3%)
  - `eval`: 5 calls (0.7%)
- **AntiFan MCP Tool Usage Breakdown (285 total calls):**
  - `anti.browser.evaluate`: **113 calls (39.6%)** — Massive over-reliance on raw JS evaluation for routine tasks: scrolling (`window.scrollTo`), reading offsets (`scrollY`), measuring DOM rects (`getBoundingClientRect`), inspecting computed transforms, and reverse-engineering remote scripts.
  - `anti.screenshot.viewport`: **27 calls (9.5%)** — Plagued by cross-tab bleed, empty image payloads, and 10s CDP timeouts.
  - `anti.browser.reload`: 24 calls (8.4%)
  - `anti.browser.tabs.create`: 14 calls (4.9%)
  - `anti.inspect.dom`: 13 calls (4.6%)
  - `anti.inspect.responsive_matrix`: 13 calls (4.6%)
  - `theme.qa_validate`: 12 calls (4.2%) — 3 `TARGET_MISMATCH` errors, 1 empty screenshot artifact error.
  - `anti.visual.compare`: **10 calls (3.5%)** — **8 direct failures (80% error rate)**: `TARGET_STALE`, 10s CDP timeout, `TARGET_MISMATCH`, artifact not found in store. 0 successful receipts delivered.
  - `anti.inspect.snapshot`: 9 calls (3.2%)
  - `anti.browser.tabs.close`: 9 calls (3.2%) — 1 `TARGET_MISMATCH` error.
  - `anti.browser.tabs.list`: 8 calls (2.8%)
  - `anti.inspect.styles`: 8 calls (2.8%)
  - `browser_set_viewport`: 6 calls (2.1%)
  - `anti.trace.interaction`: 5 calls (1.8%)
  - `theme.debug_bundle`: 5 calls (1.8%) — Target metadata mismatch.
  - `anti.inspect.style_diff`: 5 calls (1.8%)
  - `anti.agent.cursor.scroll`: 4 calls (1.4%)
  - `anti.inspect.page_inventory`: 4 calls (1.4%)
  - `anti.media.freeze`: 4 calls (1.4%)
  - `anti.browser.tabs.activate`: 3 calls (1.1%)
  - `browser_press_key`: 3 calls (1.1%)
  - `anti.agent.cursor.type`: 2 calls (0.7%)
  - `anti.browser.navigate`: 2 calls (0.7%)
  - `anti.verification.record_claim`: 2 calls (0.7%) — Both rejected due to undocumented schema constraint.
  - `anti.artifact.read`: 1 call (0.4%)
  - `theme.assert_cart`: 1 call (0.4%)
  - `anti.theme.resolve_element`: 1 call (0.4%)
  - `anti.inspect.region`: 1 call (0.4%)

---

## 3. Ten Documented `report_issue` Records Filed by the Agent
1. **[Record 32] `anti.screenshot.viewport`**: Called with `tabId: "08ce62f2-..."` (Google Sheets feedback tab), but captured and returned the storefront tab `1b1fe78a-...`. User had to intervene: *"Sai nhé, nội dung đúng là tab 08ce62f2-64c7-408c-a91e-e992aae7095a"*.
2. **[Record 340] `anti.visual.compare / anti.screenshot.viewport`**: Tab had `readyState === "complete"` and non-zero `.toda-catalogue-page` rect, but repeated captures returned `TARGET_STALE` or empty image data, preventing visual compare receipt.
3. **[Record 651] `eval / tool.write` aggregation**: Batching AntiFan MCP calls via `eval` + `tool.write` returned all-zero/false values across 8 routes due to internal viewport lock contention (`viewportGate.withLock`).
4. **[Record 689] `theme.debug_bundle`**: Target metadata inconsistency; payload was extracted from requested tab B, but returned `target.tabId` reported bound tab A.
5. **[Record 746] `anti.screenshot.viewport`**: Returned undecodable JPEG with empty image data (`data: ""`) on fully loaded storefront tabs.
6. **[Record 790] `anti.visual.compare`**: Baseline file + explicit tab failed `TARGET_MISMATCH`, reporting unrelated tab `1b1fe78a-...`.
7. **[Record 790] `anti.verification.record_claim`**: Documented schema in `antifan-omp-mcp.cjs` has `proofObligations: { type: 'array', items: { type: 'object' } }`, but backend strictly threw `INVALID_ARGUMENT: Obligation at index 0 must have a non-empty metric string`.
8. **[Record 876] `theme.qa_validate`**: Emitted screenshot artifact with `byteLength: 0` and SHA-256 of empty content.
9. **[Record 1184] `anti.visual.compare`**: Selector `[data-catalogue-compare]` resolved to visible 1920×337.875 element with opacity 1 on reference tab, but tab-to-tab twice returned `TARGET_STALE` / non-empty screenshot failure.
10. **[Record 1783] `anti.screenshot.viewport` / `anti.visual.compare` / `anti.browser.tabs`**: Background tabs return empty image data or `TARGET_STALE`; `visual.compare` fails comparing between background tabs; preload script throws `ENOENT` for `.compiled/src/preload/tab-preload.js`.

---

## 4. Nine Concrete Weaknesses & Required Additions/Enhancements

### Weakness 1: Cross-Tab Screenshot Bleed on Background Tabs (P0 - Critical Bug)
- **Symptom:** Capturing an inactive/background tab returns pixels of the currently visible active tab.
- **Root Cause:** `src/main/browser/tab-devtools-host.ts:1042-1062` uses `Page.captureScreenshot({ fromSurface: true })`. Chromium's OS compositor surface only holds pixels for the active foreground view.
- **Remedy:** Set `fromSurface: false` on background/offscreen tab captures, or pump render frame before capture.

### Weakness 2: Visual Compare Total Breakdown on Multi-Tab References (P0 - Critical Reliability)
- **Symptom:** 8 out of 10 calls to `anti.visual.compare` failed (`TARGET_STALE`, 10s CDP timeout, `TARGET_MISMATCH`). The agent could never fulfill the user's explicit requirement: *"Chỗ Online Catalogue làm y chang dùm, áp Visual Compare"* and *"visual compare < 5%"*.
- **Root Cause:** In `src/main/tools/browser-control-port.ts:2357, 2410`, `visualCompare()` calls `this.host.captureScreenshot(undefined, ...)` with `rect = undefined` (forcing full viewport), ignoring `clipRect` or `selector` in the capture phase. Background reference tabs have paused compositors and return empty buffers.
- **Remedy:** Pre-calculate bounding rect for `selector`/`clipRect` and pass `rect` directly into `captureScreenshot()`. Activate render pump on comparison tab before capture.

### Weakness 3: Complete Absence of Animation & Motion Inspection Tooling (P1 - Core Feature Gap)
- **Symptom:** User inquired at Record [1659]: *"Về hiệu ứng thì sao, thấy đang chạy chữ chậm hơn ref mẫu"*. AntiFan provided zero tooling to inspect CSS animations, transitions, or scroll-linked transforms. The agent had to write 15+ complex JavaScript evaluations to fetch scripts from `https://ancuong.com/`, parse scroll ratios, and sample transform matrices over time.
- **Addition Needed:** New tool `anti.inspect.motion` / `anti.inspect.animation` capable of:
  - Sampling computed transforms/styles across simulated scroll positions or time deltas (`keyframes`, `transitions`, `scroll-driven transforms`).
  - Comparing velocity, easing, and transform delta between two tabs (`tabId` vs `comparisonTabId`) for a target selector.

### Weakness 4: High-Level Primitive Gap — 113 Raw JS Eval Invocations (P1 - Ergonomic Gap)
- **Symptom:** 113 calls to `anti.browser.evaluate`. The agent was forced to write ad-hoc scripts for:
  - Exact scrolling: `window.scrollTo({ top: Y, behavior: 'instant' })`
  - Reading scroll state: `{ scrollX, scrollY, maxScroll }`
  - Querying element geometry: `getBoundingClientRect()`
  - Polling `document.readyState`
- **Addition Needed:** Native primitives:
  - `anti.browser.scroll_to({ tabId?, x?, y?, selector?, behavior? })`
  - `anti.inspect.geometry({ tabId?, selector })` returning bounding box, scroll offsets, and viewport visibility.

### Weakness 5: Monolithic Tab Isolation & Overly Aggressive `TARGET_MISMATCH` (P1 - Architecture Friction)
- **Symptom:** Calling `anti.browser.tabs.close` or `theme.qa_validate` on auxiliary tabs threw `TARGET_MISMATCH: This session is isolated to tab ... and its managed tabs`.
- **Root Cause:** `browser-capabilities.ts:1168` and `browser-control-port.ts:941, 2874` enforce strict single-tab lease. Multi-tab workflows (Sheets + Storefront + Reference) are blocked from closing or validating auxiliary tabs.
- **Remedy:** Allow read-only inspections (`inspect.*`, `debug_bundle`, `qa_validate`) and lifecycle cleanup (`tabs.close`) to operate across all tabs associated with the active session/project.

### Weakness 6: Target Metadata Inconsistency in Compound Tools (P1 - Data Integrity)
- **Symptom:** `theme.debug_bundle` called with explicit `tabId` analyzed that tab, but returned `target.tabId` asserting it came from the bound tab.
- **Root Cause:** `browser-capabilities.ts:1316, 1338` returns unmodified `context.browserTarget`.
- **Remedy:** Return shallow clone of target with `tabId: params.tabId || target.tabId`.

### Weakness 7: Schema Drift in MCP Registry (`anti.verification.record_claim`) (P2 - Contract Bug)
- **Symptom:** Valid-looking claims rejected with `INVALID_ARGUMENT: Obligation at index 0 must have a non-empty metric string`.
- **Root Cause:** `scripts/antifan-omp-mcp.cjs:55` defines untyped `items: { type: 'object' }`, while backend enforces `typeof obl.metric === 'string' && obl.metric.trim()`.
- **Remedy:** Synchronize JSON Schema in `antifan-omp-mcp.cjs` with properties: `id`, `metric`, `tolerance`, `critical`, `expected` and `required: ['metric']`.

### Weakness 8: Preload Script Resolution Failure with External Working Directory (P2 - Environment Bug)
- **Symptom:** Console ENOENT errors for `.compiled/src/preload/tab-preload.js`.
- **Root Cause:** `src/main/security/security-policy.ts:122` checks `path.join(process.cwd(), '.compiled', ...)`. When agent runs in a customer project directory (`E:\Work\customizes\Toda`), `process.cwd()` is Toda, not AntiFan Desktop root.
- **Remedy:** Resolve preload relative to `__dirname` or store AntiFan installation root directory in environment/config.

### Weakness 9: Harness Artifact URI Schema Mismatch (P2 - Integration Friction)
- **Symptom:** Agent attempted `read("artifact://artifact-<uuid>")` $\rightarrow$ failed with `artifact:// ID must be numeric`.
- **Root Cause:** Harness OMP supports integer IDs only; AntiFan uses UUID strings.
- **Remedy:** Expose direct MCP artifact converter or dual-registration in local temp store.
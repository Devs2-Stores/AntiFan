# ANONYMIZED CANDIDATE PACKET FOR VERIFIER (KONGMING)
## Topic: Automation Frameworks (Selenium, Playwright, Cypress, Puppeteer, WebDriverIO) for AntiFan Browser Desktop — Solo Dev Local Edition
## Reference Evidence Packet: `plans/reports/_ultra-automation-frameworks-evidence.md`

Rubric (1-20 points each, max 100):
- R1: Framework Architectural Depth & Empirical Grounding
- R2: AntiFan Codebase Alignment & Bottleneck Diagnosis
- R3: Solo Dev Local Realism & Zero-Fluff Pragmatism
- R4: Actionable Blueprint — "Steal vs. Bridge vs. Reject"
- R5: Performance & Reliability Rigor

Special Conflict Directives for Verifier:
1. Reconcile the bridge conflict: Candidate Alpha argues external `--remote-debugging-port` / `connectOverCDP` causes severe multi-client attachment collisions with Electron's native `wc.debugger` (`Another debugger is already attached` / detaching `TabDevToolsHost`) plus +60-90MB RAM and 1.5-3.5ms loopback latency, whereas Candidate Epsilon recommends bridging via `connectOverCDP`. Determine the authoritative verdict.
2. Reconcile Pain Point P4 (1D range sliders / drag-and-drop): Candidate Epsilon's Steal table omitted P4, while Candidate Gamma (§4.5) and Candidate Delta (§5) provide the concrete technical mechanism (spaced `mouseMoved` steps at 16ms intervals + pointer-capture verification). Determine how P4 must be handled.

---

### Candidate Alpha (Excerpt & Core Findings)
- **Role / Angle:** Low-Level CDP & Protocol Engineering.
- **Protocol Analysis:**
  - Compares direct in-process C++ `wc.debugger` (0.15ms latency, direct Mojo IPC to `content::DevToolsAgentHost`) vs CDP over WebSocket (1.5–3.5ms latency, JSON stringify, WebSocket framing mask `0x81`, TCP loopback, demarking, parsing).
  - Strongly warns AGAINST bridging to external runners via `--remote-debugging-port`: Chromium DevTools restricts multiple clients on active debugger sessions. Attaching an external Playwright client over WebSocket while `TabDevToolsHost` has `wc.debugger.attach('1.3')` triggers error -32000 (`Another debugger is already attached`) or kicks `wc.debugger` off, firing `onDetach` and bricking AntiFan's internal CDP queues. Adds +60–90MB RAM.
  - Recommends: 100% in-process execution via `wc.debugger`. STEAL Playwright's TypeScript algorithms directly into AntiFan's World 1004. REJECT all external bridges during runtime.
- **Score Proposal:** Reject Selenium, Cypress, WDIO. Steal Playwright core algorithms.

---

### Candidate Beta (Excerpt & Core Findings)
- **Role / Angle:** AntiFan Core Systems & Codebase Diagnosis.
- **Codebase Grounding:**
  - Analyzes exact files: `TabDevToolsHost` (`src/main/browser/tab-devtools-host.ts`), `tab-automation-host.ts`, `semantic-ref-executor.ts`.
  - Diagnoses Bug P1: Blind click in `tab-automation-host.ts:515-538`. Resolves coordinates once, but misses because: (1) no occlusion check via `document.elementFromPoint`, (2) IPC roundtrip latency drift (25-80ms) during CSS transitions, (3) raw x,y bypasses stability checks. Solution: Playwright Actionability Pipeline.
  - Diagnoses Bug P2: SettleGate `SETTLE_INCOMPLETE: network=false` caused by 3rd-party analytics (GTM, Pixel, Tawk.to). Solution: CDP `Network.setBlockedURLs` at C++ level.
  - Diagnoses Bug P3: 10s CDP screenshot timeout on long landing pages (15,000px+). Chromium GPU compositor stalls rasterizing unpainted lazy-loaded images. Solution: Windowed staircase scroll pre-warming.
  - Diagnoses Bug P4: Sliders fail because single-point click lacks drag movement interpolation. Solution: Spaced mouseMoved steps.

---

### Candidate Gamma (Excerpt & Core Findings)
- **Role / Angle:** E2E Framework Architect & Matrix Comparator.
- **Framework Teardown:**
  - Selenium: W3C HTTP wire protocol tax (10-50ms per action), standalone `chromedriver.exe` binary mismatch against Electron 43, WebDriver BiDi lags native CDP. REJECT.
  - Cypress: In-iframe execution architecture shares event loop with AUT. Cannot handle multi-tab / split-panes (`target.view` + `target.mobileView`). Background tab rAF throttling freezes Cypress. Deprecated Electron runner. REJECT.
  - WebDriverIO: Enterprise abstraction bloat, 150MB+ dependencies. Mobile Appium bridge redundant to AntiFan's direct `usbmuxd` + WebDriverAgent REST. REJECT.
  - Puppeteer-core: Lightweight (~1.5MB), but thin mirror of what AntiFan already has; lacks actionability and full-page compositor warming.
  - Playwright-core: Gold standard. Actionability (5 phases), sub-ms `Fetch.enable` route filtering, incremental scroll ladder, and explicit drag engine.
  - Detailed P4 Solution (§4.5): Drag engine calculates Bézier trajectory, dispatches intermediate `mouseMoved` steps at 16ms intervals (matching 60Hz display refresh), and verifies pointer capture is maintained.

---

### Candidate Delta (Excerpt & Core Findings)
- **Role / Angle:** Scraper, Anti-Bot & Reverse-Engineering Specialist.
- **Technical Deep-Dive (797 lines):**
  - Reverse-engineers Playwright's `InjectedScript` actionability pipeline: 5-condition gate (`attached`, `visible`, `stable` via RAF position drift $\Delta \le 1\text{px}$, `enabled`, `receives events` via `document.elementFromPoint`).
  - Reverse-engineers Windowed Staircase Auto-Scroll: Incremental window scroll ($600\text{px}$ steps, 40ms wait) triggering `IntersectionObserver`, followed by `document.fonts.ready` and `img.decode()` before `Page.captureScreenshot`. Completely eliminates compositor stalls.
  - Reverse-engineers Zero-IPC C++ Socket Drops: Uses `Network.setBlockedURLs` to drop tracker traffic at Chromium network socket level, bypassing V8 IPC overhead entirely.
  - Provides complete, copy-pasteable TypeScript code implementations for AntiFan.

---

### Candidate Epsilon (Excerpt & Core Findings)
- **Role / Angle:** Solo Dev "Steal Like an Artist" Technical Director.
- **Strategic Blueprint:**
  - Ruthless KISS & YAGNI for Solo Dev Local.
  - Formulates the "STEAL vs. BRIDGE vs. REJECT" Trichotomy:
    - STEAL: Actionability, Auto-Scroll Pre-Warming, C++ Network Blocking, Drag Interpolation.
    - BRIDGE: Suggests `connectOverCDP` via `--remote-debugging-port=9222` to use Playwright Trace Viewer on demand.
    - REJECT: Selenium, Cypress, WDIO, Puppeteer.
  - 3-step actionable implementation roadmap (1 day, 2 hours, 3 hours).

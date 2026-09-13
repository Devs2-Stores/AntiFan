# IMMUTABLE EVIDENCE PACKET — `ak:research --ultra`
## Topic: Comprehensive Comparative Analysis of Selenium, Playwright, Cypress, Puppeteer, and WebDriverIO for AntiFan Browser Desktop — Solo Dev Local Edition

This packet is frozen and authoritative for all five research candidates and the Kongming Verifier.

---

## 1. RESEARCH TRIGGER & USER CONTEXT

### 1.1 Trigger
The user asked:
> `"--ultra Phân tích sâu thêm 1 vòng nữa tất cả bộ Selenium, Playwright, Cypress, Puppeteer, WebDriverIO xem có cải thiện được gì cho AntiFan ko"`  
> `"Lưu ý là thật sự cải thiện nhé, và hãy nhớ tôi là Solo Dev Local, nên ko cần sợ gì cả, ko cần chặn gì cả, tự do"`

### 1.2 User Profile & Operating Constraints
- **Role:** Solo Dev Local.
- **Freedom Level:** Absolute. No enterprise compliance, no multi-browser cross-platform matrix requirements (no need to test Firefox 90 or Safari 14 on Linux), no fear of breaking "standards" or getting locked into a stack. Full freedom to hack, cherry-pick, inject, wrap, or steal any internal algorithm or library.
- **Criterion:** **"Thật sự cải thiện" (Genuine Improvement).** Zero tolerance for vanity integrations, academic fluff, or adding 200MB of `node_modules` that slow down the developer loop.

---

## 2. ANTIFAN ARCHITECTURE & KNOWN BOTTLENECKS (GROUND TRUTH)

### 2.1 Current AntiFan Tech Stack (`antifan-browser-desktop` v1.3.6)
1. **Host Environment:** Electron 43.4.0 + Node.js 22 + Chromium on Windows 11.
2. **CDP Multiplexer:** `TabDevToolsHost` (`src/main/browser/tab-devtools-host.ts`, ~2,956 lines) attached to Electron `WebContents` via `wc.debugger.attach('1.3')`. Manages serial promise queues per `WebContents`.
3. **Automation Core:** `TabAutomationHost` (`src/main/browser/tab-automation-host.ts`) dispatching low-level CDP events:
   - `Input.dispatchMouseEvent` (`mouseMoved`, `mousePressed`, `mouseReleased`) with custom visual cursor overlays and Bézier trajectories.
   - `Input.dispatchKeyEvent` with virtual keycodes and modifier flags.
4. **Tool Surface:** `scripts/antifan-omp-mcp.cjs` (~1,344 lines) exposing 40+ MCP tools (`anti.browser.*`, `anti.inspect.*`, `anti.agent.*`, `anti.verification.*`, `device.*`).
5. **Real iOS Device Adapter:** `DeviceControlPort` (`src/main/device/device-control-port.ts`) communicating with physical iPhones over USB via `usbmuxd` + `WebDriverAgent` REST + RemoteXPC on iOS 18+.

### 2.2 Known Empirical Pain Points & Bottlenecks in AntiFan Telemetry
- **P1: Flaky Clicks & Missed Interactions:** AntiFan calculates `clickX, clickY` via DOM rects, then blindly fires `Input.dispatchMouseEvent`. If an element is transitioning, animating, covered by a sticky header, or not yet attached to DOM, the click misses or fails silently.
- **P2: Settle Gate Failures (`SETTLE_INCOMPLETE`):** On complex e-commerce pages (e.g., Phukienmaymoc, HopLongTech), `theme.qa_validate` frequently fails with `SETTLE_INCOMPLETE: images=false` or network pending because 3rd-party scripts (GTM, chat widgets, analytics) hang the network.
- **P3: Full-Page Screenshot CDP Timeouts (10s):** Long e-commerce landing pages with dynamic lazy-loading images trigger 10-second CDP timeouts during `anti.visual.compare` or full-page capture.
- **P4: DOM Drag-and-Drop / Range Sliders:** AntiFan struggles with 1D price range sliders (noUiSlider) and complex drag-and-drop file/element interactions.
- **P5: Lack of Dynamic Route Interception:** AntiFan cannot easily block or stub specific network requests (e.g. ad trackers, analytics) on the fly without heavy CDP event overhead.

---

## 3. FRAMEWORK LANDSCAPE BREAKDOWN (THE CANDIDATE SUITE)

### 3.1 Selenium (Selenium WebDriver / BiDi)
- **Architecture:** Client bindings -> W3C WebDriver HTTP wire protocol -> standalone `chromedriver.exe` -> Chromium.
- **Characteristics:** Designed for multi-language enterprise test grids. Heavy binary coupling, slow HTTP polling.

### 3.2 Cypress
- **Architecture:** Runs *inside* the browser tab iframe in the same JavaScript event loop as the application under test. Node.js backend handles OS tasks.
- **Characteristics:** Extremely fast for single-page component tests. Structurally incapable of multi-tab, multi-origin, or native CDP target switching. Deprecated its bundled Electron runner.

### 3.3 WebDriverIO
- **Architecture:** Flexible Node.js automation framework supporting both W3C WebDriver and Chrome DevTools Protocol (via Puppeteer/CDP bridge). Native integration with Appium for mobile.
- **Characteristics:** Feature-rich but heavy plugin ecosystem. AntiFan already bypasses Appium for direct `usbmuxd` + `WebDriverAgent` REST on Windows 11.

### 3.4 Puppeteer (`puppeteer-core`)
- **Architecture:** Pure Node.js wrapper around CDP over WebSocket.
- **Characteristics:** Extremely lightweight (~1.5MB for `puppeteer-core`). Maps 1:1 to CDP domains (`Page`, `Runtime`, `DOM`, `Network`, `Emulation`, `Input`). Provides `CDPSession` abstractions.

### 3.5 Playwright (`playwright-core`)
- **Architecture:** Node.js client -> out-of-process driver -> direct CDP WebSocket to Chromium / patched WebKit / patched Firefox.
- **Key Internal Innovations:**
  1. **Actionability Pipeline (`InjectedScript`):** 5-condition pre-flight check before every interaction (`attached`, `visible`, `stable` via `requestAnimationFrame`, `enabled`, `receives events` via `document.elementFromPoint` hit testing).
  2. **Incremental Auto-Scroll Lazy Loading:** Solves full-page screenshot timeouts on dynamic pages.
  3. **Network Route Interception (`page.route` / `Fetch.enable`):** Sub-millisecond URL matching, aborting, mocking, and header mutation.
  4. **Rich Selector Engine:** Complex pseudo-selectors (`:has-text()`, `role=...`, `:visible`, `:has()`).
  5. **`connectOverCDP`:** Can connect directly to an Electron app launched with `--remote-debugging-port`.

---

## 4. RUBRIC FOR VERIFIER (Kongming)

- **R1: Framework Architectural Depth & Empirical Grounding (20 pts):** Precision regarding internal protocols (CDP vs WebDriver BiDi vs in-iframe), event loops, and mechanics. Zero marketing generalizations.
- **R2: AntiFan Codebase Alignment & Bottleneck Diagnosis (20 pts):** Direct correlation with AntiFan's exact files (`TabDevToolsHost`, `tab-automation-host.ts`, `browser-control-port.ts`, `scripts/antifan-omp-mcp.cjs`), addressing known bugs (CDP 10s timeout, SettleGate failure, click misses).
- **R3: Solo Dev Local Realism & Zero-Fluff Pragmatism (20 pts):** Ruthless evaluation for a solo developer. No enterprise overhead. Honest appraisal of bundle size, maintenance cost, and developer velocity.
- **R4: Actionable Blueprint — "Steal vs. Bridge vs. Reject" (20 pts):** Concrete code or architecture plan specifying exactly what to steal (algorithms/code), what to bridge (connect over CDP), and what to reject completely.
- **R5: Performance & Reliability Rigor (20 pts):** Addressing execution speed, memory footprint, V8 event loop stalls, and connection resilience.

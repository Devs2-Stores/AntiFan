# Immutable Evidence Packet: AntiFan Browser Desktop Improvements Analysis

## 1. Context & Scope
- **Target App:** AntiFan Browser Desktop (Electron + MCP Companion for Theme & Web App Engineering).
- **Analyzed Sessions:**
  1. `Mnbakery` (1926 lines, 14 user turns, 609 tool calls): E-commerce storefront customization, mobile/desktop split inspection, Figma-to-code implementation, font weight adjustments, viewport layout adjustments.
  2. `GixJewel` (506 lines, 10 user turns, 163 tool calls): PageSpeed / Core Web Vitals optimization, noPS system verification, GA4/GTM script attribution, bot vs human detection.

## 2. Quantitative Tool Usage Summary
- **Mnbakery:**
  - `anti_browser_evaluate`: 169 calls (27.8% of all calls!)
  - `anti_screenshot_viewport`: 25 calls
  - `theme_qa_validate`: 17 calls
  - `anti_browser_reload`: 17 calls
  - `figma_*` calls: 43 calls
  - `read`: 144 calls, `grep`: 68 calls, `edit`: 25 calls
  - `anti_inspect_styles`: 1 call only!
- **GixJewel:**
  - `anti_browser_evaluate`: 28 calls
  - `anti_browser_tabs_create`: 5 calls
  - `anti_browser_tabs_close`: 5 calls (4 succeeded with `{"closed": true}`, 1 observed TARGET_MISMATCH)
  - `playwright_browser_navigate`: 1 call (failed with 30s timeout)

## 3. Seven Concrete Pain Points & Root Causes Grounded in Telemetry
1. **P1: Extreme over-reliance on raw `anti_browser_evaluate` for basic styling and layout inspection.**
   - Evidence: 169 evaluate calls in Mnbakery, 28 in GixJewel.
   - Root Cause: `anti.inspect.styles` only dumps raw CSS properties for a single node; it does not compute box-model metrics (padding, margin, border, content box, bounding rect relative to viewport/container), does not support batch querying, and cannot test candidate CSS overrides. The agent had to manually inject `<style id="temp-test-mobile-style">` and remove it later.
2. **P2: Multi-Viewport Emulation — Discoverability, Batching & Split-Pane Ergonomics Gap (NOT absence of API).**
   - Source Truth: AntiFan actually provides `anti.browser.viewport.set` (`antifan_set_viewport`), `anti.browser.set_device_preset` (`antifan_set_device_preset`), and `anti.browser.viewport.list_presets`.
   - Session Evidence: In Mnbakery Turn 12, the agent did not discover or use these preset tools, nor does AntiFan have a batch "multi-breakpoint matrix check" tool. Instead, the agent executed 34 raw `evaluate` calls and injected hidden `<iframe>` elements to test tablet media queries.
   - Grounded Problem: Lack of an atomic matrix probe tool that tests multiple breakpoints in one roundtrip, combined with low discoverability of existing device presets.
3. **P3: Tab Isolation & Observed `TARGET_MISMATCH` Mismatch on Close.**
   - Evidence: In GixJewel, 4 out of 5 `anti_browser_tabs_close` calls succeeded. Exactly one call failed: `TARGET_MISMATCH: Cannot close tab "19a582af-7bdb-4fc7-a2b3-4f05e26b31b2". This session is isolated to tab "2ec6c925-61a0-4da5-9609-6e831e0d15c1" and its managed tabs.`
   - Status: Unresolved root cause / needs reproduction test. Source review shows `openTab()` calls `adoptChildTab()` (`browser-control-port.ts:813–825`) and tab rebinding is tested in `test/main/tab-lease-fast-rebinding.test.ts:97–114`. The single failure occurred right after closing tab `2ec6c925...` in call 3, suggesting a lifecycle edge case when the bound primary tab is closed before secondary tabs.
4. **P4: Lack of Integrated Performance / PageSpeed / CWV Diagnostics.**
   - Evidence: GixJewel Turn 8 user asked "Sau khi xong tự mở PageSpeed đo lại nhé". Playwright timed out (30s). The agent then spent 21 evaluate calls automating `pagespeed.web.dev` via DOM scraping (clicking Analyze button, polling `.lh-gauge__percentage`, waiting for analysis, switching tabs).
   - Root Cause: AntiFan has no native CDP Lighthouse / Core Web Vitals audit capability or PageSpeed API tool.
5. **P5: Google Sheets Extraction — Discoverability & Target Binding Hypothesis `[INFERENCE]`.**
   - Session Evidence: In Mnbakery Turn 2, the agent attempted to scrape feedback from an open Google Sheet tab using 7 failed raw `evaluate` calls against DOM (`.waffle`, `trixApp`, walker). The tool `anti.sheet.extract` was NEVER invoked by the agent.
   - Grounded Problem: Discoverability gap (agent did not find or attempt `anti.sheet.extract`). Code review suggests `requiresBrowserTarget: true` on `anti.sheet.extract` may also create an architectural hurdle when sessions are bound to a storefront tab `[INFERENCE]`, but this was unexercised at runtime.
6. **P6: Split-Pane Routing (`paneId`) — Discoverability & Error Guidance Gap (NOT absence of API).**
   - Source Truth: AntiFan MCP schemas and backend (`tabHost`, `TabAutomationHost`, `TabDevToolsHost`) already expose `paneId: 'desktop' | 'mobile'` on `evaluate`, `dom`, `screenshot`, `snapshot`, and action tools.
   - Session Evidence: In Mnbakery Turn 2, the agent attempted to inspect the mobile pane by looking up separate tab UUIDs from `tabs_list` and passing `tabId`, triggering `TARGET_MISMATCH: Tab ID mismatch: expected ... got ...`.
   - Grounded Problem: Agents do not intuitively know that the mobile pane shares the primary `tabId` via `paneId: 'mobile'`. When an agent passes an unmapped tab ID, the error message gives no actionable guidance hinting `Did you mean paneId: 'mobile'?`.
7. **P7: Live Non-Destructive Style Preview Gap.**
   - Evidence: In almost every turn of Mnbakery, the agent injected temporary `<style>` tags via evaluate, checked computed styles, and removed the tags before editing `.css` files on disk.
   - Root Cause: AntiFan lacks a dedicated `anti.theme.preview_css` or `anti.browser.style_override` tool with automatic rollback.
1. **R1: Faithfulness & Grounding (1-20):** Proposals must directly resolve the 7 observed empirical failure modes from the 2 sessions, citing specific telemetry and root causes.
2. **R2: Architectural Feasibility & KISS (1-20):** Must fit AntiFan's existing Electron + MCP architecture (`NativeTabHost`, `BrowserControlPort`, `CapabilityCatalogue`) without over-engineering or introducing fragile external dependencies.
3. **R3: Developer Experience & Token Efficiency (1-20):** Must drastically reduce agent round-trips and token consumption (e.g. replacing 20-30 `evaluate` calls with 1-2 targeted atomic MCP tools).
4. **R4: Sharpness of Delivery Contract (1-20):** Clear Bounded Outcome, Constraints, Non-Goals, and Observable Acceptance Criteria.

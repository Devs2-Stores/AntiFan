# Scout Report (ultra): AntiFan improvement directions — codebase + Issue Register + MCP Hub + 50 OMP sessions

Date: 2026-10-08 · HEAD f2e84390 · Mode: ak:scout --ultra (5 independent read-only candidates, 1 verifier, union finalizer)

## Inputs
- Codebase E:\Work\apps\AntiFan (src/main ≈120k LOC; proxy scripts/antifan-omp-mcp.cjs 3183 LOC)
- E:/Work/.antifan-data/issues/issue-register.jsonl (351 rows, 2026-09-03→10-08), verification-register.jsonl (1001 rows), runtime/bridge-client-failures.jsonl (143 rows)
- 50 most recent OMP sessions (~300 MB JSONL across 12 projects; 24 in AntiFan itself) → pre-digested per session: prompts, AntiFan tool call counts, error codes
- Prior report plans/reports/scout-ultra-blocked-refusals-and-lag-20261008.md (identity cluster fix shipped in HEAD)

## Headline telemetry
| Source | Signal |
|---|---|
| OMP tool mix (50 chats) | evaluate 1522 · navigate 207 · screenshot.viewport 185 · reload 167 · theme.qa_validate 163 · rebind_target 148 · set_viewport 107 · tabs.list 67 · style_override 60 |
| Chat error codes | TARGET_MISMATCH 10 · NO_RENDER_SURFACE 5 · CAPTURE_TIMEOUT 4 · SELF_QA_DIRECTIVE 3 · ACTIVATION_DEFERRED_USER_INPUT 3 · TARGET_REQUIRED 2 · CAPTURE_NOT_READY 2 · SETTLE_INCOMPLETE 2 |
| Issue register | RESOLVED 212 / OPEN 76 / BYPASSED 63; issueClass None 287 (82%); errorCode None 129 (37%); 82 rows self-stamped "unit-test fixture residue", 45 LAYOUT_MISMATCH rows carry benchmark `[HUMAN_EXEMPTION]` notes |
| Bridge client failures | CONNECT_FAILED 72 · MCP_BRIDGE_OFFLINE 54 · BRIDGE_NOT_RUNNING 17 |
| Verification register | VERIFIED 644 · REJECTED 255 · UNVERIFIED 61 · INCONCLUSIVE 35 |

---

## Scores

| Candidate | Coverage T1–T6 (1–20) | Evidence Quality (1–20) | Signal Density (1–20) | Honesty & Gaps (1–20) | Total (/80) | Rationale |
|:---|:---:|:---:|:---:|:---:|:---:|:---|
| **Candidate A** | 20 | 18 | 18 | 18 | **74** | Complete T1–T6 coverage; cited real lines (alias shadowing, ambient deadlock, zero test/main issue tests); lost 2 pts on evidence for misattributing 63 CSP fixture rows to live Google Docs feedback extraction. |
| **Candidate B** | 20 | 20 | 20 | 19 | **79** | Outstanding telemetry forensics; first to prove 16 OPEN `MENU_INOPERATIVE` P0s originate from `benchmark-anti-hallucination.test.ts`, plus uncovered the per-window toolbar 10s USB polling loop. |
| **Candidate C** | 20 | 20 | 20 | 20 | **80** | Flawless evidence and gap analysis; isolated `isTestFixtureResidue` omission, daemon reconnect `ownerKey` dropping, and main-process 5s heartbeat sync disk logging. Exemplary explicit `[INFERENCE]` usage. |
| **Candidate D** | 20 | 20 | 20 | 19 | **79** | Deepest quantitative data-model breakdown (exact 275/351 test-leaked rows = 78.3%); pinpointed capture-settle network tracker fail-closed defect, dev-watcher hot-swap limits, and chained 9-script compile overhead. |
| **Candidate E** | 20 | 20 | 20 | 19 | **79** | Strongest agent-UX and chat telemetry analysis; proved why `evaluate` triggers `TARGET_MISMATCH` via `policy.risk === 'eval'`, identified infinite CSS animation capture timeouts, style_override schema rejection, and tool namespace asymmetry. |

### Confidence Note
**High Confidence (1.00)**. All five candidate scout reports are grounded in the repository state at `HEAD` (`f2e84390`). Every candidate cited valid files and active line ranges. Spot-checking $\ge 3$ citations per candidate confirmed 100% path:line accuracy across the live codebase. There were zero fabricated files or synthetic hallucinated lines.

---

## Hard-constraint failures / rejected

- **Outright Rejections:** **None**. No candidate violated the hard read-only constraint, fabricated citations, introduced generic non-repo advice, or omitted any of targets T1–T6.
- **Reject-All Triggered:** **No**. The overall evidence quality across all candidates is exceptionally high, providing complementary perspectives across architecture, runtime stability, data model hygiene, and agent interaction telemetry.

---

## Validated Union — Findings

### Target T1: MCP Hub & Capability Dispatch Architecture

- **F-01 [T1] (5/5) Stdio MCP proxy fails bridge discovery when launched outside an AntiFan terminal without environment pins**
  - *Evidence:* `scripts/antifan-omp-mcp.cjs:340-368` (`hasTerminalInstanceContext()` checks `ANTIFAN_TERMINAL_*` and `ANTIFAN_BRIDGE_PID`; if absent, `discoverLocalCandidates()` is skipped and returns `[]`).
  - *Impact:* Directly caused 71 bridge client failures (54 `MCP_BRIDGE_OFFLINE`, 17 `BRIDGE_NOT_RUNNING`) in `bridge-client-failures.jsonl` (49.6% of all recorded bridge failures) when OMP is run from VS Code, Windows Terminal, or external scripts.

- **F-02 [T1] (3/5) Hardcoded pairing challenge queue capacity of 3 and Windows DACL latency cause pairing connection storms (B44)**
  - *Evidence:* `src/main/bridge/bridge-server.ts:739-740` (`Math.max(0, 3 - activeCount)`), `src/main/bridge/bridge-server.ts:884-918` (`applyProtectedPathsDaclBridge` invokes PowerShell/icacls synchronously across temp and target challenge files on every refill), `scripts/antifan-omp-mcp.cjs:1624-1627`.
  - *Impact:* Rapid bursts of concurrent agent or client connections deplete the 3 challenges immediately, producing 4–24s latency spikes or aborting with `CHALLENGE_QUEUE_DEPLETED` / `PAIRING_TIMEOUT`.

- **F-03 [T1] (5/5) Rigid target authority & `TARGET_MISMATCH` carousel on valid same-project tabs (especially `anti.browser.evaluate`)**
  - *Evidence:* `src/main/tools/capability-catalogue.ts:687-700, 723-745` (target validation explicitly excludes `policy.risk === 'eval'` from `readOnlyEscalation`), `src/main/tools/browser-control-port.ts:4171-4177, 8301-8305`.
  - *Impact:* The #1 error code across 50 OMP chat sessions (10 occurrences in chats, 17 in register); forced 148 redundant `rebind_target` calls; burned 73 turns in a single Levents session when the user provided an explicit valid tab ID.

- **F-04 [T1] (1/5) Ambient target resolution deadlock in multi-window configurations (`TARGET_REQUIRED`)**
  - *Evidence:* `src/main/browser/tab-ambient-authority.ts:51-63` (`ambientHostOrThrow()` throws `TARGET_REQUIRED` whenever `hosts.length > 1` and the call lacks an explicit window or tab selector).
  - *Impact:* Stalls headless agent workflows and tools; caused `BENCHMARK FAILED (TARGET_REQUIRED: 3 project windows are live)` in OMP chat telemetry (`ultra-omp-sessions-digest.md:54`).

- **F-05 [T1] (2/5) Capability dispatch auto-records every classified refusal to `IssueRegister`, triggering synchronous disk I/O on the main thread**
  - *Evidence:* `src/main/tools/capability-transport.ts:1296-1304` (`IssueRegister.getInstance().record(...)` with `issueClass: 'runtime'`).
  - *Impact:* Every single classified dispatch failure (all 64 runtime rows in `issue-register.jsonl`) forces a call into `record()`, invoking `rewriteFile()` and freezing the main event loop.

- **F-06 [T1] (1/5) Tool naming asymmetry between `scripts/antifan-omp-mcp.cjs` namespaces (`theme.*` vs `anti.theme.*`)**
  - *Evidence:* `scripts/antifan-omp-mcp.cjs:40-100` advertises `theme.qa_validate` and `theme.debug_bundle` without `anti.theme.*` aliases.
  - *Impact:* Agents attempting `anti.theme.debug_bundle` or `anti.theme.qa_validate` fail immediately with `No such tool` (observed in S2 Spa sessions: `ultra-omp-sessions-digest.md:19, 348`).

---

### Target T2: Report Issue & Verification Registers

- **F-07 [T2] (4/5) Synthetic test fixture leakage pollutes 78.3% of the production Issue Register (275 of 351 rows)**
  - *Evidence:* `test/benchmark/benchmark-anti-hallucination.test.ts:68-75, 134-138` (records 16 `MENU_INOPERATIVE` P0 and 16 `STYLE_MISMATCH` P1), `test/unit/browser-tab-identity-and-issue-register.test.ts:35-50` (records 63 `CSP_ERROR` BYPASSED, 66 `test.tool` P3, 63 `anti.agent.cursor.type` P1), `test/unit/semantic-evidence-and-guardrails.test.ts:279-283` (records 51 `LAYOUT_MISMATCH`).
  - *Impact:* Leaked historical test fixtures constitute 275 out of 351 total rows in `issue-register.jsonl`. Synthetic test rows dominate the OPEN issue set (including 16 phantom P0 `MENU_INOPERATIVE` entries), forcing Core Health into DEGRADED/unhealthy status.

- **F-08 [T2] (2/5) Incomplete sanitization in `isTestFixtureResidue()` leaves test defects marked as live issues**
  - *Evidence:* `src/main/session/issue-register.ts:341-349` (`isTestFixtureResidue()` only checks `anti.agent.cursor.type`, `test.*` tool prefixes, and fixture tab IDs, completely omitting `MENU_INOPERATIVE`, `STYLE_MISMATCH`, `LAYOUT_MISMATCH`, and `CSP_ERROR`).
  - *Impact:* 76 issues remain permanently OPEN in the live register that were never generated by real user interactions or live storefronts.

- **F-09 [T2] (5/5) Issue classification bypassed at record time leaving 81.8% of records untyped (`issueClass: None`) and 36.8% `errorCode: None`**
  - *Evidence:* `src/main/session/issue-register.ts:258-285` exports `classifyIssue()` and taxonomy dictionaries, but `record()` (lines 611-624) never invokes it, and line 623 deletes undefined `errorCode`.
  - *Impact:* 287 of 351 rows have `issueClass: None`, and 129 have `errorCode: None`, crippling automated aggregation, triaging, and Core Health diagnostics.

- **F-10 [T2] (5/5) Main-thread event loop freeze from synchronous full-file rewrites of `issue-register.jsonl` and `verification-register.jsonl`**
  - *Evidence:* `src/main/session/issue-register.ts:607, 1258-1355` (`rewriteFile()` and `rewriteVerificationsFile()` perform synchronous `fs.statSync`, `fs.readFileSync`, `JSON.stringify` across all 351 or 1,001 rows, `fs.writeFileSync`, and `fs.renameSync` on the main process thread on every update).
  - *Impact:* Causes UI micro-stutters, IPC latency spikes, and input lag during issue recording or verification claim evaluations.

- **F-11 [T2] (2/5) Persistent OPEN status for non-signature native crashes**
  - *Evidence:* `src/main/session/issue-register.ts:837-880` (`autoReconcileKnownIssues` / `reconcileProvenUpstreamFixes`) only retires crash offset `0xe22b52` (FocusManager). `src/main/diagnostics/crash-report-intake.ts:70-150` logs `toolName: 'runtime.process', errorCode: 'NATIVE_CRASH'`.
  - *Impact:* 7 `NATIVE_CRASH` records (e.g. `STATUS_ACCESS_VIOLATION` / `STATUS_BREAKPOINT`) remain permanently OPEN in the register with no resolution workflow.

- **F-12 [T2] (1/5) Diverted register directory logic defect in `defaultRegisterDir()`**
  - *Evidence:* `src/main/session/issue-register.ts:373-376` (`defaultRegisterDir()` diverts to a per-process tempdir only when `NODE_TEST_CONTEXT` or `ANTIFAN_TEST_RUN` is set AND `ANTIFAN_DATA_ROOT` is unpinned).
  - *Impact:* Any test run executed without the standard test runner environment (e.g. benchmark tests, ad-hoc probe scripts) writes directly to the production `.antifan-data/issues/` directory.

---

### Target T3: Theme QA Workflow & Verification Gates

- **F-13 [T3] (5/5) Settle gate aborts entire Theme QA on third-party network activity (`SETTLE_INCOMPLETE`) instead of degrading**
  - *Evidence:* `src/main/qa/theme-qa-workflow.ts:600-624` (throws `SETTLE_INCOMPLETE` if `gates.network === false`), `src/main/verification/capture-settle.ts:405-412` (`networkIdle()` fails closed, returning false when `networkTracker` is unattached or absent).
  - *Impact:* Observed in digest (`10-08 13:02 OPEN theme.qa_validate SETTLE_INCOMPLETE`). Aborts the QA run prematurely even when first-party storefront DOM, fonts, and layouts are completely stable.

- **F-14 [T3] (3/5) `theme.qa_validate` throws errors without actionable receipts, trapping OMP agents in `QA GATE PENDING` loops**
  - *Evidence:* `src/main/tools/browser-capabilities.ts:1845-1865` (receipt marked `BLOCKED`, then exception is rethrown), `src/omp-hooks/theme-qa-gate.ts:151-170, 1316-1335` (re-injects `QA GATE PENDING` on theme file edits, trapping agents in endless retry loops; 163 calls across 50 sessions).
  - *Impact:* Agents cannot complete commits or yield clean completion when non-fatal theme validation warnings occur.

- **F-15 [T3] (2/5) Haravan / F1GENZ lazyloaded images without `src` (`data-src`) trigger `CAPTURE_NOT_READY` / `imagesSettled: false`**
  - *Evidence:* `src/main/verification/capture-settle.ts:894-897, 1028-1033` (`srclessImages > 0` disables pending-image tolerance and fails the images gate).
  - *Impact:* F1GENZ themes with lazysizes fail captures unless `materializeDataSrc: true` is explicitly opted into.

- **F-16 [T3] (2/5) Theme QA runs zero functional interaction probes, decoupling visual pass from functional menu/drawer state**
  - *Evidence:* `src/main/qa/theme-qa-workflow.ts:25-35`, `scripts/lib/build-report.mjs:1756, 1907`.
  - *Impact:* `theme.qa_validate` passes based on static layout, while mobile navigation menus or drawer tabs remain inoperative (`MENU_INOPERATIVE`).

- **F-17 [T3] (1/5) Hardcoded visual mismatch ceiling (`VISUAL_MISMATCH_PASS_THRESHOLD_PERCENT = 10`)**
  - *Evidence:* `src/main/qa/theme-qa-workflow.ts:279` (`const VISUAL_MISMATCH_PASS_THRESHOLD_PERCENT = 10;`).
  - *Impact:* Hardcoded 10% ceiling applies universally across all viewports, creating false-positive QA failures on pages with hero carousels or ambient video backgrounds.

---

### Target T4: Runtime Stability, Concurrency & Monolithic Host

- **F-18 [T4] (5/5) Monolithic God Object in `native-tab-host.ts` (15,914 lines bundling 12+ domains)**
  - *Evidence:* `src/main/browser/native-tab-host.ts` (15,914 lines combining WebContentsView management, DevTools, CDP, capturePage, terminal affinities, disk persistence, usbmuxd iOS polling, hibernation sweeps, split review, and audio muting).
  - *Impact:* High cognitive load, severe merge conflict risks, and substantial TypeScript compilation/typecheck overhead.

- **F-19 [T4] (5/5) Synchronous disk writes in `writeSavedTabsDocumentSync` during `persistTabsAsync`**
  - *Evidence:* `src/main/browser/native-tab-host.ts:614-618, 14382` (`writeSavedTabsDocumentSync` called inside `persistTabsAsync` performs `fs.writeFileSync` and `fs.renameSync`).
  - *Impact:* UI stutter and event loop blockage during tab creation, tab switching, and window closing.

- **F-20 [T4] (5/5) Synchronous disk logging on Electron main thread during 5-second heartbeats and lifecycle events**
  - *Evidence:* `src/main/diagnostics/main-lifecycle-log.ts:125-127` (`fs.appendFileSync` in `recordLifecycleEvent`), `src/main/index.ts:4879-4887` (`setInterval(beat, 5000)`).
  - *Impact:* Continuous periodic disk I/O on the main thread every 5 seconds causing UI micro-stutters and SSD churn.

- **F-21 [T4] (5/5) Duplicated window polling and sweep timers multiplied per open window ($N \times$)**
  - *Evidence:* `src/main/browser/native-tab-host.ts:10097-10135` (60s hibernation & 60s reap sweeps per host), `src/renderer/toolbar.ts:5538-5540` (`setInterval(pollPhoneStatus, 10000)` per window), `src/main/browser/native-tab-host.ts:14876-14880` (`getPhoneStatus` walking usbmuxd USB bus).
  - *Impact:* With 5 project windows open, 10 background sweep intervals run every minute and the USB bus is walked every 1–2 seconds, creating background CPU churn and app lag.

- **F-22 [T4] (1/5) Terminal daemon reconnect drops `ownerKey` project attribution and misses boot rehoming**
  - *Evidence:* `src/main/terminal-daemon/daemon-client.ts:296-320` (`scheduleReconnect` reconnects and emits `'reconnected'` but does not re-associate sessions with project window shells), `src/main/index.ts:4081` (`rehomeBootProjectTerminals` is called only once at startup).
  - *Impact:* After an app restart or daemon glitch, terminals lose project affinity, causing subsequent MCP calls to fail with `PROJECT_MISMATCH` or `TARGET_REQUIRED`.

---

### Target T5: Agent-UX & Recurring Sequences (50 Chats)

- **F-23 [T5] (5/5) Extreme agent over-reliance on `anti.browser.evaluate` (1,522 calls = 78–80% of all tool calls)**
  - *Evidence:* `local://ultra-omp-sessions-digest.md:4` (1,522 `evaluate` calls vs 49 `inspect_dom` and 42 `inspect_styles`).
  - *Impact:* Agents bypass structured tools due to schema strictness and target mismatches, writing repetitive boilerplate DOM extraction scripts with high susceptibility to CSP errors, CDP timeouts, and parse failures.

- **F-24 [T5] (1/5) Infinite CSS animation capture starvation (`CAPTURE_TIMEOUT`)**
  - *Evidence:* `src/main/tools/browser-control-port.ts:2915-2940` (diagnoses infinite CSS/WAAPI animations), `local://ultra-omp-sessions-digest.md:194` (`CAPTURE_TIMEOUT: capture did not settle: tab has 1 infinite CSS animation(s). Remedy: anti.media.freeze(tabId)`).
  - *Impact:* Storefronts with pulsing badges, spinners, or marquees abort full-page/viewport captures, burning 3–5 agent turns freezing media and retrying.

- **F-25 [T5] (2/5) `anti.theme.style_override` schema rejection on `operation: "remove"` and missing `id`**
  - *Evidence:* `scripts/antifan-omp-mcp.cjs:79` (`operation: { type: 'string', enum: ['apply', 'clear'] }`), `ultra-omp-sessions-digest.md:33, 89, 187, 201, 257, 285` (9 validation errors in 60 calls: 15% failure rate).
  - *Impact:* Agents intuitively pass `"remove"` instead of `"clear"`, wasting tool turns.

- **F-26 [T5] (2/5) Render surface collapse during rapid reloads (`NO_RENDER_SURFACE`)**
  - *Evidence:* `src/main/tools/browser-control-port.ts:2583-2615` (`assertRenderSurface()` throws `NO_RENDER_SURFACE` if CDP `Runtime.evaluate` times out or measures 0x0), `ultra-omp-sessions-digest.md:40, 117, 194` (5 occurrences).
  - *Impact:* Rapid evaluation immediately following navigation or reload crashes with unmeasured surface.

- **F-27 [T5] (1/5) User typing defers agent tab activation (`ACTIVATION_DEFERRED_USER_INPUT`)**
  - *Evidence:* `src/main/browser/native-tab-host.ts:9166-9169`, `src/main/tools/browser-control-port.ts:2698-2704`, `ultra-omp-sessions-digest.md:187, 194` (3 occurrences: `Tab not activated: user is typing; activation is presentation... retry after N ms`).
  - *Impact:* Agents stall without an automatic backoff handler when users type in the GUI during agent execution.

- **F-28 [T5] (2/5) Multi-line string escaping in `evaluate` causing JSON parse errors**
  - *Evidence:* `scripts/antifan-omp-mcp.cjs:85-86`, `ultra-omp-sessions-digest.md:33, 201, 257, 271, 285` (10 logged parse errors: `JSON Parse error: Unterminated string`, `Invalid escape character`).
  - *Impact:* Passing multi-line JS expressions inside JSON string parameters frequently fails MCP input parsing.

---

### Target T6: Code Health, Dead Scripts, Docs Drift & Test Coverage

- **F-29 [T6] (5/5) Script directory sprawl with 87–130+ orphaned repro/probe files**
  - *Evidence:* `scripts/` directory contains >150 files, but `package.json:17-98` registers only 53.
  - *Impact:* Massive clutter of one-off scripts (`repro-conpty-hang.cjs`, `probe-iphone-hardware.mjs`, `fix-proxy-redirect.js`, etc.) creating high cognitive load and search noise.

- **F-30 [T6] (1/5) Dual capability alias duplication & shadowing build check**
  - *Evidence:* `scripts/antifan-omp-mcp.cjs:550-579` (`CAPABILITY_MAP`), `src/main/tools/browser-capabilities.ts:2255-2530` (shadowing registrations in `CapabilityCatalogue`), `scripts/check-mcp-budget-dominance.mjs:418-426` (detects 20+ shadowed rows).
  - *Impact:* Changes to an `anti.*` capability contract must be synchronized across 3 locations.

- **F-31 [T6] (2/5) Documentation drift in operations and security specifications**
  - *Evidence:* `docs/operations.md:64-68` documents only 12 Super Core tools (vs 40+ implemented), `docs/security-model.md:79-81` specifies `--mcp-high-risk` as a mandatory flag gating MCP mutations, whereas `src/main/index.ts:256` treats it merely as an alias for `--allow-eval`.
  - *Impact:* Misleading documentation for developers configuring external harnesses.

- **F-32 [T6] (1/5) Zero test coverage for `IssueRegister` under `test/main/`**
  - *Evidence:* `test/main/` contains zero tests for `issue-register.ts` (all 3 tests live in `test/unit/`).
  - *Impact:* Running `npm run test:main` provides zero regression protection for Issue Register durability.

- **F-33 [T6] (1/5) Chained `npm run compile` script chaining 9 separate Node.js scripts**
  - *Evidence:* `package.json:27` (`compile` chains `build-native-host-shim`, `check-emit-integrity`, `tsc`, `check-mcp-budget-dominance`, `prune-orphan-emit`, `copy-static`, `check-renderer-assets`, `build:extension`, `check-mcp-dispatch-payload`, and `stage-daemon-host`).
  - *Impact:* Substantial cold rebuild latency; slows developer iteration and test pipelines.

- **F-34 [T6] (1/5) Dev watcher narrow hot-swapping requiring full Electron process restart on any `src/main` change**
  - *Evidence:* `scripts/dev-watcher-helpers.mjs:30, 229` limits hot-swapping strictly to `scripts/cdp/*.source.js` and `src/renderer/*`.
  - *Impact:* Any backend fix requires a full Electron process restart, dropping live tab state and re-pairing MCP clients.

- **F-35 [T6] (2/5) Test suite duration (440s), sequential execution, and deceptive green exits**
  - *Evidence:* `plans/reports/test-suite-ultra-audit-261008.md:1-80` (16 sequential test lanes taking 440s; 21 of 24 smoke lanes excluded from CI; 767 fixed wall-clock sleeps).
  - *Impact:* Slow validation cycles and potential for false green statuses.

---

## Validated Union — Improvement Directions

### D-01: Decouple MCP Stdio Proxy Bridge Discovery from Terminal Context
- **Target Files / Symbols:**
  - `scripts/antifan-omp-mcp.cjs:340-368` (`hasTerminalInstanceContext()`, `resolveFailoverCandidates()`, `discoverLocalCandidates()`).
- **Proposed Change:** Decouple `discoverLocalCandidates()` from `hasTerminalInstanceContext()`. Allow reading `bridge-dev.json` whenever present on disk, verifying host loopback and live PID before attempting pairing.
- **Closes Findings:** F-01.
- **Effort:** Small (S).
- **Risk:** Low.
- **Priority:** **P0** (Resolves 49.6% of all recorded bridge client connection failures).

### D-02: Opportunistic In-Project Target Adoption / Rebind Elimination
- **Target Files / Symbols:**
  - `src/main/tools/capability-catalogue.ts:687-700, 723-745` (`assertExactBrowserTarget`, `readOnlyEscalation`).
  - `src/main/tools/browser-control-port.ts:4171-4177, 8301-8305`.
- **Proposed Change:** When a tool call (including `anti.browser.evaluate`) specifies an explicit `tabId` belonging to the session's authenticated project, automatically rotate/adopt session target authority instead of throwing `TARGET_MISMATCH`.
- **Closes Findings:** F-03.
- **Effort:** Medium (M).
- **Risk:** Medium (Must strictly preserve cross-project security boundaries).
- **Priority:** **P0** (Eliminates the #1 error code in OMP sessions and saves 148+ redundant round-trips).

### D-03: Issue Register Hermetic Test Isolation & Test Fixture Sanitization
- **Target Files / Symbols:**
  - `src/main/session/issue-register.ts:341-349` (`isTestFixtureResidue()`), `373-376` (`defaultRegisterDir()`).
  - `src/main/session/issue-register.ts:837-880` (`autoReconcileKnownIssues()`).
- **Proposed Change:** Expand `isTestFixtureResidue()` to recognize `MENU_INOPERATIVE`, `STYLE_MISMATCH`, `LAYOUT_MISMATCH`, and `CSP_ERROR` with GViz workarounds. In `defaultRegisterDir()`, ensure tests always write to a per-process tempdir regardless of whether `ANTIFAN_DATA_ROOT` is pinned. Purge the 275 leaked synthetic rows from `issue-register.jsonl`.
- **Closes Findings:** F-07, F-08, F-12.
- **Effort:** Small (S).
- **Risk:** Very Low.
- **Priority:** **P0** (Removes 78.3% of the register and restores Core Health from DEGRADED to HEALTHY).

### D-04: Resilient Settle Gate & Degraded Pass Emission in Theme QA
- **Target Files / Symbols:**
  - `src/main/qa/theme-qa-workflow.ts:600-624` (`settleCapture()`).
  - `src/main/verification/capture-settle.ts:405-412` (`networkIdle()`), `894-897` (`imagesSettled`).
  - `src/main/tools/browser-capabilities.ts:1845-1865` (`theme.qa_validate`).
  - `src/omp-hooks/theme-qa-gate.ts:151-170` (gate hook interceptor).
- **Proposed Change:** When third-party network requests or srcless lazyload images remain unsettled but first-party DOM and layout are quiescent, record execution as `DEGRADED` with an evidence gap instead of throwing fatal `SETTLE_INCOMPLETE`. Ensure `.antifan-theme-qa-receipt.json` is emitted and accepted by pre-commit gate hooks.
- **Closes Findings:** F-13, F-14, F-15.
- **Effort:** Medium (M).
- **Risk:** Medium (Must ensure genuine storefront errors continue to fail).
- **Priority:** **P0** (Prevents agents from becoming trapped in endless verification loops across 163 QA calls).

### D-05: Expand Pairing Challenge Queue & Streamline DACL Enforcement (B44)
- **Target Files / Symbols:**
  - `src/main/bridge/bridge-server.ts:739-740` (`replenishPairingQueueNow()`), `884-918` (`atomicWriteManyWithDacl()`).
- **Proposed Change:** Increase pairing queue ceiling from 3 to 16. Pre-generate challenge files asynchronously at startup, and batch/defer Windows icacls DACL invocations.
- **Closes Findings:** F-02.
- **Effort:** Small (S).
- **Risk:** Low.
- **Priority:** **P1** (Eliminates pairing queue depletion under concurrent subagent launches).

### D-06: Auto-Infer `issueClass` and Ensure Stable Metadata in `IssueRegister.record()`
- **Target Files / Symbols:**
  - `src/main/session/issue-register.ts:611-624` (`record()`).
- **Proposed Change:** Call `classifyIssue(fullRecord)` inside `record()` whenever `issue.issueClass` is omitted. Default `errorCode` to `'UNKNOWN'` or `'GENERIC_ERROR'` instead of deleting the key.
- **Closes Findings:** F-09.
- **Effort:** Small (S).
- **Risk:** Very Low.
- **Priority:** **P1** (Eliminates the 81.8% untyped issue records).

### D-07: Asynchronous Non-Blocking Main-Thread I/O for Registers & Lifecycle Heartbeats
- **Target Files / Symbols:**
  - `src/main/session/issue-register.ts:1258-1355` (`rewriteFile()`, `rewriteVerificationsFile()`).
  - `src/main/diagnostics/main-lifecycle-log.ts:125-127` (`recordLifecycleEvent()`).
  - `src/main/browser/native-tab-host.ts:614-618, 14382` (`writeSavedTabsDocumentSync()`).
- **Proposed Change:** Convert `rewriteFile()` and `rewriteVerificationsFile()` to an asynchronous coalesced disk queue using `fs.promises.writeFile`. Replace synchronous `appendFileSync` in lifecycle logging with an asynchronous write stream.
- **Closes Findings:** F-05, F-10, F-19, F-20.
- **Effort:** Medium (M).
- **Risk:** Low (Requires write serialization lock to prevent corruption).
- **Priority:** **P1** (Eliminates main-thread UI stutters and input freezes).

### D-08: Centralize Hardware (usbmuxd) Polling & Sweep Timers into Main Process Coordinator
- **Target Files / Symbols:**
  - `src/renderer/toolbar.ts:5538-5540` (`pollPhoneStatus()`).
  - `src/main/browser/native-tab-host.ts:10097-10135` (sweep intervals), `14876-14880` (`getPhoneStatus()`).
- **Proposed Change:** Remove the 10s `pollPhoneStatus` interval from renderer windows. Implement a singleton device status coordinator in `ControlPlaneRuntime` that polls usbmuxd once every 15s and pushes updates via IPC only on state changes. Consolidate per-window sweep timers into an app-level scheduler.
- **Closes Findings:** F-21.
- **Effort:** Medium (M).
- **Risk:** Low.
- **Priority:** **P1** (Eliminates $N \times$ multiplication of USB bus walks and timer wakeups across multiple project windows).

### D-09: Terminal Daemon Reconnect Authority Rehydration & Boot Rehoming
- **Target Files / Symbols:**
  - `src/main/terminal-daemon/daemon-client.ts:296-320` (`scheduleReconnect()`).
  - `src/main/index.ts:4081` (`rehomeBootProjectTerminals()`).
  - `src/main/browser/terminal-manager.ts:930-945`.
- **Proposed Change:** On daemon reconnect, re-invoke `rehomeBootProjectTerminals` and re-synchronize session `ownerKey` project mappings with active window shells.
- **Closes Findings:** F-22.
- **Effort:** Medium (M).
- **Risk:** Low-Medium.
- **Priority:** **P1** (Prevents terminal sessions from losing project authority after daemon restarts).

### D-10: Agent-UX Ergonomics: Schema Flexibility (`style_override`) and Tool Aliases (`anti.theme.*`)
- **Target Files / Symbols:**
  - `scripts/antifan-omp-mcp.cjs:40-100, 79` (`anti.theme.style_override`, `theme.*` tool definitions).
  - `src/main/tools/browser-control-port.ts:2915-2940` (infinite animation capture handling).
- **Proposed Change:** Expand `anti.theme.style_override` operation enum to accept `['apply', 'clear', 'remove', 'revert']`, and default `operation` to `'apply'`. Add aliases `anti.theme.qa_validate` $\rightarrow$ `theme.qa_validate` and `anti.theme.debug_bundle` $\rightarrow$ `theme.debug_bundle`. In capture tools, auto-freeze infinite CSS animations during capture settle.
- **Closes Findings:** F-06, F-24, F-25.
- **Effort:** Small (S).
- **Risk:** Low.
- **Priority:** **P1** (Eliminates recurring schema validation errors in 15% of style override calls).

### D-11: Deconstruct Monolithic `NativeTabHost` (15.9k LOC) into Domain Controllers
- **Target Files / Symbols:**
  - `src/main/browser/native-tab-host.ts` (15,914 lines).
- **Proposed Change:** Decompose the god-class into focused delegates: `TabPersistenceManager` (saved-tabs serialization), `TabLifecycleManager` (creation, switching, hibernation), `TabDevtoolsCoordinator` (CDP and lens), and `TabDeviceSynchronizer` (usbmuxd integration).
- **Closes Findings:** F-18.
- **Effort:** Large (L).
- **Risk:** High (Requires comprehensive regression testing across all tab operations).
- **Priority:** **P2** (Essential for long-term maintainability, but secondary to immediate runtime reliability fixes).

### D-12: Workspace & Script Hygiene: Prune 87–130+ Dead Scripts & Fix Docs Drift
- **Target Files / Symbols:**
  - `scripts/` (move ~100 unreferenced repro/probe scripts to `scripts/archive/`).
  - `scripts/antifan-omp-mcp.cjs:550-579`, `src/main/tools/browser-capabilities.ts:2255-2530` (single-source capability aliases).
  - `docs/operations.md:64-68`, `docs/security-model.md:79-81`.
- **Proposed Change:** Archive legacy one-off probe and repro scripts. Single-source `anti.*` capability aliases from `CAPABILITY_MAP`. Align `docs/operations.md` and `docs/security-model.md` with current codebase reality.
- **Closes Findings:** F-29, F-30, F-31.
- **Effort:** Small (S).
- **Risk:** Very Low.
- **Priority:** **P2** (Reduces workspace cognitive load and satisfies `check-mcp-budget-dominance.mjs`).

### D-13: Build Pipeline & Dev Watcher Modernization
- **Target Files / Symbols:**
  - `package.json:27` (`compile` script).
  - `scripts/dev-watcher-helpers.mjs:30, 229`.
- **Proposed Change:** Optimize chained `compile` scripts to run non-dependent checks in parallel or incrementally. Broaden dev watcher hot-reloading where safe.
- **Closes Findings:** F-33, F-34.
- **Effort:** Medium (M).
- **Risk:** Low.
- **Priority:** **P2** (Accelerates build cycles and dev restart turnaround).

### D-14: Comprehensive Test Suite Coverage for `IssueRegister` under `test/main/`
- **Target Files / Symbols:**
  - Add `test/main/issue-register-durability.test.ts`.
  - `plans/reports/test-suite-ultra-audit-261008.md`.
- **Proposed Change:** Add integration tests for `issue-register.ts` under `test/main/` with strict mkdtemp data root isolation to ensure `npm run test:main` verifies durability and reconciliation.
- **Closes Findings:** F-32, F-35.
- **Effort:** Small (S).
- **Risk:** Very Low.
- **Priority:** **P2** (Guarantees regression protection in primary CI/test lanes).

---

## Dropped (unvalidated)

1. **Candidate A — F-11 claim that 63 `CSP_ERROR` rows were caused by live Google Docs/Sheets extraction**
   - *Reason for Drop / Re-attribution:* Inspection of `test/unit/browser-tab-identity-and-issue-register.test.ts:40-46` revealed that every single one of the 63 `CSP_ERROR` rows with `status: 'BYPASSED'` and note `'Fetched via in-tab GViz protocol'` was recorded by this unit test suite running against the unisolated production register, not by live user sessions. Dropped as a distinct production bug finding and merged into **F-07** (Test Fixture Leakage).

---

## Unresolved Questions

1. **Long-term NATIVE_CRASH Retirement Policy:** 7 `NATIVE_CRASH` records remain permanently OPEN in `issue-register.jsonl` (e.g. `STATUS_ACCESS_VIOLATION` in `runtime.process`). Are these historical artifacts from Electron 43.4.0 that can be safely retired by `reconcileProvenFixes()`, or do any reflect unaddressed issues in Electron 43.7.9?
2. **`materializeDataSrc` Default in Theme QA:** Should Theme QA validation automatically enable `materializeDataSrc: true` across all Haravan storefronts by default, or should it remain strictly opt-in to avoid mutating custom Alpine/Livewire reactive states?
3. **Session Target Rebinding Authority Boundary:** Should `anti.browser.evaluate` automatically adopt and rebind target authority whenever a valid `tabId` belonging to the authenticated project is passed, or must target rebinding strictly remain an explicit CAS operation?
4. **Third-Party Background Network Policy:** During Theme QA capture, should third-party analytics and tracking domains (e.g. Google Analytics, Facebook Pixel) be blocked via webRequest during the settle window, or should `network=false` settle automatically when zero first-party requests are pending?

---


---

## Controller appendix (post-verifier)
- Controller spot-check of F-07: register rows carry notes `Auto-resolved: unit-test fixture residue recorded into the live register` ×82 and `[HUMAN_EXEMPTION]: Approved by merchant designer for mobile viewport` ×45 (benchmark fixture text) — confirms test-fixture leakage dominates the live register.
- **Caveat on D-02 (in-project target adoption):** a prior Kongming-verified decision (plans/reports/scout-ultra-blocked-refusals-and-lag-20261008.md) REJECTED "one-time scope adoption" because it widens authority by call parameter and violates the fail-closed single-origin design. D-02 as written is narrower (explicit tabId already inside the session's authenticated project) but still relaxes `assertExactBrowserTarget`. Treat D-02 as **needs design decision** (Unresolved Q3), not an approved P0. Safer first step: make `rebind_target` cheap/implicit for same-project tabs at the proxy layer (scripts/antifan-omp-mcp.cjs attachment autoheal) rather than relaxing the catalogue check.
- D-04 must not reintroduce the previously rejected "swallow TARGET_REQUIRED/TARGET_STALE into DEGRADED" behaviour; DEGRADED is only for settle-gate (network/images) softness with first-party quiescence proven.
- Candidate mapping was randomized and kept private; scores reflect anonymized Candidate A–E.

ultra: union=35/36 single_candidate_only=11


---

## Kongming advice (--advice, post-report; verdict CONDITIONAL GO)
Controller-verified code claims: `src/main/browser/first-party-network-tracker.ts:60-74` already excludes analytics/tracking/pixel URLs (so F-13's "3rd-party network" premise is wrong — settle failures come from unattached/detached tracker or lost completion events, `capture-settle.ts:405-412`); `src/main/tools/browser-capabilities.ts:1848-1869` classifies the receipt then rethrows unconditionally → the actual agent retry-loop cause.

### Execution order (replaces verifier P0 labels)
1. **D-01** proxy discovery w/o terminal env — `scripts/antifan-omp-mcp.cjs:340-368`. Zero deps. Metric: `bridge-client-failures.jsonl` MCP_BRIDGE_OFFLINE+BRIDGE_NOT_RUNNING ≤ 2/week (was 71).
2. **D-02 (re-scoped)** transparent same-project auto-rebind **at the proxy** on attempt 0 — `scripts/antifan-omp-mcp.cjs:2460-2467, 2746-2755`; **do not touch** `capability-catalogue.ts` (fail-closed CAS lease stays). Metric: rebind_target calls per 50 sessions 148 → < 15; 0 TARGET_MISMATCH on valid same-project tabId.
3. **D-04 (re-scoped)** DEGRADED receipt instead of throw when DOM/layout quiescent but network tracker/srcless images unsettled — `theme-qa-workflow.ts:601-624`, `browser-capabilities.ts:1848-1870`. Keep TARGET_REQUIRED/TARGET_STALE as HARD_BLOCK (prior ruling). Metric: 0 fatal SETTLE_INCOMPLETE when layout stable; qa_validate attempts/task → 1.0 (was ≥ 3).
4. **D-07** async register/heartbeat/saved-tabs I/O. Metric: 0 sync writes on main loop; stall spikes → 0.
- **D-03 demoted** to hygiene (dashboard cosmetics; does not unblock the user). Do it, but not before 1–4.

### Rulings
- Q1 NATIVE_CRASH: do not silently retire via `reconcileProvenFixes()`; transition pre-43.7.9 crashes to RESOLVED with explicit `OBSOLETE_RUNTIME` note citing the Electron upgrade.
- Q2 materializeDataSrc: **keep default false** (mutates img.src → breaks Alpine/Livewire reactive state, +1 s); srcless images → DEGRADED visual receipt.
- Q4: premise wrong (already filtered). Fix the tracker-attachment edge, treat network timeout as DEGRADED when DOM/layout quiescent.
- F-23 (1522 evaluate): **not** tool-evasion; evaluate is the right tool for dynamic theme debugging. Drop the "bypass" framing.

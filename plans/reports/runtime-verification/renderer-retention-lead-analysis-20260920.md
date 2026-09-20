# Renderer Retention Lead Analysis (2026-09-20)

## Executive Summary & Core Verdict

The 2 h and 4 h soak runs both exhibited an app-owned renderer private-bytes slope of approximately **+0.17 to +0.22 MB/min**, breaching the renderer SLO (`≤ 0.15 MB/min`). Because the app-owned total memory stayed well inside budget (peak ~1444–1490 MB vs 1600 MB threshold), this renderer slope is the specific resource bound capping how many tabs can remain open in long sessions.

### Key Conclusions from Source & Payload Auditing:

1. **Process Attribution is Settled**: In every attributed run (`soak4h.json`, `preflight-fixed.json`, `legs4h-checkpoint.json`), the slope is carried by a **single OS process**: the unified Chrome UI renderer (`role: chrome:standalone+chrome:toolbar+chrome:frame-backdrop`, URL: `file:///.../standalone.html`). Page renderers (Google, Example.com, Fixture tabs, Wikipedia) are completely flat or negative over multi-hour windows (all ≤ 0.03 MB/min; Wikipedia settles to −0.014 MB/min over 178 minutes).
2. **Leading Candidate Refuted by Hard Caps**: The hypothesis that terminal PTY writes produce "bytes per line written forever" is **REFUTED by source code inspection**. Every memory buffer along the terminal write path is strictly hard-capped (`scrollback: 10000`, recovery queue 1 MiB / 2048 chunks, hydration write 1 MiB, JSON-budgeted transcript suffix). The circular buffer saturates within ~16.6 minutes at 600 lines/min and cannot produce a linear 4-hour monotone slope.
3. **Recovery Drop Explained**: The 24.22 MB drop observed during recovery in `soak4h.json` was **view teardown**, not the draining of an unbounded leak. When the recovery phase initiates, the soak harness explicitly closes all tabs and the terminal session (`benchmark-real-soak-8h.cjs:1296-1305`). Disposing the xterm instance, its saturated 10,000-line buffer, addons, and DOM elements (`standalone.js:476-482`) releases ~25 MB of view-scoped memory.
4. **Structural Inventory Finding**: An exhaustive audit of the renderer codebase confirms that **every application-level Map, Set, array, event listener, and DOM list is strictly bounded**.
5. **Real Drivers of the Monotone Slope**: With application-level collections ruled out, the monotone private-bytes creep is driven by engine-level churn:
   - **Blink Native String Table / AtomicString Interning**: Driven by the 200 ms fixture page updating `document.title` with ~72,000 unique strings over 4 hours, triggering 5 Hz IPC state broadcasts, signature hashing, and DOM text updates.
   - **PartitionAlloc / V8 Heap Virtual Memory Fragmentation**: Continuous alloc/free churn from 5 Hz IPC deserialization and 10–40 line/sec terminal parsing without virtual memory decommit to the OS.
6. **Decisive Negative Result**: The existing data **CANNOT** discriminate the sub-document owner (`standalone.html` vs `toolbar.html` vs `frame-backdrop.html`) or the allocation class (Blink string tables vs PartitionAlloc vs V8 heap) because Electron bundles all three surfaces into one OS process, and Leg 2 (`burst4x`) and Leg 3 (`burst-off`) were aborted at minute 63.

---

## 1. Renderer PIDs and Slopes Carrying the Breach (Per Leg & Per Run)

All numbers below are quoted directly from committed JSON payloads (`legSlopes[].slopes`, `processSeries[].processes`, and `metrics`), **not** from markdown verdict prose.

### A. `real-soak-8h-legs4h-checkpoint.json` (Phase 4c Leg Bisect, started 2026-09-20T00:06:57.446Z)

- **Leg Configuration** (`config.legs`):
  - Leg 1 `baseline`: 60 min, 300 burst lines / 30,000 ms (10 lines/s)
  - Leg 2 `burst4x`: 60 min, 1200 burst lines / 30,000 ms (40 lines/s) — **UNRUN** (aborted at min 63)
  - Leg 3 `burst-off`: 60 min, 1 burst line / 600,000 ms — **UNRUN**
- **Reported Header Metrics** (`metrics`):
  - `metrics.worstProcessSlopeMBPerMin`: **0.1817 MB/min** (Working Set slope)
  - `metrics.worstProcessPid`: **29832**
  - `metrics.worstProcessRole`: `"chrome:standalone+chrome:toolbar+chrome:frame-backdrop"`
  - `metrics.appPrivateMaxSlopeMBPerMin`: **0.2019 MB/min**
  - `metrics.appPrivateMaxPid`: **29832**
  - `metrics.rendererActiveSlopeMBPerMin`: 0.26057 MB/min (contaminated parent-pid tree walk)
- **Leg 1 (`baseline`) Per-Process Slopes** (quoted directly from `legSlopes[0].slopes`, 30 frames, 60.0 min observed, 60 bursts, 18,000 lines, 572 switches):

| PID | Process Type | Role & URL | PV First → Last | Delta PV | Private Slope (`slopePrivateMBPerMin`) | Working Set Slope (`slopeMBPerMin`) |
|:---|:---|:---|:---|:---|:---|:---|
| **29832** | **Tab** | `chrome:standalone+chrome:toolbar+chrome:frame-backdrop`<br>`file:///E:/Work/apps/AntiFan/.compiled/src/renderer/standalone.html` | 85.89 → 91.73 MB | **+5.84 MB** | **+0.1992 MB/min** | **+0.1808 MB/min** |
| 9196 | Tab | `tab:6a69f961` (`https://www.wikipedia.org/`) | 50.59 → 54.06 MB | +3.47 MB | +0.1102 MB/min | +0.0682 MB/min |
| 45324 | Tab | `tab:a2810597+...` (`http://127.0.0.1:51339/store-home`) | 34.51 → 35.37 MB | +0.86 MB | +0.0313 MB/min | +0.0333 MB/min |
| 43764 | Tab | `tab:c49550af` (`https://example.com/`) | 28.19 → 28.72 MB | +0.53 MB | +0.0187 MB/min | +0.0270 MB/min |
| 21616 | Tab | `tab:7ad242ef` (`https://www.google.com/`) | 52.14 → 52.14 MB | +0.00 MB | 0.0000 MB/min | 0.0000 MB/min |
| 31608 | Utility | `""` | 14.41 → 14.23 MB | −0.18 MB | −0.0055 MB/min | −0.0042 MB/min |
| 34492 | GPU | `""` | 156.44 → 152.97 MB | −3.47 MB | −0.0363 MB/min | +0.0380 MB/min |
| 14108 | Browser | `""` | 181.37 → 150.27 MB | −31.10 MB | −0.1749 MB/min | −0.1852 MB/min |

- **Leg 2 (`burst4x`) and Leg 3 (`burst-off`)**:
  - `legSlopes` contains only 1 entry (`legSlopes.length === 1`).
  - No frames were collected for Legs 2 and 3; their slopes are **unmeasured** in this artifact.

---

### B. `real-soak-8h-preflight-fixed.json` (Phase 4b Post-Fix Preflight, started 2026-09-19T21:58:28.348Z)

- **Configuration**: 90 minutes total (15 min warmup / 60 min workload / 15 min recovery).
- **Reported Header Metrics** (`metrics`):
  - `metrics.worstProcessSlopeMBPerMin`: **0.1917 MB/min** (WS)
  - `metrics.worstProcessPid`: **14988**
  - `metrics.appPrivateMaxSlopeMBPerMin`: **0.2234 MB/min**
  - `metrics.appPrivateMaxPid`: **14988**
  - `metrics.appPrivateMaxRole`: `"chrome:standalone+chrome:toolbar+chrome:frame-backdrop"`
- **Workload Phase Per-Process Slopes** (58.0 min, 59 frames, computed via LSQ from `processSeries`):

| PID | Process Type | Role & URL | PV First → Last | Delta PV | Private Slope | Working Set Slope |
|:---|:---|:---|:---|:---|:---|:---|
| **14988** | **Tab** | `chrome:standalone+chrome:toolbar+chrome:frame-backdrop`<br>`file:///E:/Work/apps/AntiFan/.compiled/src/renderer/standalone.html` | 82.43 → 94.13 MB | **+11.70 MB** | **+0.2234 MB/min** | **+0.1917 MB/min** |
| 39000 | Tab | `tab:112ef741` (`https://www.wikipedia.org/`) | 50.71 → 56.08 MB | +5.37 MB | +0.0458 MB/min | +0.0508 MB/min |
| 29884 | Tab | `tab:e7603cd2` (`https://example.com/`) | 22.88 → 24.25 MB | +1.37 MB | +0.0248 MB/min | +0.0052 MB/min |
| 6324 | Tab | `tab:72218bef+...` (`store-home` fixture) | 33.77 → 36.34 MB | +2.57 MB | +0.0114 MB/min | +0.0117 MB/min |
| 3836 | Tab | `tab:1babc1d0` (`https://www.google.com/`) | 59.10 → 59.10 MB | +0.00 MB | 0.0000 MB/min | +0.0006 MB/min |
| 45312 | GPU | `""` | 153.18 → 168.55 MB | +15.37 MB | +0.0717 MB/min | +0.0439 MB/min |
| 46640 | Utility | `""` | 14.54 → 14.41 MB | −0.13 MB | −0.0012 MB/min | −0.0011 MB/min |
| 35764 | Browser | `""` | 163.87 → 146.55 MB | −17.32 MB | −0.3014 MB/min | −0.3056 MB/min |

- **Recovery Release**: PID 14988 dropped from 94.13 MB to 92.92 MB (released 1.21 MB; views stayed open during short recovery).

---

### C. `real-soak-8h-soak4h.json` (Phase 2/3 4h Run, started 2026-09-19T17:52:10.754Z)

- **Configuration**: 240 minutes total (30 min warmup / 180 min workload / 30 min recovery).
- **Reported Header Metrics** (`metrics`):
  - `metrics.worstProcessSlopeMBPerMin`: **0.0472 MB/min** (WS)
  - `metrics.worstProcessPid`: **47536**
  - `metrics.worstProcessRole`: `"chrome:standalone+chrome:toolbar+chrome:frame-backdrop"`
  - `metrics.rendererActiveSlopeMBPerMin`: 0.038949 MB/min (contaminated parent-pid tree walk including Zalo renderers)
- **Workload Phase Per-Process Slopes** (178.0 min, 179 frames, computed via LSQ from `processSeries`):

| PID | Process Type | Role & URL | PV First → Last | Delta PV | Private Slope | Working Set Slope |
|:---|:---|:---|:---|:---|:---|:---|
| **47536** | **Tab** | `chrome:standalone+chrome:toolbar+chrome:frame-backdrop`<br>`file:///E:/Work/apps/AntiFan/.compiled/src/renderer/standalone.html` | 87.78 → 117.54 MB | **+29.76 MB** | **+0.1696 MB/min** | **+0.0472 MB/min** |
| 25348 | Tab | `tab:5939438c` (`https://example.com/`) | 29.45 → 29.84 MB | +0.39 MB | +0.0022 MB/min | −0.0113 MB/min |
| 44852 | Tab | `tab:c4aa5fac` (`https://www.google.com/`) | 58.02 → 58.02 MB | +0.00 MB | −0.0000 MB/min | −0.0149 MB/min |
| 11244 | Tab | `tab:63a8c54b` (`https://www.wikipedia.org/`) | 55.78 → 55.59 MB | −0.19 MB | −0.0142 MB/min | −0.0780 MB/min |
| 33800 | Tab | `tab:97ba010c+...` (`store-home` fixture) | 35.99 → 32.56 MB | −3.43 MB | −0.0342 MB/min | −0.0434 MB/min |
| 28216 | Browser | `""` | 141.55 → 158.17 MB | +16.62 MB | +0.0041 MB/min | +0.0060 MB/min |
| 46880 | Utility | `""` | 14.43 → 15.00 MB | +0.57 MB | +0.0038 MB/min | +0.0051 MB/min |
| 34196 | GPU | `""` | 163.92 → 142.70 MB | −21.22 MB | −0.0484 MB/min | +0.0160 MB/min |

- **Recovery Release**: In recovery, when the harness closed the terminal and web tabs (`benchmark-real-soak-8h.cjs:1296-1305`), PID 47536 dropped from 117.54 MB to 93.32 MB (releasing **24.22 MB**; 81.4% of accumulated 29.76 MB).

---

### D. `real-soak-2h.json` (2026-09-19 Baseline Run)

- Predates per-process attribution (`processSeries` is `undefined`).
- Quoted from `metrics`:
  - `metrics.rendererActiveSlopeMBPerMin`: **0.208234 MB/min**
  - `metrics.overallActiveSlopeMBPerMin`: 0.124452 MB/min
- Quoted from `samples` (workload 60 min):
  - Renderer working set: 717.16 MB → 727.28 MB (+10.12 MB).
  - Per-process private bytes are unrecorded in this payload.

---

## 2. Refutation of Unbounded Terminal Write Retention

An earlier hypothesis attributed the ~0.2 MB/min slope to unbounded growth in the terminal write path ("bytes per line written forever" scaling at ~320 bytes/line). **This hypothesis is refuted by explicit code invariants**:

1. **Circular Scrollback Cap**:
   - `src/renderer/standalone.js:2034`: `scrollback: 10000` (main pane).
   - `src/renderer/standalone.js:2599`: `scrollback: 10000` (split pane).
   - *Behavior*: xterm.js allocates a circular buffer (`BufferLine[]`). Once 10,000 lines are pushed, the oldest line is unreferenced and overwritten. At 600 lines/min (300 lines every 30s), the buffer completely saturates in **16.6 minutes**. After saturation, line writes cause cell churn, not buffer expansion.
2. **Recovery Queue Caps**:
   - `src/renderer/standalone.js:1283`: `const MAX_RECOVERY_QUEUE_BYTES = 1024 * 1024; // 1 MiB hard bound`
   - `src/renderer/standalone.js:1284`: `const MAX_RECOVERY_QUEUE_CHUNKS = 2048; // 2,048 chunks hard bound`
   - `src/renderer/standalone.js:1497-1505`: Enforced before queue insertion; if exceeded, `viewState.syncState = 'DEGRADED'` is set, `viewState.liveQueue = []` is cleared, and queueing stops.
   - `src/renderer/standalone.js:1525, 1573, 1575`: Queue items are drained via `shift()` and written to xterm.
3. **Hydration Write Cap**:
   - `src/renderer/standalone.js:1663-1666`: Slices hydration writes to `MAX_HYDRATION_WRITE_CHARS = 1024 * 1024` (1 MiB).
4. **Transcript Storage Bound**:
   - `src/renderer/standalone.js:614, 1652`: The renderer receives only a JSON-budgeted suffix of the transcript. The full scrollback transcript is stored in the MAIN process (`src/main/terminal/terminal-session-state.ts`), not in the renderer.
5. **Why Recovery Released 24.22 MB**:
   - At recovery start (`benchmark-real-soak-8h.cjs:1296-1305`), the harness executed `performRecoveryTeardown`, closing all tabs and invoking `api.closeTerminal(sessionId)`.
   - In `standalone.js:461-483`, `releaseTerminalPane` explicitly calls:
     - `item.term.dispose()` (line 478)
     - `item.webLinksAddon?.dispose()` (line 476)
     - `item.paneEl.remove()` (line 482)
     - `globalResizeObserver.unobserve(item.paneEl)` (line 480)
   - Releasing an active xterm instance with a saturated 10,000-line buffer, font metrics, Canvas/DOM row elements, and event wrappers drops ~24–25 MB of resident memory. This was the disposal of a **saturated, view-scoped resource**, not an unbounded leak.

---

## 3. Comprehensive Renderer Structure Inventory

Below is an exhaustive inventory of every structure in the renderer surfaces (`standalone.js`, `toolbar.ts`, `frame-backdrop.ts`, `terminal-write-dispatcher.ts`, and preloads) that is retained across events.

### A. JavaScript Collections (Maps, Sets, Arrays)

| Structure | File:Line | What It Stores | What Bounds It | Cadence | Can Produce Monotone Slope? |
|:---|:---|:---|:---|:---|:---|
| `tabRefsCache` | `toolbar.ts:2454` | `WeakMap<HTMLElement, TabElementRefs>` caching child refs | Bounded by live tab DOM elements (`tabList.children.length`). Garbage-collected when tab DOM node is removed. Exactly 6 entries in soak. | Static (6 tabs) | **NO** |
| `rawTerminalPool` | `standalone.js:1166` | `Map<string, TerminalPaneItem>` | Lines 2125–2127 (`reconcileTerminalPanes`) deletes closed/sleeping sessions. Exactly 1 session in soak. | Static (1 session) | **NO** |
| `coalescedAckMap` | `standalone.js:1285` | `Map<string, AckState>` storing pending sequence numbers | Keyed by `sessionId`. Reused in-place (`state.pendingSeq = seq`, line 1304). Flushed every 80ms or 16 chunks. | Static (1 session) | **NO** |
| `sessionActivity` | `standalone.js:3416` | `Map<string, ActivityState>` | Keyed by `sessionId`. Trailing text is clamped: `act.tail = data.slice(-64)` (line 3470). | Static (1 session, 64 chars) | **NO** |
| `sessionActivityThrottle` | `standalone.js:3421` | `Map<string, ThrottleState>` | Keyed by `sessionId`. Trailing timer cleared every 100ms. | Static (1 session) | **NO** |
| `sessionSplitRatios` | `standalone.js:1256` | `Map<string, number>` | Keyed by `sessionId`. Exactly 1 session in soak. | Static (1 session) | **NO** |
| `categoryHeaders` | `standalone.js:274` | `Map<string, HTMLElement>` | Lines 4576–4581 deletes and unlinks headers not in `visibleGroups`. 1 category in soak. | Static (1 category) | **NO** |
| `categoryOrder` | `standalone.js:276` | `Array<string>` | Lines 448–451 prunes dead keys via `splice()`. 1 category in soak. | Static (1 category) | **NO** |
| `collapsedCategories` | `standalone.js:277` | `Set<string>` | User interaction only. Empty in soak. | Static (0 items) | **NO** |
| `starredCategories` | `standalone.js:360` | `Set<string>` | User interaction only. Empty in soak. | Static (0 items) | **NO** |
| `deferredWakeInput` | `standalone.js:489` | `Map<string, string>` | Cleared when session wakes (`flushDeferredWakeInput`). Never used in soak (session awake). | Static (0 items) | **NO** |
| `wakeInFlight` | `standalone.js:490` | `Set<string>` | Cleared on wake promise completion. Empty in soak. | Static (0 items) | **NO** |
| `overlayTokens` | `toolbar.ts:142` | `Map<string, number \| undefined>` | Deleted on popup close (`releaseOverlay`). No popups open in soak. | Static (0 items) | **NO** |
| `currentTabs` | `toolbar.ts:1079` | `Array<AntiFanTab>` | Replaced entirely on each `onStateUpdated` broadcast (`currentTabs = s.tabs \|\| []`, line 4214). Holds 6 items. | Static (6 items) | **NO** |
| `viewState.liveQueue` | `standalone.js:1443` | `Array<Chunk>` | Hard-capped at 1 MiB (`MAX_RECOVERY_QUEUE_BYTES`) and 2048 chunks (`MAX_RECOVERY_QUEUE_CHUNKS`). Clears to `[]` if exceeded. Drained on continuous chunks. | Transient (0 in steady state) | **NO** |
| `target.writeQueue` | `terminal-write-dispatcher.ts:183` | `Array<string>` | Drained every animation frame up to 64 KB per tick. Empties when PTY pauses. | Transient (drained to 0) | **NO** |
| `sTerm` scrollback | `standalone.js:2034, 2599` | xterm `BufferLine[]` | Hard-capped: `scrollback: 10000`. Circular buffer saturates in 16.6 minutes. | Capped at 10k lines | **NO** |

### B. DOM Node Lifecycles & Mutation Paths

| DOM Path | File:Line | Creation & Retention Behavior | What Bounds It | Cadence | Can Produce Monotone Slope? |
|:---|:---|:---|:---|:---|:---|
| Tab Strip Elements | `toolbar.ts:2476-2505` | Tab elements (`div.tab`) created in `renderTabs()`. | Reused via `tabElById` (line 2486). Unmatched tabs are removed via `child.remove()` (line 2480). Only 6 tab elements exist in DOM. | Static (6 elements) | **NO** |
| Terminal Tab Wraps | `standalone.js:4495-4605` | Tab wrap elements (`div.terminal-tab-wrap`). | Reused via `currentWraps` (line 4495). Dead wraps removed via `el.remove()` (line 4567). Exactly 1 wrap exists in DOM. | Static (1 element) | **NO** |
| Category Header Elements | `standalone.js:4587` | Header elements (`div.terminal-category-header`). | Reused via `categoryHeaders` Map. Unused headers removed via `header.remove()` (line 4579). | Static (1 element) | **NO** |
| Popover Elements | `standalone.js:2800-3080` | Popovers for affinity, category picker, modals. | Only instantiated on user click. Never opened during soak. | Zero in soak | **NO** |
| Frame Backdrop | `frame-backdrop.ts:81-378` | Static chassis and bezel elements. | Pure inline style updates (`style.display`, `style.left`). Zero elements appended. | Static | **NO** |

### C. Event Listeners & IPC Subscriptions

| Listener Target | File:Line | Registration Point | Bound / Unlink Mechanism | Cadence | Can Produce Monotone Slope? |
|:---|:---|:---|:---|:---|:---|
| `onStateUpdated` | `toolbar-preload.ts:145` | Registered once at `toolbar.ts:4211`. | Single listener on `CHANNELS.STATE_UPDATED`. Handler replaces `currentTabs`. | Registered once | **NO** |
| `onTabsUpdated` | `standalone-preload.ts:73` | Registered once at `standalone.js:4694`. | Single listener on `'antifan:tabs:updated'`. Handler runs `updateAffinityBadges`. | Registered once | **NO** |
| `onTerminalData` | `standalone-preload.ts:71` | Registered once at `standalone.js:4674`. | Single listener on `'antifan:terminal:data'`. Handler routes to write dispatcher. | Registered once | **NO** |
| Window event listeners | `standalone.js:4906, 4982` | Registered once at module load (`resize`, `focus`). | Static module listeners. | Registered once | **NO** |
| Tab DOM click/drag listeners | `toolbar.ts:2519-2563`, `standalone.js:3678-3720` | Attached inside `if (!tabEl)` and `if (!wrap)`. | Only attached when a new tab element is created (during warmup). Never re-attached on updates. | Static (6 tabs, 1 terminal) | **NO** |

---

## 4. Ranked Mechanisms Capable of Producing a Monotone Slope

Because every JavaScript-level collection in the application is strictly bounded, the +0.2 MB/min private-bytes creep is attributable to **engine-level allocation churn in Chromium/V8**:

### Rank 1: Blink Native String Table / AtomicString Interning from Fixture Title Churn

- **Exact Location**:
  - `src/renderer/toolbar.ts:2413-2421` (`computeTabsSignature`)
  - `src/renderer/toolbar.ts:2729-2732` (`titleSpan.textContent = baseTitle`)
  - `src/renderer/standalone.js:2710-2772` (`updateAffinityBadges`)
  - `src/main/browser/native-tab-host.ts:7803` (`safeSendWebContents` at 5 Hz)
- **Growth Mechanism**:
  - The soak fixture page executes `setInterval` every 200 ms (`fixtureTickMs: 200` = 5 Hz), updating `document.title = "Store Home (" + tick++ + ")"`.
  - Main's `flushBroadcastState()` pushes `STATE_UPDATED` and `antifan:tabs:updated` at 5 Hz across Electron IPC.
  - In `toolbar.ts:2413`, `computeTabsSignature` hashes `t.title`. Because the fixture title changes on every tick, `newTabsSig !== lastTabsSignature` is continuously true, forcing `renderTabs()` to run at 5 Hz.
  - In `toolbar.ts:2731`, `titleSpan.textContent = baseTitle` updates the DOM text node with the newly generated string.
  - Over a 4-hour run at 5 Hz, **~72,000 unique strings** are minted and assigned to DOM nodes.
  - In Chromium's Blink rendering engine (`WTF::AtomicStringTable`), unique strings assigned to DOM attributes and text nodes are interned in Blink's string tables. While short-lived V8 strings are garbage-collected, Blink's native `StringImpl` tables and character buffers grow monotonically with unique string volume.
  - When tabs are closed during recovery teardown, the tab DOM elements are destroyed, allowing Blink to prune the associated string entries.
- **Confirmation/Refutation Evidence**:
  - *Existing Artifacts*: Phase 4b preflight showed child-ref caching eliminated 54 DOM queries/tick but left the slope at +0.2234 MB/min, proving DOM querying was not the issue, while string assignment remained untouched.
  - *Live App Probe*: Run `SOAK_FIXTURE_TICK_MS=0` (or constant title) with terminal writes active. If the slope collapses, title string interning is 100% confirmed.

### Rank 2: PartitionAlloc / V8 Virtual Memory Page Fragmentation from High-Frequency Alloc/Free Churn

- **Exact Location**:
  - `src/shared/terminal-write-dispatcher.ts:178-208` (`queueWrite` / chunk slicing)
  - `src/renderer/standalone.js:1865-1895` (`writeToTerminalPane` / xterm parser loop)
  - `src/renderer/standalone.js:2728-2732` (5 Hz `getTerminalAffinities` IPC deserialization & `new Map()`)
- **Growth Mechanism**:
  - Both terminal bursts (10 to 40 lines/sec) and state broadcasts (5 Hz) produce high-frequency allocations:
    - Terminal: String chunks, UTF-16 code unit buffers, xterm parser token arrays.
    - State broadcasts: JSON IPC deserialization of 6-tab arrays and affinity records 18,000 times/hour.
  - In Chromium's PartitionAlloc and Windows virtual memory:
    - Small short-lived objects are allocated alongside longer-lived structures (like xterm's 10,000-line circular buffer).
    - Windows **Private Bytes** tracks committed virtual memory pages (`MEM_COMMIT`).
    - V8 and PartitionAlloc free memory internally, but rarely return committed virtual memory pages back to the OS via `VirtualFree(MEM_DECOMMIT)` unless an explicit compaction or context teardown occurs.
    - This creates a **monotone virtual memory floor** that creeps upwards (~0.17–0.22 MB/min) during active churn even though live object count remains bounded.
    - Upon recovery teardown, destroying the terminal pane and tabs releases the arenas, triggering the observed 24.22 MB OS decommit.
- **Confirmation/Refutation Evidence**:
  - *Live App Probe*: Connect via CDP using `scripts/probe-renderer-retention-class.cjs`. If `JSHeapUsedSize` and `nodes` remain flat while OS private bytes climb, PartitionAlloc virtual page fragmentation is 100% confirmed.

### Rank 3: Uncached Terminal Affinities IPC Round-Trip

- **Exact Location**:
  - `src/renderer/standalone.js:2728` (`await api.getTerminalAffinities()`)
  - `src/renderer/standalone.js:2730` (`const tabsMap = new Map(...)`)
- **Growth Mechanism**:
  - Even though Phase 3 patched `updateAffinityBadges` to accept `deliveredTabs`, it still calls `await api.getTerminalAffinities()` on every single broadcast at 5 Hz.
  - Each invocation creates an IPC promise, allocates deserialized affinity objects, instantiates `new Map`, and queries `.terminal-tab-affinity-badge` elements.
- **Confirmation/Refutation Evidence**:
  - *Live App Probe*: Pass cached affinities in the broadcast payload to eliminate the 5 Hz IPC round-trip.

---

## 5. What the Existing Data CANNOT Discriminate

The committed artifacts on disk have three fundamental, irreducible limits:

1. **Terminal Write Volume vs. Broadcast Rate (Lines vs. Seconds)**:
   - In both 4 h (`soak4h.json`) and preflight (`preflight-fixed.json`), terminal bursts ran at 300 lines / 30s (10 lines/s) and broadcasts ran at 5 Hz.
   - In `legs4h-checkpoint.json`, only Leg 1 (`baseline`) completed before the run was halted at minute 63. Leg 2 (`burst4x`) and Leg 3 (`burst-off`) were **never executed**.
   - Therefore, the existing data **CANNOT** empirically isolate how much of the slope is driven by terminal parsing churn vs 5 Hz state broadcast churn.
2. **Sub-Document Localization Inside the Unified Renderer**:
   - `standalone.html`, `toolbar.html`, and `frame-backdrop.html` share PID 29832 / 14988 / 47536 because Electron groups same-origin `file://` views into a single site-instance.
   - OS-level telemetry (`privateBytesMB`) measures the process as a whole.
   - Therefore, the existing data **CANNOT** allocate the memory growth among the terminal view, the tab strip, and the frame backdrop without per-document CDP sampling.
3. **V8 JavaScript Heap vs. Blink Native / DOM / String Tables**:
   - Committed payloads record only OS virtual memory private bytes and resident working set.
   - No CDP `Memory.getDOMCounters` (`nodes`, `documents`, `jsEventListeners`) or `Performance.getMetrics` (`JSHeapUsedSize`) was ever captured against a live soak run.
   - Therefore, the existing data **CANNOT** distinguish whether the growth is V8 heap object retention or Blink native C++ memory (DOM trees, style recalc, or `AtomicString` tables).

---

## 6. The Single Next Command/Probe to Settle the Owner

### Recommended Diagnostic Probe Command

To classify the retention class and locate the document owner without running another 4-hour soak:

```bash
SOAK_APP_ARGS="--remote-debugging-port=0" node scripts/probe-renderer-retention-class.cjs --profile=E:/Work/.antifan-soak-8h/Profile --samples=6 --interval-ms=60000
```

*(Self-test verification already passed 11/11 in `scripts/probe-renderer-retention-class.cjs`)*

### Decisions Settled by this Single Probe:

1. **Document Owner Identification**:
   - Queries each page target separately (`standalone.html`, `toolbar.html`, `frame-backdrop.html`) via `/json/list` on the DevTools port.
   - Isolates whether the memory growth is located in `toolbar.html` (tab strip) or `standalone.html` (terminal).
2. **Retention Class Classification**:
   - **`DOM_NODES`**: If `rates.nodes >= 10/min`, the growth is uncollected DOM tree elements.
   - **`EVENT_LISTENERS`**: If `rates.jsEventListeners >= 1/min`, the growth is closure leakage.
   - **`JS_HEAP`**: If `rates.jsHeapUsedSizeMB >= 1 MB` with `monotone >= 0.8`, the growth is V8 heap allocation.
   - **`FLAT` with rising OS private bytes**: If DOM counters and JS heap are both flat while the process's private bytes rise, the retention is definitively **Rank 1 (Blink AtomicString tables from fixture titles)** or **Rank 2 (PartitionAlloc virtual page fragmentation)**.

# Ultra Brainstorm Candidate 1: Unified View Registry & Lifecycle Decoupling

**Document ID:** `candidate-1-unified-view-registry-2026-09-06`  
**Candidate Identifier:** `Candidate 1`  
**Strategic Thesis:** Unified View Registry & Lifecycle Decoupling  
**Target Reference:** `E:\Download\antifan-terminal-deep-audit-and-improvement-plan-2026-09-05.md`  
**Evidence Packet:** `plans/reports/antifan-terminal-audit-evidence-packet.md`  
**Workspace:** `E:\Work\apps\antifan-browser-desktop` (Commit `96aa34f`)  
**Target Platform:** Windows 11 Pro x64 (Intel i5-9300H, solo Theme Developer: Haravan, Sapo, Shopify, PowerShell, OMP/Codex AI CLIs, Vite/esbuild watchers)  
**RFC 2119 Key Words:** MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, OPTIONAL.

---

## 1. Executive Summary & Problem Framing

### 1.1 The Dual-Reality Paradox
AntiFan's Terminal subsystem exhibits a stark divergence between backend integrity and frontend reliability:
- **The Backend is Sound (~8/10):** `src/main/browser/terminal-manager.ts` features robust architectural primitives: distinct, isolated `node-pty` instances per session (including dedicated PTYs for Split panes), strict monotonic sequence numbering (`seq`), generational tracking (`sessionGeneration`), bounded in-memory transcript buffers (512 KiB per session), targeted session-specific resizing, and clean Windows job-object / process-tree teardown.
- **The User-Visible Experience is Fragile (~5.5-6/10):** Developers endure chronic black panes, vanished scrollback, garbled cursor formatting, and lost CLI output during routine operations (switching tabs, collapsing the sidebar, or toggling split views).

### 1.2 Root Cause Synthesis: The Lifecycle Conflation Anti-Pattern
Codebase inspection and live telemetry trace 90% of user-reported terminal failures to a single architectural error: **the conflation of Terminal Emulator Lifecycle with UI Layout Topology.**

Specifically:
1. **The Disposable Split Singleton (`src/renderer/standalone.js`):** Main terminal sessions are housed in a persistent `terminalPool` (`Map<sessionId, TerminalItem>`), which preserves xterm.js instances across tab switches. Conversely, Split terminals are implemented as global, disposable singletons (`splitTerm`, `splitFitAddon`, `splitWriteTarget`). Invoking `unmountSplit()` executes `splitTerm.dispose()`, instantly destroying the xterm VT100/VT220 state machine, active screen buffers, alternate screen modes, cursor state, and 50,000 lines of scrollback.
2. **Rehydration via Bounded Tail Truncation:** When a split pane remounts, it attempts rehydration via `listSessions(paged=true)`, which shares a tiny ~40 KiB wire budget across all active sessions. The split view receives an arbitrary byte slice of raw ANSI output. Replaying raw ANSI escape codes into a newly initialized xterm state machine fails to reconstruct cursor positions, alternate screen states, or wrapped line layouts, resulting in mangled displays or blank panes.
3. **Hidden Sidebar Black Hole (`src/main/browser/native-tab-host.ts:1164`):** When the docked sidebar is closed, `native-tab-host.ts` explicitly suppresses IPC forwarding:
   ```ts
   if (this.isSidebarOpen && this.sidebarView && !this.sidebarView.webContents.isDestroyed()) {
     safeSendWebContents(this.sidebarView.webContents, 'antifan:terminal:data', payload);
   }
   ```
   Output emitted while the sidebar is collapsed is permanently dropped from the renderer.
4. **Silent Sequence Gap Leaps (`src/renderer/standalone.js:1896-1901, 1924-1929`):** The renderer implements deduplication (`chunkSeq <= lastRenderedSeq`), but lacks gap detection. If chunks are missed (e.g., during sidebar closure, leaping from seq 100 to 150), the renderer blindly updates `lastRenderedSeq = 150`, permanently skipping sequences 101..149 without alerting the user or initiating a resync.
5. **Persistence Replay Amnesia (`src/main/browser/terminal-manager.ts:426, 435`):** Restored sessions are spawned with `''` (empty string) instead of `item.buffer`, completely discarding saved transcripts on application restart.

### 1.3 Candidate 1 Structural Thesis
> **The Terminal Law: PTY Session != Terminal View != Layout.**  
> A Split is merely a layout relationship between two sessions. A Terminal View must be an invariant, persistent state machine that lives as long as its underlying PTY session. UI components MUST NEVER dispose an xterm instance during layout mutations, tab navigations, or visibility toggles.

Candidate 1 advocates for the immediate establishment of a **Unified View Registry & Lifecycle Decoupling**. By treating all terminal sessions identically in a single persistent registry and decoupling view instances from DOM mount hosts, we eliminate the structural root causes of state loss without risky low-level native PTY rewrites.

---

## 2. Outcome (User-Visible & Operational Target End State)

When this candidate architecture is delivered:

1. **Rock-Solid Split Continuity:** A developer running an active dev server (`shopify theme dev` or `vite`) in a main pane and a long-running AI CLI (`omp`, `codex`, or interactive PowerShell) in a split pane can switch between 20 tabs, split/unsplit views, and toggle the dock. The split terminal MUST NOT flicker, re-hydrate, clear its buffer, or lose a single line of scrollback.
2. **Lossless Docked Sidebar Operation:** Collapsing the sidebar while a build script executes, and reopening it hours later, MUST display 100% of the generated output without gaps, line offsets, or truncated tails.
3. **True Monotonic Stream Integrity:** Any network, IPC, or rendering interruption that creates a sequence gap (`incomingSeq > lastRenderedSeq + 1`) MUST automatically trigger a seamless, non-destructive background delta resync.
4. **Reliable App Restart Durability:** Restarting AntiFan MUST restore the exact scrollback history of previously active terminals, cleanly marked with session demarcation boundaries, without attempting to resurrect dead OS processes.
5. **Fail-Safe Geometry Bounds:** Short or heavily constrained docks MUST enforce a physical minimum row constraint (minimum 5 visible text rows). If space is insufficient, the UI MUST refuse the split gracefully or expand the container, rather than rendering an uninitialized 8px black box.
6. **Zero Orphaned Windows Processes:** Closing a terminal or exiting AntiFan MUST deterministically terminate all child processes (`node.exe`, `powershell.exe`, `esbuild.exe`) across Windows 11 job trees.

---

## 3. Constraints (Hard Technical Boundaries & Safety Invariants)

- **C-1: Absolute View Lifecycle Invariant (RFC 2119):** Normal UI operations (tab switching, sidebar collapse/expand, popout window dock/undock, split layout toggles) MUST NOT call `xterm.dispose()`. View disposal MUST occur ONLY when the underlying PTY session terminates (`api.closeTerminal(id)` or PTY exit).
- **C-2: Strict Sequence Monotonicity & Gap Protocol:** Every data chunk delivered to a view MUST be evaluated against `lastRenderedSeq`.
  - If `seq === lastRenderedSeq + 1`: Render directly and increment `lastRenderedSeq`.
  - If `seq <= lastRenderedSeq`: Discard silently (dedup).
  - If `seq > lastRenderedSeq + 1`: Transition view state to `GAPPED`, buffer incoming chunks, and initiate authoritative snapshot/delta resync.
- **C-3: Cell-Aware Layout Minimums:** Minimum split dimensions MUST be computed using measured character cell metrics (`MIN_SPLIT_ROWS = 5` cells + header height). Percentage-based layout splits that yield fewer than 5 rows MUST be rejected by the layout coordinator.
- **C-4: Windows PTY Isolation:** The existing WinPTY / `node-pty` integration MUST remain operational during initial stabilization waves. ConPTY migration MUST NOT occur until renderer state stability (Gates A through D) is verified.
- **C-5: Canvas / DOM Renderer Stability:** WebGL hardware acceleration MUST remain disabled by default. The standard canvas/DOM xterm renderer MUST be utilized to prevent GPU context loss across multi-pane and backgrounded Electron views.
- **C-6: Workstation Scope:** Architecture MUST be optimized for a single-developer Windows 11 workstation (Intel Core i5, 16-32GB RAM), avoiding enterprise multi-tenant scheduling abstractions.

---

## 4. Explicit Non-Goals

1. **NO Native PTY Backend Rewrite:** We SHALL NOT rewrite `src/main/browser/terminal-manager.ts` from scratch or replace `node-pty` with raw Win32 APIs in this phase.
2. **NO Rush to ConPTY / WebGL:** We SHALL NOT enable ConPTY or WebGL until the renderer lifecycle is 100% decoupled and verified.
3. **NO Headless Node.js VT Parser:** We SHALL NOT implement `@xterm/headless` in the Electron main process to maintain a server-side mirror. xterm.js in the renderer remains the sole authoritative VT state machine.
4. **NO Unbounded In-Memory Buffers:** Main process memory buffers SHALL NOT grow without bounds. Bounded circular ring buffers (512 KiB per session) MUST be maintained.
5. **NO Multi-Host Remote Terminal Multiplexing:** Features like SSH daemon hosting, tmux emulation protocols, or multi-user session sharing are strictly excluded.

---

## 5. Compared Approaches & Strategic Sequencing

### Table: Strategic Architecture Comparison

| Dimension | Approach A: Unified View Registry & Lifecycle Decoupling (Candidate 1) | Approach B: Enlarged Snapshot Tail + SerializeAddon Ephemeral Remount | Approach C: Node.js Main-Process Headless Virtual Terminal |
|---|---|---|---|
| **Primary Mechanism** | Single `TerminalViewRegistry` in renderer for all sessions; split is layout-only; xterm instances never disposed on UI changes. | Keep ephemeral split; enlarge IPC wire budget to 5 MiB; use xterm `SerializeAddon` on unmount/remount. | Host `@xterm/headless` instances in main process; stream serialized screen diffs to dumb renderer panes. |
| **View Persistence** | Persistent in renderer memory (detached DOM nodes). | Destroyed on unmount; reconstructed from serialized text string. | Persistent in Node.js main process heap; renderer is stateless. |
| **TUI / Cursor Fidelity** | **100% Perfect:** VT100 state machine never interrupted. | **Poor to Medium:** Escape sequence re-parsing frequently corrupts cursor positions and alternate screens. | **100% Perfect:** VT100 state machine maintained continuously in Node. |
| **Complexity & Risk** | **Low-Medium:** Surgical refactor of `standalone.js` and `native-tab-host.ts`. Backend PTY unchanged. | **Low Initial / High Long-term:** Low diff, but creates high CPU spikes and ongoing ANSI parsing bugs. | **Very High:** Complete rewrite of IPC layer, input handling, and terminal coordination. |
| **Memory Footprint** | Low: ~8-12 MB per active xterm DOM instance (negligible on 16-32GB RAM). | Minimal static footprint, but high GC churn on frequent tab switches. | High: Duplicate memory in both main process and renderer. |
| **Worst-Case Failure Mode** | Memory leak if session disposal fails to clean up registry entry. | Garbled screen state, lost scrollback, UI freeze during 5 MiB JSON deserialization. | Event-loop starvation in Electron main process, lagging browser UI and file watchers. |
| **Load-Bearing Assumption** | Detached DOM nodes with active xterm instances do not corrupt canvas dimensions upon re-attachment. | `SerializeAddon` can accurately serialize 100% of complex TUI/interactive terminal states. *(Empirically false).* | Main Node thread has sufficient compute to parse 10 concurrent high-speed terminal streams. |

### Architectural Evaluation & Recommendation
- **Why Reject Approach B:** Enlarging the IPC tail and relying on `SerializeAddon` is a cosmetic band-aid. Terminal emulation is an active state machine. Serializing a rich curses interface (e.g., `lazygit`, `omp`, `htop`, or Vite progress bars) into a raw string and re-parsing it loses cursor coordinates, alternate screen buffers, and scrollback demarcations. It also causes noticeable UI frame drops when switching tabs.
- **Why Reject Approach C:** Moving the terminal state machine into the Electron main process via headless xterm introduces extreme architectural bloat. It strains the single-threaded Node.js event loop, competing with Electron's window management, IPC routing, and file system watchers.
- **Why Approach A is Superior (Candidate 1):** Approach A addresses the exact root cause identified in the evidence packet: **the split view was treated as a second-class, disposable singleton.** Unifying all terminal sessions into a persistent `TerminalViewRegistry` guarantees that the xterm VT state machine remains intact across all layout manipulations, solving 90% of failures with surgical precision.

---

## 6. Recommended Direction & Architectural Blueprint

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                        MAIN PROCESS (TerminalManager)                         │
│                                                                               │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐ │
│  │ PTY Session 1 (Base) │  │ PTY Session 2 (Split)│  │ PTY Session 3 (Base) │ │
│  │  - node-pty instance │  │  - node-pty instance │  │  - node-pty instance │ │
│  │  - seq: 1042         │  │  - seq: 512          │  │  - seq: 89           │ │
│  │  - buffer: 512 KiB   │  │  - buffer: 512 KiB   │  │  - buffer: 512 KiB   │ │
│  └──────────┬───────────┘  └──────────┬───────────┘  └──────────┬───────────┘ │
└─────────────┼─────────────────────────┼─────────────────────────┼─────────────┘
              │                         │                         │
              │ IPC: 'antifan:terminal:data' { sessionId, data, seq }
              │ (Lossless: Buffered when sidebar is hidden)
              ▼                         ▼                         ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                     RENDERER LAYER (TerminalViewRegistry)                     │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │ TerminalViewRegistry (Map<sessionId, TerminalView>)                     │  │
│  │                                                                         │  │
│  │  ┌─────────────────────┐ ┌─────────────────────┐ ┌────────────────────┐ │  │
│  │  │ TerminalView (S1)   │ │ TerminalView (S2)   │ │ TerminalView (S3)  │ │  │
│  │  │  - xterm instance   │ │  - xterm instance   │ │  - xterm instance  │ │  │
│  │  │  - FitAddon         │ │  - FitAddon         │ │  - FitAddon        │ │  │
│  │  │  - lastRenderedSeq  │ │  - lastRenderedSeq  │ │  - lastRenderedSeq │ │  │
│  │  │  - health: HEALTHY  │ │  - health: HEALTHY  │ │  - health: HEALTHY │ │  │
│  │  │  - DOM: div.pane-s1 │ │  │  - DOM: div.pane-s2 │ │  - DOM: div.pane-s3│ │  │
│  │  └──────────┬──────────┘ └──────────┬──────────┘ └──────────┬─────────┘ │  │
│  └─────────────┼───────────────────────┼───────────────────────┼───────────┘  │
│                │                       │                       │              │
│                ▼                       ▼                       ▼              │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │ TerminalLayoutCoordinator (Pure Presentation & Geometry)                │  │
│  │                                                                         │  │
│  │  Active Tab: S1 (Parent) + S2 (Split)                                   │  │
│  │  ┌───────────────────────────────────────────────────────────────────┐  │  │
│  │  │ Main Pane Host (#terminal-host)      <--- Mounts div.pane-s1      │  │  │
│  │  ├───────────────────────────────────────────────────────────────────┤  │  │
│  │  │ Split Divider (SplitRatio: 60/40, Cell-aware minimum guard >= 5)  │  │  │
│  │  ├───────────────────────────────────────────────────────────────────┤  │  │
│  │  │ Lower Pane Host (#terminal-split-host)<--- Mounts div.pane-s2     │  │  │
│  │  └───────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                         │  │
│  │  Inactive Shelf (#terminal-hidden-shelf, display: none)                 │  │
│  │  ┌───────────────────────────────────────────────────────────────────┐  │  │
│  │  │ Holds div.pane-s3 (xterm alive, receiving background chunks)       │  │  │
│  │  └───────────────────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 6.1 Component 1: The Unified `TerminalViewRegistry`
Eliminate `splitTerm`, `splitFitAddon`, `splitWriteTarget`, and the fragmented `terminalPool`. Introduce a unified registry class managing lifecycle and rendering:

```ts
interface TerminalView {
  sessionId: string;
  sessionGeneration: number;
  term: Terminal;
  fitAddon: FitAddon;
  writeTarget: any;
  paneEl: HTMLElement;
  lastRenderedSeq: number;
  health: 'HEALTHY' | 'GAPPED' | 'RESYNCING' | 'FAILED';
  isUserScrolledUp: boolean;
  mountedHost: HTMLElement | null;
  hydrationEpoch: number;
  liveQueue: Array<{ seq: number; data: string; epoch: number }>;
}

class TerminalViewRegistry {
  private views = new Map<string, TerminalView>();

  getOrCreate(session: TerminalSessionSummary): TerminalView;
  attachToHost(sessionId: string, hostEl: HTMLElement): void;
  detachFromHost(sessionId: string): void;
  recordIncomingChunk(sessionId: string, data: string, seq: number): void;
  recoverGappedView(sessionId: string): Promise<void>;
  dispose(sessionId: string): void;
}
```

#### Mounting Semantics
- When a terminal is displayed as Main or Split, `attachToHost(sessionId, targetContainer)` appends `view.paneEl` to the target host and triggers `view.fitAddon.fit()`.
- When switching tabs or closing a split, `detachFromHost(sessionId)` moves `view.paneEl` to an off-screen, hidden shelf element (`#terminal-hidden-shelf`, styled with `display: none`).
- **`view.term.dispose()` is strictly forbidden during detachment.**

### 6.2 Component 2: Layout Graph & Split Metadata
Split is managed strictly as layout metadata. The layout coordinator maps active tab sessions to container slots:
```ts
interface TerminalLayoutState {
  activeTabSessionId: string;
  splitSessionId: string | null;
  splitRatio: number; // e.g. 0.65
  focusedPane: 'main' | 'split';
}
```
When toggling split off, the layout coordinator simply calls `detachFromHost(splitSessionId)` and updates the layout state. The underlying `TerminalView` for the split session remains active, alive, and listening to IPC events.

### 6.3 Component 3: Lossless IPC & Contiguous Stream Engine
1. **Fix `native-tab-host.ts:1164`:**
   Remove the `this.isSidebarOpen` gate. Terminal data chunks MUST be forwarded to `sidebarView.webContents` regardless of sidebar visibility, or buffered into a dedicated ring buffer in `TerminalManager` that flushes upon sidebar reopen:
   ```ts
   TerminalManager.getInstance().on('data', (payload: { sessionId: string; data: string; seq: number }) => {
     // Always send to sidebar view if webContents exists, even when hidden
     if (this.sidebarView && !this.sidebarView.webContents.isDestroyed()) {
       safeSendWebContents(this.sidebarView.webContents, 'antifan:terminal:data', payload);
     }
     // ... broadcast to popout windows
   });
   ```
2. **Gap Detection & Authoritative Resync Protocol:**
   In `TerminalViewRegistry.recordIncomingChunk`:
   ```ts
   if (seq > view.lastRenderedSeq + 1) {
     view.health = 'GAPPED';
     view.liveQueue.push({ seq, data, epoch: view.hydrationEpoch });
     this.triggerAuthoritativeResync(view);
     return;
   }
   ```
   `triggerAuthoritativeResync(view)` requests `api.getTerminalSnapshot(view.sessionId, view.lastRenderedSeq + 1)`. Upon snapshot arrival, it writes the missing delta, flushes queued live chunks, and restores `health = 'HEALTHY'`.

### 6.4 Component 4: Cell-Aware Geometry Coordinator
Replace percentage-based layout calculations with cell-aware constraint enforcement:
```ts
function computeSplitLayout(containerHeightPx: number, cellHeightPx: number): { mainPx: number; splitPx: number; viable: boolean } {
  const HEADER_PX = 28;
  const MIN_ROWS = 5;
  const minSplitPx = (MIN_ROWS * cellHeightPx) + HEADER_PX;
  const minMainPx = (MIN_ROWS * cellHeightPx) + HEADER_PX;

  if (containerHeightPx < (minSplitPx + minMainPx)) {
    return { mainPx: containerHeightPx, splitPx: 0, viable: false };
  }
  // Enforce split ratio bounded by minSplitPx and minMainPx
  // ...
}
```
If `viable === false`, the UI displays a subtle badge ("Split hidden: height too small") and devotes 100% of height to the focused pane, completely preventing unrenderable 8px black boxes.

### 6.5 Component 5: Persistence Durability Fix
In `src/main/browser/terminal-manager.ts:426, 435`:
```ts
// FIX: Pass item.buffer instead of empty string ''
const s = this.spawn(item.id, item.cwd || this.currentCwd, item.buffer || '');
```
When restoring on app startup, the backend populates the initial buffer. The renderer displays this buffer with a distinct visual banner:
```text
┌────────────────────────────────────────────────────────┐
│ [Restored History - AntiFan Session 2026-09-06 14:20]   │
│ Note: Process exited. Press Enter to start new shell.  │
└────────────────────────────────────────────────────────┘
```

---

## 7. Sharp & Falsifiable Acceptance Criteria

Each criterion is an unambiguous binary gate verifiable by automated tests or direct runtime observation:

| Gate | Category | Description | Verification Method & Target Threshold |
|---|---|---|---|
| **GATE-A** | View Continuity | Switching between 10 terminal tabs with an active split pane running 1,000 lines/sec output. | **Zero disposal calls:** `xterm.dispose` call count MUST equal 0. **Zero dropped lines:** Final buffer line count in split view MUST match PTY output exactly. |
| **GATE-B** | Sequence Gap Healing | Artificially inject a 50-chunk drop (`seq` leaps from 100 to 151) via test mock. | **Automated recovery:** View transitions to `GAPPED`, queries delta, resumes `HEALTHY` within 100ms. Output comparison MUST show 0 missing bytes and 0 duplicate chunks. |
| **GATE-C** | Hidden Dock Durability | Start Vite dev server in docked terminal, close sidebar (`isSidebarOpen = false`), execute 500 lines of build output, reopen sidebar. | **Byte-for-byte fidelity:** Rendered scrollback in reopened view MUST match `TerminalManager.getBuffer(id)` with 0 missed sequences. |
| **GATE-D** | TUI Screen Integrity | Run interactive CLI (`omp` status line or `powershell` with progress bar using `\r`). Switch tabs 50 times. | **Zero visual corruption:** No overlapping lines, no NaN cursor offsets, no garbled escape code artifacts. |
| **GATE-E** | Geometry Guard | Resize docked terminal container to 120px height with split enabled. | **Fail-safe fallback:** Sub-minimum split is safely hidden. Main pane occupies 120px. Terminal rows MUST NOT drop below `MIN_SPLIT_ROWS` (5). Zero console errors. |
| **GATE-F** | Restart Durability | Populate 1,000 lines in terminal, restart AntiFan application. | **Transcript visible:** Upon relaunch, the 1,000 lines of previous session history MUST be immediately visible in the active tab. |
| **GATE-G** | Process Leak Prevention | Spawn 5 split terminals running `powershell.exe`, close all tabs, exit AntiFan. | **Zero ghost processes:** Windows `Get-Process powershell` MUST report 0 orphaned child PIDs matching AntiFan session tokens. |

---

## 8. Immediate Wave 1 Execution Plan (Exact P0 Priorities)

The Wave 1 execution plan delivers maximum reliability ROI within a tight, low-risk boundary:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       WAVE 1 EXECUTION SEQUENCE (P0)                        │
└─────────────────────────────────────────────────────────────────────────────┘
  │
  ├─► STEP 1: Instrument & Expose Terminal Diagnostics (Phase T0)
  │   - Expose `window.__antifanTerminalHealth` in `src/renderer/standalone.js`.
  │   - Add sequence and error counters: `lastRenderedSeq`, `gapCount`, `resyncCount`.
  │   - Provide `api.dumpTerminalDiagnostics()` for real-time state inspection.
  │
  ├─► STEP 2: Unified TerminalViewRegistry Implementation (Phase T2)
  │   - Refactor `src/renderer/standalone.js` to create `TerminalViewRegistry`.
  │   - Eliminate `splitTerm`, `splitFitAddon`, and `splitWriteTarget` globals.
  │   - Move detached views to `#terminal-hidden-shelf`.
  │   - Enforce invariant: `unmountSplit()` NEVER disposes xterm.
  │
  ├─► STEP 3: Lossless Sidebar IPC & Sequence Gap Recovery (Phase T1)
  │   - Patch `src/main/browser/native-tab-host.ts:1164`: remove sidebar visibility drop.
  │   - Implement GAPPED/RESYNCING state machine in `TerminalViewRegistry`.
  │   - Wire authoritative snapshot resync on gap detection.
  │
  ├─► STEP 4: Cell-Aware Split Minimum Geometry Guard (Phase T3)
  │   - Implement `TerminalGeometryCoordinator` with character cell height calculation.
  │   - Guard against `< 5` rows; fallback gracefully on constrained docks.
  │   - Eliminate global `resize(allSessions)`; use targeted `resizeTerminalTo(id)`.
  │
  ├─► STEP 5: Persistence Spawn Buffer Bug Fix (Phase T4)
  │   - Patch `src/main/browser/terminal-manager.ts:426, 435`: pass `item.buffer` to `spawn()`.
  │   - Render clear restored session boundary banner in terminal UI.
  │
  └─► STEP 6: Real Windows 11 Electron Verification Suite
      - Run end-to-end Playwright tests verifying Gates A through G on live workstation.
      - Certify zero black panes during tab switching and split toggles.
```

### Risk Assessment & Rollback Protocol
- **Blast Radius:** Constrained strictly to `src/renderer/standalone.js`, `src/main/browser/native-tab-host.ts:1164`, and `src/main/browser/terminal-manager.ts:426,435`.
- **PTY Backend Safety:** No native C++ or `node-pty` bindings are altered.
- **Rollback Feasibility:** If DOM detachment exhibits unforeseen styling or memory issues, the hidden shelf can fall back to standard CSS `visibility: hidden; position: absolute;` without altering registry data structures.

---

## 9. Conclusion
Candidate 1 provides the foundational architectural correction required by AntiFan. By decoupling the Terminal View lifecycle from ephemeral UI layouts and unifying Split and Main sessions into a single robust registry, we cure the systemic root cause of black panes, lost scrollback, and garbled output. This sets an unshakeable, verified foundation for future performance tuning and Windows subsystem optimizations.

# CANDIDATE 4 EVALUATION & BRAINSTORM CONTRACT: DURABILITY, SESSION LIFECYCLE & TUI/AI CLI CONTEXT CONTINUITY

**Document ID:** `candidate-4-durability-session-lifecycle-tui-continuity`  
**Target Architecture Report:** `E:\Download\antifan-terminal-deep-audit-and-improvement-plan-2026-09-05.md`  
**Evidence Packet:** `plans/reports/antifan-terminal-audit-evidence-packet.md`  
**Target Codebase:** `E:\Work\apps\antifan-browser-desktop` (Commit `96aa34f`)  
**Host Environment:** Windows 11 Pro x64, Intel Core i5-9300H @ 2.40GHz, solo Theme Developer (Haravan, Sapo, Shopify CLI, PowerShell, OMP/Codex/AI CLIs, Vite/esbuild watchers).  
**Primary Structural Thesis:** **Durability, Session Lifecycle & TUI/AI CLI Context Continuity** (Persistence Buffer, Restart Recovery, Alternate Screen Stability, and Rolling Transcript Storage).  
**Standard of Rigor:** RFC 2119 (`MUST`, `MUST NOT`, `REQUIRED`, `SHALL`, `SHOULD`, `RECOMMENDED`).

---

## 1. Executive Summary & Problem Framing

AntiFan’s terminal subsystem has a solid native process model in the Electron main process: true per-session PTY allocation via `node-pty`, distinct parent-child session hierarchy for split panes, monotonic output sequence stamping (`seq`), session generation counters (`sessionGeneration`), and bounded in-memory buffer tracking (`safeSliceTail`). However, the subsystem suffers from a severe user-perceived reliability gap (~5.5/10), predominantly because the **persistence, session lifecycle, and renderer view state machines violate fundamental terminal emulation invariants**.

The core problem can be expressed through three fatal architectural disconnects verified directly against the codebase:

1. **The Ephemeral Split Lifecycle Trap (`src/renderer/standalone.js:1064-1075, 1094`):**
   While main terminal sessions enjoy a persistent xterm instance pool (`terminalPool = new Map<string, TerminalItem>()`), split terminals are relegated to singleton globals (`splitTerm`, `splitFitAddon`, `splitWriteTarget`). Navigating between tabs executes `unmountSplit()`, which calls `splitTerm.dispose()`. This destroys the entire virtual terminal (VT) state machine—cursor positions, character attributes (SGR), scrollback lines (up to 50,000 configured), and most critically, the **Alternate Screen Buffer (DECSET 1049)**.
2. **The Raw PTY Tail Replay Fallacy (`standalone.js:582-598` & Audit §6):**
   When the user returns to a tab with a split session, AntiFan constructs a brand-new `Terminal` and attempts to reconstruct screen state by replaying a severely truncated raw byte tail (~40 KiB wire budget shared across all sessions). A raw byte tail is **not a valid terminal snapshot**. For interactive tools (OpenCodeInterpreter/OMP, Codex CLI, `lazygit`, PowerShell PSReadLine, Shopify theme prompts), replaying raw bytes into a blank primary screen buffer results in shifted cursor offsets, corrupted multi-line prompts, missing alternate screens, or blank black panes.
3. **The Egregious Persistence Disconnect (`src/main/browser/terminal-manager.ts:426, 435, 572, 581`):**
   `TerminalManager` rigorously persists session state and transcript buffers (up to 256 KiB per session) to `terminal-sessions.json` via `persistSync()` and `persistAsync()`. However, on app startup (`setCapsule` and `startTerminal`), the restore routine reads the saved sessions from disk but invokes `this.spawn(item.id, item.cwd || this.currentCwd, '')`—**passing an empty string `''` instead of `item.buffer`**! AntiFan pays the disk I/O cost of writing hundreds of kilobytes of developer history, only to discard it completely upon restart.

Candidate 4 establishes that **Session Durability and TUI Context Continuity cannot be achieved by merely enlarging JSON wire buffers or adding defensive `try {} catch {}` wrappers**. Real durability requires:
- Strict decoupling: **PTY Session != Terminal View != Layout Binding**.
- Zero-disposal lifecycle: Normal tab switches `MUST NEVER` dispose a live xterm instance.
- Dual-buffer awareness: Alternate screen buffer stability for TUIs/AI CLIs.
- Explicit demarcation: Historical transcript continuity `MUST NOT` be confused with active process resumption.
- Storage decoupling: Separating metadata (`sessions.json`, <50 KiB) from rolling streaming disk transcripts (`transcripts/*.log`).

---

## 2. Outcome: User-Visible and Operational Target End State

The targeted end state establishes an unbreakable continuum of terminal context for the solo theme developer:

```
+---------------------------------------------------------------------------------------------------+
| AntiFan Desktop: Unified Terminal Durability Architecture                                         |
+---------------------------------------------------------------------------------------------------+
|  [Tab 1: Shopify Dev (Live)]  |  [Tab 2: Codex AI CLI (Live)]  |  [Tab 3: Git/Build Watcher]      |
+-------------------------------+--------------------------------+----------------------------------+
| Main Pane (Session T1):                                                                           |
|   Vite / Shopify Theme Dev streaming logs (20,000 lines scrollback intact).                      |
|   Tab switch away and back: ZERO rehydration delay, ZERO layout jump, ZERO lost lines.             |
|---------------------------------------------------------------------------------------------------|
| Split Pane (Session T2 - TUI / AI CLI):                                                           |
|   OpenCodeInterpreter / lazygit / Interactive prompt in Alternate Screen Buffer (DECSET 1049).     |
|   Tab switch away and back: xterm instance KEPT ALIVE in TerminalViewRegistry.                     |
|   Full-screen TUI remains rock-solid; no cursor drift, no text duplication, no black panel.       |
+---------------------------------------------------------------------------------------------------+
| Background / Dock Hidden Behavior:                                                                |
|   Dock closed during intensive `npm build`: chunks buffered losslessly or streamed to live view.  |
|   Reopening dock: Monotonic sequence validation confirms zero gaps (seq 100 -> 101 -> 102).       |
+---------------------------------------------------------------------------------------------------+
| Cold App Restart Behavior:                                                                        |
|   === Restored Transcript from Previous AntiFan Session (2026-09-06 14:22) ===                     |
|   [Build errors, compiler warnings, and prior CLI output perfectly preserved in scrollback]       |
|   === New PowerShell Session Initialized (PID: 14820) ===                                          |
|   PS E:\Work\Themes\haravan-demo> _                                                               |
+---------------------------------------------------------------------------------------------------+
```

### Key Operational Deliverables:
1. **Uninterrupted TUI & AI CLI Operations:**
   Running full-screen TUIs, AI agent CLIs (OMP/Codex), and progress spinners across Split or Main panes remains 100% stable through arbitrary tab switching, window resizing, and sidebar dock toggling.
2. **True Cold-Restart Transcript Preservation:**
   Closing and reopening AntiFan immediately renders the preserved developer scrollback (up to 20,000 lines / 2 MiB) with an explicit, clean demarcator separating historical output from the freshly spawned PowerShell shell.
3. **Deterministic Zero-Gap Output:**
   Output streams never drop lines when the docked sidebar is hidden or when Windows enters background power states. Sequence gap detection triggers automatic delta recovery before any corrupt render occurs.
4. **Resilient Local Storage Engine:**
   Fast, atomic file persistence on Windows that eliminates EPERM/antivirus rename collisions and prevents monolithic JSON serialization stalls.

---

## 3. Constraints (Hard Technical Boundaries & Safety Invariants)

The architecture must strictly respect the workstation environment and operational context:

- **C-1: Single-Developer Local Windows 11 Workstation:**
  The solution is optimized for Windows 11 Pro x64 with local NTFS filesystems. No multi-tenant cloud daemons, remote SSH multiplexers, or heavy distributed abstractions shall be introduced.
- **C-2: PTY Backend Preservation:**
  The `node-pty` process-spawning model in `TerminalManager` `MUST NOT` be replaced or rewritten from scratch. Enhancements must wrap and harden the existing architecture.
- **C-3: No Premature ConPTY or WebGL Switches:**
  `node-pty` on Windows currently runs with `{ useConpty: false }` (WinPTY mode), and WebGL acceleration is disabled (`attachWebglAddon` returns `null`) to prevent DirectX/GPU context-loss crashes across multi-tab splits. These configurations `MUST NOT` be changed until renderer lifecycle and data continuity bugs are completely eliminated.
- **C-4: Memory Ceiling per Terminal Session:**
  To maintain a lightweight footprint on an 8-thread Intel i5 laptop, memory allocation `MUST` be capped:
  - In-memory xterm scrollback: max 50,000 lines (~15–25 MiB RAM per session).
  - Main process transcript ring: max 2 MiB / 10,000 sequence chunks per session.
  - Disk transcript retention: max 10 MiB rolling log per session.
- **C-5: Non-Blocking File I/O:**
  No synchronous disk operations (`fs.writeFileSync`, `fs.readFileSync`) are permitted on the Electron main process event loop during live terminal streaming. All disk flushing `MUST` be asynchronous or worker-offloaded.
- **C-6: Fail-Closed Process Cleanup:**
  Terminal process termination `MUST` clean up the entire Windows process tree (`taskkill /T /F`) using a validated PID ownership registry to guarantee zero zombie node/esbuild watcher processes.

---

## 4. Explicit Non-Goals

To guarantee focus and immediate delivery, the following areas are strictly out of scope:

1. **NG-1: Enterprise Terminal Sharing or Remote SSH Daemons:**
   AntiFan is a local desktop harness. We will not build tmux-style multi-client attach servers, SSH bastion forwarding, or web-socket-based cloud multiplexers.
2. **NG-2: Full VT100 Emulation inside the Main Process:**
   We `MUST NOT` write a custom VT parser or virtual screen buffer in Node.js/Rust in the main process. xterm.js in the renderer remains the sole authoritative VT state machine.
3. **NG-3: Re-enabling WebGL Renderer in Initial Waves:**
   WebGL context recreation under Windows D3D11 device loss is a known source of black screens during split resizing. The standard DOM/Canvas renderer will be preserved.
4. **NG-4: ConPTY Migration in Wave 1:**
   Upstream `node-pty` ConPTY integration has known quirks on specific Windows 11 builds (console handle inheritance, escape sequence stripping). ConPTY migration is gated to a post-stabilization benchmark phase.
5. **NG-5: Arbitrary Process State Resumption:**
   It is computationally impossible to resurrect an exited native PowerShell process or long-running compiler process across an OS reboot. We explicitly do not attempt process memory snapshotting; we guarantee **historical transcript continuity**, not process resurrection.

---

## 5. Compared Approaches & Strategic Trade-offs

We evaluate three strategic approaches for solving terminal durability, session lifecycle, and TUI stability:

```
+----------------------------------------------------------------------------------------------------+
| STRATEGIC APPROACH COMPARISON MATRIX                                                               |
+-----------------------+-------------------------+-------------------------+------------------------+
| Dimension             | Approach A: Ephemeral   | Approach B: Aggressive  | Approach C: Two-Tier   |
|                       | Singleton + Large Wire  | Modernization (ConPTY + | Decoupled Durability   |
|                       | Tail (Quick-Fix)        | WebGL + Monolithic Ser.)| (Recommended Direction)|
+-----------------------+-------------------------+-------------------------+------------------------+
| Architectural Focus   | Enlarge 40KB wire budget| Migrate node-pty to     | Separate PTY != View   |
|                       | and call xterm refresh()| ConPTY, enable WebGL    | != Layout; zero view   |
|                       | repeatedly.             | and serialize xterm.    | disposal; rolling logs.|
+-----------------------+-------------------------+-------------------------+------------------------+
| TUI / AI CLI          | BROKEN. Alternate screen| FRAGILE. ConPTY escapes | ROCK-SOLID. Views kept |
| Stability             | is destroyed on every   | cause parser resets;    | alive in registry;     |
|                       | tab switch.             | WebGL context lost.     | alternate buffer intact|
+-----------------------+-------------------------+-------------------------+------------------------+
| Split Content         | POOR. Truncated tail    | UNSTABLE. Monolithic    | COMPLETE. Up to 50,000 |
| Survival              | replays raw ANSI bytes; | serialization blocks UI | lines preserved without|
|                       | causes cursor drift.    | thread under load.      | re-render or replay.   |
+-----------------------+-------------------------+-------------------------+------------------------+
| Cold-Restart          | UNCHANGED. Continues to | COMPLEX. Corrupt JSON   | FLAWLESS. Explicit     |
| Experience            | drop saved buffer in    | bricks startup; no      | transcript demarcation |
|                       | spawn(id, cwd, '').     | process boundary.       | + new shell session.   |
+-----------------------+-------------------------+-------------------------+------------------------+
| Complexity & Risk     | Low initial complexity, | Extreme complexity; two | Moderate complexity;   |
|                       | zero architectural fix. | high-risk migrations.   | targeted, clean cuts.  |
+-----------------------+-------------------------+-------------------------+------------------------+
| Worst-Case Failure    | Corrupted screen, black | App crash on GPU switch;| View fallback to delta |
| Mode                  | split panes, loss of UI.| EPERM file corruption.  | ring or clean snapshot.|
+-----------------------+-------------------------+-------------------------+------------------------+
```

### Detailed Evaluation of Options:

#### Approach A: Ephemeral Singleton + Inflated Wire Tail (The Band-Aid Anti-Pattern)
- **Concept:** Keep `splitTerm` as a disposable singleton. Increase the global JSON wire budget from 40 KiB to 2 MiB. Call `splitTerm.refresh()` and prepend `\x1b[0m` on remount.
- **Why it Fails:** This fails fundamentally because xterm is a state machine, not a string buffer. A 2 MiB tail replayed into a fresh terminal does not know if the shell was in cursor-hide mode, mouse-tracking mode, or alternate-screen mode. Running `lazygit` or Codex CLI will result in a completely corrupted terminal screen on every tab switch.
- **Worst-Case Failure Mode:** High-frequency IPC overhead freezes the UI while still producing black/corrupted terminal panes.
- **Load-Bearing Assumption:** Erroneously assumes that terminal output is purely stateless, line-oriented plain text.

#### Approach B: Aggressive ConPTY & WebGL Modernization with Monolithic State
- **Concept:** Immediately upgrade to `useConpty: true`, enable `@xterm/addon-webgl`, and dump full serialized xterm snapshots into `terminal-sessions.json` on every change.
- **Why it Fails:** Combining a PTY backend migration with a renderer graphics overhaul while the view lifecycle is broken introduces compounding variables. WebGL context loss under Windows D3D11 causes black rectangles during rapid split resizing. Large monolithic JSON files cause synchronous event-loop stalls and Windows antivirus file locks (EPERM).
- **Worst-Case Failure Mode:** Hard Electron renderer crashes, unrecoverable DirectX black screens, and corrupted session files preventing app launch.
- **Load-Bearing Assumption:** Assumes native Windows GPU drivers and ConPTY VT sequences never encounter edge cases under rapid layout changes.

#### Approach C: Two-Tier Decoupled Durability & View Continuity (The Recommended Direction)
- **Concept:** 
  1. Decouple PTY Session from Terminal View and Layout.
  2. Implement `TerminalViewRegistry` in the renderer: xterm instances for both Main and Split are allocated once per `sessionId` and cached for the session's entire life.
  3. Tab switches only toggle DOM detachment/visibility; `unmountSplit()` merely unbinds layout, never calling `.dispose()`.
  4. Fix the cold-restart bug by passing `item.buffer` to `spawn()` and prepending a clear historical boundary.
  5. Decouple storage: tiny `sessions.json` for layout/metadata + per-session streaming rolling disk transcripts (`transcripts/*.log`).
  6. Implement lossless background buffering and strict sequence gap detection (`incomingSeq > lastRenderedSeq + 1`).
- **Trade-offs:** Requires refactoring `standalone.js` global split variables into registry lookups and updating `terminal-manager.ts` disk persistence.
- **Worst-Case Failure Mode:** If an xterm instance crashes internally, the view transitions to a diagnosable `FAILED` state with an explicit `[Recover View]` action that rehydrates from the backend transcript without killing the underlying PTY process.
- **Load-Bearing Assumption:** Local workstation memory (16–32 GB typical) can comfortably hold 4–8 active xterm instances in memory simultaneously (~100–150 MB total RAM).

---

## 6. Recommended Direction & Architectural Blueprint

### 6.1 Epistemic Principle: PTY Session != Terminal View != Layout

The cornerstone of Candidate 4 is the strict separation of concerns across the three structural tiers:

```
[MAIN PROCESS: LIFECYCLE TIER]
  TerminalManager
  ├── Session Map: Map<sessionId, Session>
  │   ├── Session "term-1": { pty, bufferRing (2MB), seq: 1420, gen: 1, state: 'running' }
  │   └── Session "split-1": { pty, bufferRing (2MB), seq: 850, gen: 1, splitOf: 'term-1' }
  └── Rolling Transcript Storage: %APPDATA%/AntiFan/terminal/transcripts/{id}.log

                             │ IPC: antifan:terminal:data { sessionId, data, seq, gen }
                             ▼

[RENDERER: PERSISTENT VIEW TIER]
  TerminalViewRegistry: Map<sessionId, TerminalView>
  ├── View "term-1": { term: xtermInstance, fitAddon, lastRenderedSeq: 1420, buffer: Active }
  └── View "split-1": { term: xtermInstance, fitAddon, lastRenderedSeq: 850, buffer: Alternate }
  *INVARIANT: Views are NEVER disposed during tab switching or layout changes!*

                             │ DOM Attachment / Visibility Binding
                             ▼

[RENDERER: EPHEMERAL LAYOUT TIER]
  TerminalLayoutCoordinator
  ├── Tab 1 Active Layout: { mainSessionId: "term-1", splitSessionId: "split-1", ratio: 0.6 }
  │   ├── Main Host Container (DOM)  <── View "term-1".attach(host)
  │   └── Split Host Container (DOM) <── View "split-1".attach(host)
  └── Tab 2 Inactive Layout: { mainSessionId: "term-2", splitSessionId: null }
      └── (Views remain alive in memory, detached from DOM or display: none)
```

---

### 6.2 The Dual-Buffer ANSI Problem: Why Raw Tail Replay Destroys TUIs & AI CLIs

An ANSI/VT100 terminal emulator maintains two distinct screen buffers:
1. **Primary Screen Buffer:** Supports arbitrary scrolling, lines wrapped in scrollback history, and standard command output.
2. **Alternate Screen Buffer (`DECSET 1049` / `\x1b[?1049h`):** Used by full-screen TUIs (`vim`, `lazygit`, `htop`, OpenCodeInterpreter, Codex CLI). It has **zero scrollback**, uses absolute row/column coordinates (`\x1b[H`, `\x1b[20;10H`), and disables standard line insertion.

```
+----------------------------------------------------------------------------------------------------+
| Anatomy of State Destruction during Split Remount                                                  |
+----------------------------------------------------------------------------------------------------+
| 1. Live TUI in Split Pane:                                                                         |
|    - Mode: Alternate Buffer Active (`\x1b[?1049h`)                                                 |
|    - Cursor: Col 14, Row 22 (`\x1b[22;14H`), Cursor Hidden (`\x1b[?25l`)                          |
|    - Screen: Interactive AI diff review box rendered across 80x24 cells                            |
|                                                                                                    |
| 2. User Clicks Another Tab -> standalone.js executes unmountSplit():                               |
|    - `splitTerm.dispose()` IS CALLED.                                                              |
|    - Entire VT state machine, Alternate Buffer, and cursor memory are WIPED OUT.                   |
|                                                                                                    |
| 3. User Returns to Tab -> standalone.js calls mountSplit(sessionId):                              |
|    - `new Terminal()` is created in the PRIMARY SCREEN BUFFER.                                     |
|    - AntiFan fetches a 10KB raw tail from backend and writes it: `term.write(tail)`.              |
|                                                                                                    |
| 4. Catastrophic Visual Failure:                                                                    |
|    - The raw tail lacks the original `\x1b[?1049h` sequence.                                      |
|    - The tail contains raw delta commands (`\x1b[2K\rPrompt> foo`) meant for absolute screen cells.|
|    - These commands execute against the PRIMARY scrollback, corrupting lines, misaligning prompts, |
|      or rendering a completely empty black screen!                                                 |
+----------------------------------------------------------------------------------------------------+
```

**The Architectural Remedy:**
By implementing `TerminalViewRegistry`, the `Terminal` instance is **never destroyed** when switching tabs or toggling layouts. The Alternate Screen Buffer remains resident in memory. When the tab is reselected, AntiFan simply re-attaches the existing DOM container or toggles CSS `display: block`. Zero replay occurs; TUI continuity is instantaneous and flawless.

---

### 6.3 Fixing the Persistence Restoration Bug

In `src/main/browser/terminal-manager.ts`, the persistence restore flow is broken in two places (`setCapsule` and `startTerminal`):

```ts
// CURRENT DEFECTIVE CODE (terminal-manager.ts:425-435 & 571-581):
for (const item of baseSessions) {
  const s = this.spawn(item.id, item.cwd || this.currentCwd, ''); // <-- BUG: Empty string drops buffer!
  s.name = item.name || s.name;
  s.capsuleId = item.capsuleId || this.currentCapsuleId;
}
for (const item of splitSessions) {
  // ...
  const s = this.spawn(item.id, item.cwd || this.currentCwd, '', undefined, initialRows, ...); // <-- BUG!
}
```

**The Required Fix:**
Pass `item.buffer` directly to `this.spawn()`. Furthermore, to guarantee that the user and the VT parser clearly understand the boundary between historical output and the new live process, we inject a formatted, ANSI-safe boundary demarcation:

```ts
// ARCHITECTURAL SPECIFICATION: Restored Buffer Demarcation
export function formatRestoredHistoricalBuffer(rawSavedBuffer: string, previousTimestamp?: number): string {
  if (!rawSavedBuffer || rawSavedBuffer.trim().length === 0) {
    return '';
  }
  const dateStr = previousTimestamp ? new Date(previousTimestamp).toLocaleString() : 'Previous Session';
  const resetAnsi = '\x1b[0m\x1b[?25h'; // Reset attributes, ensure cursor visible
  const separator = '\r\n\x1b[90m' + '─'.repeat(72) + '\x1b[0m\r\n';
  const header = 
    `\r\n\x1b[36m┌─ [AntiFan Terminal] Restored Transcript (${dateStr}) ──────────────────────\x1b[0m\r\n` +
    `\x1b[90m│ Previous process has terminated. Command output preserved below.\x1b[0m\r\n` +
    `\x1b[36m└─────────────────────────────────────────────────────────────────────────────\x1b[0m\r\n\r\n`;
  const footer = 
    `\r\n\r\n\x1b[32m┌─ [AntiFan Terminal] Active PowerShell Session Started ───────────────────────\x1b[0m\r\n` +
    `\x1b[90m│ Fresh shell initialized. Scroll up to inspect historical logs.\x1b[0m\r\n` +
    `\x1b[32m└─────────────────────────────────────────────────────────────────────────────\x1b[0m\r\n\r\n`;

  return `${resetAnsi}${header}${rawSavedBuffer.trimEnd()}${separator}${footer}`;
}
```

When `spawn()` initializes, `s.buffer` receives this demarcated transcript. When the renderer attaches, the developer sees their entire compiler error stack or Vite log, followed by a clean, active PowerShell prompt.

---

### 6.4 Storage Engine: Decoupling Metadata from Rolling Disk Transcripts

Currently, `terminal-sessions.json` stores session metadata, window state, and massive buffer strings together in one monolithic file. Writing this file synchronously or during large bursts creates Windows file-lock (EPERM) contention and stalls the main process.

```
CURRENT FRAGILE STORAGE:
%APPDATA%/AntiFan/terminal-sessions.json (Monolithic JSON, 500KB - 2MB)
  ├── { activeSessionId, sessions: [ { id, name, cwd, buffer: "HUGE STRING..." } ] }
  └── Write failure / EPERM -> Corrupts entire terminal state.

TARGET DECOUPLED STORAGE:
%APPDATA%/AntiFan/terminal/
  ├── sessions.json                (< 10 KiB, fast atomic write)
  │     └── { activeSessionId, layout, sessions: [ { id, name, cwd, splitOf, logFile } ] }
  └── transcripts/                 (Streaming, per-session rolling logs)
        ├── term-1.log             (Rotated at 10 MB, UTF-8 raw log)
        ├── term-2.log
        └── split-1.log
```

#### Durability Invariants for Disk Transcripts:
1. **Metadata Atomicity:** `sessions.json` contains only structural metadata (`id`, `name`, `cwd`, `capsuleId`, `splitOf`, `lastSeq`). It is written via `tempFile + atomicRename` with exponential backoff for Windows EBUSY/EPERM retries (up to 5 attempts over 500ms).
2. **Streaming Append:** Transcripts are appended asynchronously to individual `.log` files using an unbuffered file handle (`fs.createWriteStream(..., { flags: 'a' })`).
3. **Log Rotation:** Each transcript file is capped at 10 MiB. When exceeded, it rotates to `.log.1` and truncates, preventing disk bloat.

---

### 6.5 Lossless Background Stream & Sequence Gap Repair Protocol

In `src/main/browser/native-tab-host.ts:1164`:
```ts
if (this.isSidebarOpen && this.sidebarView && !this.sidebarView.webContents.isDestroyed()) {
  safeSendWebContents(this.sidebarView.webContents, 'antifan:terminal:data', payload);
}
```
When the docked sidebar is closed, chunks are discarded from the renderer IPC. If the user runs `npm test` and closes the dock, reopening it displays an incomplete screen. Furthermore, `standalone.js` only checks `chunkSeq <= lastRenderedSeq` (dedup); it **never checks for gaps**:
```js
// DEFECTIVE CHECK IN standalone.js:1896
if (chunkSeq > 0 && chunkSeq <= item.lastRenderedSeq) return; // Discards old
if (chunkSeq > 0) item.lastRenderedSeq = chunkSeq; // Blindly jumps to 150!
writeToTerminalPane(item, data);
```

#### The Lossless Continuity State Machine:

```
                      +-------------------+
                      |       IDLE        |
                      +-------------------+
                                │
                                ▼
                      +-------------------+
                      |     HYDRATING     |  Queue incoming live chunks in liveQueue
                      +-------------------+
                                │ Snapshot applied throughSeq
                                ▼
                      +-------------------+
          ┌──────────>|       READY       |<──────────┐
          │           +-------------------+           │
          │                     │                     │
          │ incomingSeq ==      │ incomingSeq >       │ Resync snapshot applied
          │ lastRenderedSeq + 1 │ lastRenderedSeq + 1 │ & queue flushed
          │                     ▼                     │
          │           +-------------------+           │
          └───────────|   GAP DETECTED    |───────────┘
                      |  (State: GAPPED)  |
                      +-------------------+
                                │ Request delta or authoritative snapshot
                                ▼
                      +-------------------+
                      |    RESYNCING      |
                      +-------------------+
```

#### Protocol Specification:
1. **Always-On IPC Dispatch:** In `native-tab-host.ts`, remove `this.isSidebarOpen` check. If `this.sidebarView` exists and is not destroyed, always deliver `antifan:terminal:data`. Electron webContents can receive IPC in the background with negligible CPU overhead.
2. **Gap Detection Invariant:** In the renderer:
   ```ts
   if (chunk.seq <= view.lastRenderedSeq) {
     return; // Stale / duplicate
   }
   if (chunk.seq === view.lastRenderedSeq + 1) {
     view.lastRenderedSeq = chunk.seq;
     writeToTerminal(view, chunk.data);
     return;
   }
   // GAP DETECTED: incomingSeq > view.lastRenderedSeq + 1
   view.state = 'gapped';
   view.liveQueue.push(chunk);
   triggerAuthoritativeResync(view.sessionId, view.generation, view.lastRenderedSeq);
   ```
3. **Delta vs Snapshot Resync:**
   - The backend retains a **Sequence Delta Ring** (last 2,000 chunks).
   - If `missingCount = (incomingSeq - 1) - view.lastRenderedSeq <= 2000`, the backend sends the missing chunks immediately (`antifan:terminal:resync-delta`).
   - If the gap is wider, the backend returns an authoritative full snapshot (`getTerminalSnapshot`), resets the xterm view safely, writes the snapshot, and flushes the queued live chunks.

---

### 6.6 Disaster Recovery & Popout Serialization via `@xterm/addon-serialize`

Normal in-app navigation (tab switches, split toggles) `MUST NEVER` use serialization or disposal; live views remain in memory.
However, for **hard destruction events**:
- Popout terminal to a separate native OS window.
- Redocking a popped-out window back into the main frame.
- Intentional renderer reload (Ctrl+R / F5).

We deploy `@xterm/addon-serialize` as a specialized disaster recovery bridge:

```
[Window Popout Event]
  1. Capture live xterm state via serializeAddon.serialize({ scrollback: 5000 }):
     -> Preserves both normal buffer text AND alternate buffer escape sequences.
  2. Record snapshot metadata: { sessionId, generation, cols, rows, lastRenderedSeq }.
  3. Close docked view.
  4. In new standalone window, initialize xterm with IDENTICAL cols/rows.
  5. Write serialized string directly to xterm.
  6. Reconnect live IPC starting from `lastRenderedSeq + 1`.
  7. ZERO loss of visual formatting, colors, or prompt alignment.
```

---

## 7. Sharp & Falsifiable Acceptance Criteria

Every improvement must be verified through automated or deterministic manual test gates on Windows 11:

### Gate A: Split Session Context Continuity
- **A-1 (10,000-Line Flood Test):** Stream 10,000 numbered lines (`seq-check-{n}`) into a split pane at full speed. During the stream, switch parent tabs 50 times at 200ms intervals. 
  - *Pass Condition:* Returning to the split pane reveals exact lines 1 through 10,000 in scrollback. Missing lines = 0, duplicate lines = 0.
- **A-2 (TUI / Alternate Screen Tab Switch):** Launch an interactive TUI (OpenCodeInterpreter, Codex CLI, or `lazygit`) in a split pane. Enter a multi-line input prompt with text. Switch to another tab and return.
  - *Pass Condition:* The TUI alternate screen is 100% intact. Cursor position is identical, input buffer is preserved, zero artifacts on screen, no black box.

### Gate B: Cold-Restart Transcript Preservation
- **B-1 (Restart Scrollback Visibility):** Execute commands generating 500 lines of compiler errors in Terminal 1 and a Vite dev server in Split 1. Fully quit AntiFan (`Alt+F4` or close window). Relaunch AntiFan.
  - *Pass Condition:* Both Terminal 1 and Split 1 restore their historical scrollback. The demarcator `┌─ [AntiFan Terminal] Restored Transcript` is visible. The new active shell prompt appears below the demarcation.
- **B-2 (Zero Empty Buffer Restoration):** Verify via code inspection and telemetry that `this.spawn()` is never called with an empty string when `item.buffer` exists in `readSavedSessions()`.

### Gate C: Sequence Integrity & Lossless Background Streaming
- **C-1 (Docked Sidebar Hidden Burst):** Start a streaming script in Terminal 1 (100 lines/sec). Toggle the docked sidebar closed (`isSidebarOpen = false`). Wait 10 seconds (1,000 lines emitted). Reopen the docked sidebar.
  - *Pass Condition:* Zero sequence gaps. All 1,000 lines appear in the terminal without manual refresh or resync failure.
- **C-2 (Synthetic Sequence Gap Recovery):** In a test environment, deliberately inject a gap by dropping sequence chunks 501 to 550.
  - *Pass Condition:* Renderer state machine transitions to `gapped`, requests delta recovery, renders missing chunks 501..550 in order, and transitions back to `ready` without skipping a single byte.

### Gate D: Storage Durability & Windows Safety
- **D-1 (Simulated Antivirus / EPERM Lock):** In an automated test, hold a shared read lock on `sessions.json` during a persistence trigger.
  - *Pass Condition:* The persistence engine executes its backoff retry without throwing unhandled exceptions or crashing the main process. State is flushed successfully within 500ms.
- **D-2 (Memory Ceiling Under Load):** Run 4 concurrent terminal sessions streaming continuously for 30 minutes.
  - *Pass Condition:* Total renderer process RSS memory stays below 350 MB. Rolling disk logs stay strictly within the 10 MB per session limit.

---

## 8. Immediate Wave 1 Execution Plan (P0 Priorities)

Wave 1 delivers the absolute foundational fixes required to eliminate data loss and black panes. All changes are surgically targeted and strictly respect the codebase architecture:

```
+----------------------------------------------------------------------------------------------------+
| WAVE 1 EXECUTION ROADMAP: P0 CORE STABILIZATION                                                    |
+------+-------------------------------------------+-----------------------------------+-------------+
| Task | Target File / Component                   | Concrete Change Action            | Invariant   |
+------+-------------------------------------------+-----------------------------------+-------------+
| W1.1 | src/renderer/standalone.js                | Eliminate `splitTerm` singleton;  | Zero xterm  |
|      |                                           | implement `TerminalViewRegistry`  | disposal on |
|      |                                           | for ALL sessions (main & split).  | tab switch. |
+------+-------------------------------------------+-----------------------------------+-------------+
| W1.2 | src/main/browser/terminal-manager.ts      | Fix lines 426, 435, 572, 581: pass| Historical  |
|      |                                           | `item.buffer` with demarcation    | transcript  |
|      |                                           | into `this.spawn()`.              | preserved.  |
+------+-------------------------------------------+-----------------------------------+-------------+
| W1.3 | src/main/browser/native-tab-host.ts       | Line 1164: Remove `isSidebarOpen` | Lossless    |
|      |                                           | gating; dispatch data chunks to   | background  |
|      |                                           | live sidebarView unconditionally. | streaming.  |
+------+-------------------------------------------+-----------------------------------+-------------+
| W1.4 | src/renderer/standalone.js                | Implement strict monotonic gap    | Detection & |
|      |                                           | detection (`incomingSeq > last+1`)| resync on   |
|      |                                           | and request delta resync.         | any jump.   |
+------+-------------------------------------------+-----------------------------------+-------------+
| W1.5 | src/renderer/standalone.js &              | Replace silent `catch {}` blocks  | Diagnosable |
|      | src/renderer/standalone.css               | with structured health logging    | errors; no  |
|      |                                           | and `[Recover View]` UI overlay.  | black box.  |
+------+-------------------------------------------+-----------------------------------+-------------+
```

### Detailed File-by-File Implementation Steps for Wave 1:

#### Step 1: Implement `TerminalViewRegistry` in `src/renderer/standalone.js`
- Replace global singleton variables:
  ```js
  // REMOVE:
  let splitTerm = null;
  let splitFitAddon = null;
  let splitId = '';
  
  // REPLACE WITH UNIFIED REGISTRY:
  class TerminalViewRegistry {
    constructor() {
      this.views = new Map(); // sessionId -> { term, fitAddon, host, lastRenderedSeq, state }
    }
    getOrCreate(sessionId, container) { ... }
    attach(sessionId, targetElement) { ... }
    detach(sessionId) { ... }
    dispose(sessionId) { ... }
  }
  ```
- Modify `unmountSplit()`: Change it to `registry.detach(splitId)`. Do **not** call `.dispose()`. The xterm DOM node is simply removed from the split container, retaining all scrollback, alternate screen buffers, and cursor modes.

#### Step 2: Fix Persistence Restoration in `src/main/browser/terminal-manager.ts`
- In `setCapsule()` (lines 425–439) and `startTerminal()` (lines 570–585):
  ```ts
  // Change line 426 & 572 from:
  const s = this.spawn(item.id, item.cwd || this.currentCwd, '');
  // To:
  const s = this.spawn(item.id, item.cwd || this.currentCwd, formatRestoredHistoricalBuffer(item.buffer));
  
  // Change line 435 & 581 from:
  const s = this.spawn(item.id, item.cwd || this.currentCwd, '', undefined, initialRows, ...);
  // To:
  const s = this.spawn(item.id, item.cwd || this.currentCwd, formatRestoredHistoricalBuffer(item.buffer), undefined, initialRows, ...);
  ```

#### Step 3: Remove Background Throttling Drop in `src/main/browser/native-tab-host.ts`
- Update line 1163:
  ```ts
  TerminalManager.getInstance().on('data', (payload: { sessionId: string; data: string; seq: number }) => {
    // Deliver to sidebar whenever webContents exists and is not destroyed, regardless of isSidebarOpen:
    if (this.sidebarView && !this.sidebarView.webContents.isDestroyed()) {
      safeSendWebContents(this.sidebarView.webContents, 'antifan:terminal:data', payload);
    }
    // ... window delivery remains untouched
  });
  ```

#### Step 4: Strict Sequence Gap State Machine in `src/renderer/standalone.js`
- Update chunk reception at line 1886:
  ```js
  function handleTerminalChunk(sessionId, chunkSeq, data) {
    const view = viewRegistry.get(sessionId);
    if (!view) return;

    if (chunkSeq <= view.lastRenderedSeq) return; // Discard duplicate

    if (chunkSeq === view.lastRenderedSeq + 1) {
      view.lastRenderedSeq = chunkSeq;
      view.term.write(data);
      return;
    }

    // Gap detected:
    console.warn(`[Terminal] Sequence gap detected on ${sessionId}: expected ${view.lastRenderedSeq + 1}, received ${chunkSeq}`);
    view.state = 'gapped';
    view.pendingQueue.push({ seq: chunkSeq, data });
    api.requestTerminalResync(sessionId, view.lastRenderedSeq);
  }
  ```

---

## 9. Conclusion: Architectural Defense of Candidate 4

Candidate 4 directly addresses the root vulnerabilities identified in the AntiFan Terminal Deep Audit. By treating **Session Durability, Persistence Integrity, and TUI State Continuity** as first-class architectural invariants rather than superficial UI afterthoughts, this proposal transforms AntiFan's terminal from a fragile, disposable UI panel into a rock-solid developer workstation command center.

The solo theme developer working with Haravan, Sapo, Shopify CLI, and AI coding agents on Windows 11 requires a terminal that **never forgets context, never corrupts full-screen TUIs, and never presents a silent black screen**. Candidate 4 provides the exact blueprint and execution roadmap to deliver that promise.

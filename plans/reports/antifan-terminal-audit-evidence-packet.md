# IMMUTABLE EVIDENCE PACKET: ANTI-FAN TERMINAL DEEP AUDIT ANALYSIS
**Document ID:** `evidence-packet-antifan-terminal-2026-09-06`  
**Target Report:** `E:\Download\antifan-terminal-deep-audit-and-improvement-plan-2026-09-05.md` (1747 lines)  
**Workspace:** `E:\Work\apps\antifan-browser-desktop` (Commit `96aa34f`)  
**Host Workstation:** Windows 11 Pro x64, Intel i5-9300H, solo Theme Developer (Haravan / Sapo / Shopify, PowerShell, OMP / Codex / AI CLIs, Vite/esbuild watchers).

---

## 1. Request & Mandate
Analyze the deep architectural audit report `antifan-terminal-deep-audit-and-improvement-plan-2026-09-05.md` using `ak:brainstorm --ultra`.
Transform the audit findings into a concrete, bounded delivery contract for the engineering roadmap:
- **Outcome:** The user-visible and operational target end state.
- **Constraints:** Technical, architectural, safety, and operational boundaries.
- **Non-goals:** Explicitly excluded scope and anti-patterns.
- **Acceptance criteria:** Sharp, measurable, observable criteria to verify success.
- **Compared Approaches & Trade-offs:** Evaluation of viable sequencing / architectural strategies with worst-case failure modes and load-bearing assumptions.
- **Immediate Execution Recommendation:** Concrete first wave of implementation.

---

## 2. Core Architectural Diagnosis (From Audit & Code Telemetry)
The audit proves that AntiFan's Terminal backend (`node-pty` per-session PTYs, sequence numbers, generation IDs, buffer tracking) is fundamentally sound (~8/10), but user-visible reliability is degraded (~5.5-6/10) due to severe architectural asymmetries in the renderer and transport layers:

### Primary Principle
> **PTY Session != Terminal View != Layout.**  
> A Split is a layout relationship between two terminal sessions; it must never be a disposable renderer lifecycle.

### The 5 P0/P1 Root Causes Verified Against Workspace Code:
1. **P0 Root Cause #1: Split view is a disposable singleton (`src/renderer/standalone.js`)**
   - Main terminal views live in persistent `terminalPool` (`Map<sessionId, TerminalItem>`), preserved across tab switches.
   - Split uses singleton globals (`splitTerm`, `splitFitAddon`, `splitWriteTarget`). `unmountSplit()` explicitly disposes `splitTerm`, FitAddon, and DOM.
   - Switching tabs destroys the xterm VT state machine (cursor modes, screen buffer, alternate screen, wrapped lines).
   
2. **P0 Root Cause #2: Split remount rebuilds from a severely bounded snapshot**
   - `listSessions(paged=true)` allocates a tiny JSON wire budget (~40 KiB shared across all sessions; split gets a fraction).
   - A remounted split receives only a few KiB tail, despite the backend having 512 KiB and xterm configured for 50,000 lines scrollback.

3. **P0 Root Cause #3: Raw PTY tail is not a safe terminal screen snapshot**
   - Interactive TUI, AI CLI (OMP/Codex), and PowerShell status lines rely on cursor positioning, alternate screen, and carriage returns (`\r`). Replaying an arbitrary byte tail into a newly created terminal causes cursor offset bugs, garbled layouts, or blank screens.
   - Core fix: Keep xterm instances alive for the entire lifetime of the PTY session. Use `SerializeAddon` only as secondary disaster recovery.

4. **P0 Root Cause #4: Output dropped while docked sidebar is hidden (`src/main/browser/native-tab-host.ts:1164`)**
   - `if (this.isSidebarOpen && this.sidebarView && !this.sidebarView.webContents.isDestroyed()) safeSendWebContents(...)`
   - When sidebar is hidden, data chunks (`antifan:terminal:data`) are NOT sent to the docked renderer.

5. **P0 Root Cause #5: Sequence dedup exists, but sequence-gap recovery does not**
   - Renderer checks `chunk.seq <= lastRenderedSeq` (discards duplicates), but if `incomingSeq > lastRenderedSeq + 1` (e.g. seq 100 -> 150), it blindly renders seq 150, permanently skipping sequences 101..149 without detecting a gap or triggering resync.

### Additional Verified Deficiencies:
6. **Persistence Bug (`src/main/browser/terminal-manager.ts:426, 435`):**
   - `spawn(item.id, item.cwd || this.currentCwd, '')` passes `''` (empty string) instead of `item.buffer`. App restart loses terminal history despite writing it to disk.
7. **Geometry / 80-20 Split Crash:**
   - Percentage-based height in short docked panels leaves 8-12px for the xterm host, which cannot fit a single cell (~15-18px), resulting in an unusable black box.
8. **Silent Exception Swallowing (`standalone.js`):**
   - Broad `try {} catch {}` around fit, resize, refresh, and write hides crashes and turns errors into opaque black panes.
9. **Windows PTY Coupling:**
   - `TerminalManager` accesses private `node-pty` fields (`_socket`, `_pid`, `_fd`). Needs encapsulation behind a `WindowsPtyAdapter`.

---

## 3. Scope of Candidates' Proposals
Each candidate must analyze this evidence and formulate:
1. **Outcome:** A unified, rock-solid Terminal subsystem where Split and Main terminals survive all tab switches, sidebar toggles, and resize events without blank panes or dropped characters.
2. **Constraints:**
   - Local Windows 11 workstation, single developer.
   - Do NOT rewrite the PTY backend from scratch.
   - Do NOT rush ConPTY migration or WebGL re-enablement before renderer state loss is solved.
   - Strict backward compatibility with current theme development workflow (Haravan/Sapo/Shopify CLIs).
3. **Non-goals:**
   - Enterprise multi-tenant terminal scheduling, remote SSH daemons.
   - WebGL renderer re-enablement (known context loss risks).
   - ConPTY rewrite in initial wave.
   - Full TTY virtualization or custom VT parser.
4. **Acceptance Criteria (Checkable & Sharp):**
   - Quantitative thresholds for scrollback survival (e.g. 10k lines).
   - Sequence gap detection state machine behavior.
   - Verification of E2E test suite under real Electron runtime on Windows.
   - Handling of minimal pane geometry.
5. **Compared Approaches & Trade-offs:**
   - E.g. Monolithic vs Staged Delivery vs Minimalist Surgical Fix.
   - Analysis of failure modes and load-bearing assumptions for each approach.

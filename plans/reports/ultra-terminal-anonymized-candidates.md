# ANONYMIZED CANDIDATES FOR ULTRA BRAINSTORM VERIFIER PASS
**Target:** AntiFan Terminal Deep Reliability Audit & Improvement Plan  
**Rubric (1.0 - 20.0 each, 25% weight):**
1. Faithfulness to the request (25%)
2. Evidence Grounding (25%)
3. Sharpness of Acceptance Criteria (25%)
4. Honesty about Unknowns / Failure Modes (25%)

---

## CANDIDATE A
- **Thesis:** Durability, Session Lifecycle & TUI/AI CLI Context Continuity
- **Core Strategy:** Focuses on state machine continuity, decoupling persistence metadata (`sessions.json`) from rolling streaming disk logs (`transcripts/*.log`), dual-buffer awareness (Alternate Screen Buffer DECSET 1049 stability), fixing the `spawn(..., '')` empty string bug in `terminal-manager.ts:426, 435`, and establishing strict visual demarcation between historical transcript and new process execution.
- **Compared Options:**
  1. Monolithic Re-Architecture & Heavy Driver Overhaul (Rejected: high blast radius, premature ConPTY risks).
  2. Pure Frontend View Caching without Persistence Overhaul (Rejected: fragile cold restarts, unbounded RAM).
  3. Decoupled Durability Continuum (Dual-Buffer Stability + Rolling Transcripts + Persistent Pool) [Recommended].
- **Acceptance Criteria:**
  - GATE-1: 100 tab switches with active OMP/Codex TUI in split pane with 0 cursor drift and 0 line duplication.
  - GATE-2: Cold restart restores >=10,000 lines of prior scrollback with clean visual separator and functional fresh shell.
  - GATE-3: Hidden sidebar drops 0 sequences across 50MB continuous streaming.
  - GATE-4: Minimum 8 rows enforced dynamically; sub-cell splits rejected with actionable UI toast.
  - GATE-5: Zero process leaks verified via Windows `tasklist` after closing split panes.
- **Wave 1 Priorities:**
  1. Fix `spawn()` persistence buffer bug immediately.
  2. Implement `TerminalViewRegistry` in `standalone.js` eliminating `splitTerm.dispose()`.
  3. Remove hidden-sidebar delivery suppression in `native-tab-host.ts`.
  4. Implement strict monotonic sequence gap recovery state machine.
  5. Add dynamic cell-aware geometry floor.

---

## CANDIDATE B
- **Thesis:** Robust Geometry Coordination & Failure-Transparent Surface
- **Core Strategy:** Focuses on presentation surface defects: silent physical starvation in short docked panels and silent failure masking (eliminating 30+ empty `catch {}` blocks in `standalone.js`). Introduces `TerminalGeometryCoordinator` with RAF coalescing, dynamic cell metric calculations (`MIN_VISIBLE_ROWS = 8`), continuous `TerminalViewHealth` telemetry, and in-pane `[Recover View]` actionable banners.
- **Compared Options:**
  1. Brute-Force View Re-Instantiation & Timer Polling (Rejected: exacerbates race conditions, burns CPU).
  2. Architectural Rewrite with Headless VT Server (Rejected: extreme complexity, double memory overhead).
  3. Failure-Transparent Surface & Geometry Coordinator [Recommended].
- **Acceptance Criteria:**
  - GATE-A: Zero black panes during 100 random divider drags and rapid tab switches.
  - GATE-B: Dynamic floor rejection when container height < (8 rows * cellHeight + header).
  - GATE-C: Viewport stability: incoming data does not steal scroll position when `viewportY < baseY`.
  - GATE-D: Sequence gap self-repair with zero duplicate writes and telemetry log entry.
  - GATE-E: Error transparency: zero empty catch blocks; any write/fit failure transitions health to `ERROR` with user-facing recovery badge.
- **Wave 1 Priorities:**
  1. Replace broad silent `catch {}` with structured `TerminalViewHealth`.
  2. Establish `TerminalGeometryCoordinator` and deprecate global `resize()`.
  3. Migrate Split to persistent `terminalPool`.
  4. Fix hidden sidebar data gating.
  5. Implement gap detection and delta resync.

---

## CANDIDATE C
- **Thesis:** Unified View Registry & Lifecycle Decoupling
- **Core Strategy:** Focuses on the primary architectural principle: **PTY Session != Terminal View != Layout**. Unifies `terminalPool` and `splitTerm` into a single `TerminalViewRegistry<Map<sessionId, TerminalView>>`. Normal tab switches and dock toggles only rebind DOM nodes (`display: none / flex`) and NEVER call `splitTerm.dispose()`. Implements strict sequence gap detection (`READY -> GAPPED -> RESYNCING -> READY`) and fixes the persistence `spawn` bug.
- **Compared Options:**
  1. Monolithic Subsystem Rewrite (Phases T0-T7 all at once) (Rejected: violates KISS/YAGNI, extreme regression risk for storefront CLIs).
  2. Superficial Hotfix (Resize debouncing + larger wire budget) (Rejected: treats symptoms, leaves lifecycle asymmetry intact).
  3. Decoupled View Registry & Lossless Transport (Phased P0 Cutover) [Recommended].
- **Acceptance Criteria:**
  - GATE-A: 100 tab switches under 10,000 lines scrollback with 0ms rehydration delay and 0 lines lost.
  - GATE-B: Sequence gap healing: artificially dropped sequence 101..149 auto-repaired via authoritative delta.
  - GATE-C: Hidden dock durability: 100% output preserved after 1-hour hidden compilation.
  - GATE-D: TUI screen integrity: alternate screen buffer preserved across tab navigation without cursor offsets.
  - GATE-E: Minimum geometry guard: short dock panel refuses sub-5-row splits.
  - GATE-F: Cold restart durability: restored buffer rendered with visual session demarcation.
  - GATE-G: Windows process cleanup: zero orphaned node/powershell processes.
- **Wave 1 Priorities:**
  1. Phase T0: Diagnostic instrumentation & view health.
  2. Phase T2: Unified `TerminalViewRegistry` in `standalone.js`.
  3. Phase T1: Lossless sidebar IPC & sequence gap recovery.
  4. Phase T3: Cell-aware Split minimum geometry guard.
  5. Phase T4: Persistence spawn buffer bug fix.
  6. E2E verification suite under real Windows 11 Electron runtime.

---

## CANDIDATE D
- **Thesis:** Lean Surgical P0 Cutover
- **Core Strategy:** Ruthlessly applies KISS and YAGNI. Analyzes the 1747-line audit and argues that full T0-T7 rewrite is enterprise over-engineering for a solo theme developer. Recommends an ultra-tight surgical cutover of <250 lines of code across 4 files: promoting split into existing `terminalPool`, removing the `if (this.isSidebarOpen)` check in `native-tab-host.ts`, adding a 30-line gap detection check, fixing the empty string argument in `terminal-manager.ts`, and adding an 8-row minimum clamp in `standalone.js`.
- **Compared Options:**
  1. Full Enterprise Architectural Rewrite (Phases T0–T7) (Rejected: massive blast radius, high regression hazard).
  2. Patching Symptoms via Polling Timers (Rejected: fragile, does not fix disposable lifecycle).
  3. Lean Surgical P0 Cutover (<250 LoC) [Recommended].
- **Acceptance Criteria:**
  - AC-1: Split Pane Tab-Switch Invariance (100 switches, 0 lines lost).
  - AC-2: Zero Sidebar Blackout (closing sidebar drops 0 bytes).
  - AC-3: Strict Sequence Monotonicity (`incomingSeq > lastRenderedSeq + 1` triggers resync).
  - AC-4: Persisted Scrollback Restoration on App Launch.
  - AC-5: Minimum 8-row geometry clamp preventing sub-cell black box.
  - AC-6: Real Windows Electron Smoke Certification (`npm run smoke:terminal`).
- **Wave 1 Priorities:**
  1. Unify Split into `terminalPool` (`standalone.js`).
  2. Remove hidden sidebar IPC gate (`native-tab-host.ts`).
  3. Add sequence gap detection & delta resync (`standalone.js`).
  4. Fix persisted buffer argument in `spawn()` (`terminal-manager.ts`).
  5. Add cell-aware minimum height guard (`standalone.js`).

---

## CANDIDATE E
- **Thesis:** Zero-Loss Sequence Continuity & Watermark Transport Protocol
- **Core Strategy:** Focuses on transport and wire protocol correctness as the absolute prerequisite. Introduces an authoritative **Watermark Transport Protocol (WTP)**, decoupling metadata (`listSessions`) from transcript transport, a Sequence Delta Ring Buffer in the main process, a formal Renderer Gap State Machine (`READY -> GAPPED -> RESYNCING -> READY`), a Lossless Watermark Suspend/Resume handshake for the sidebar, and unified persistent view pooling.
- **Compared Options:**
  1. UI-First Cosmetic Fix (Fit Addon tweaking & larger JSON budget) (Rejected: does not fix transport data loss).
  2. Complete Native PTY Driver Greenfield Replacement (Rejected: unnecessary, `node-pty` backend is sound).
  3. Watermark Transport Protocol & State Machine Decoupling [Recommended].
- **Acceptance Criteria:**
  - Metric: Unrepaired sequence gaps = strictly 0.
  - Metric: Sidebar toggle data loss = 0 bytes.
  - Metric: Split remount scrollback = full 50,000 lines preserved.
  - Metric: `listSessions` wire payload = < 2 KiB (metadata only).
  - Metric: Gap recovery latency = < 10 ms.
  - Metric: Restart scrollback retention = 256 KiB per session.
  - Protocol test: Injected drop of sequences 50..99 halts render, pulls delta, renders contiguous 1..150 with zero duplicates.
- **Wave 1 Priorities:**
  1. Establish WTP protocol & IPC channels (`getTerminalSnapshot`, `getTerminalDelta`).
  2. Main process Sequence Delta Ring Buffer.
  3. Renderer Sequence Gap State Machine.
  4. Unified Persistent Split View in `terminalPool`.
  5. Remove hidden sidebar drop in favor of suspend/resume watermark handshake.
  6. Fix persistence restore buffer bug.

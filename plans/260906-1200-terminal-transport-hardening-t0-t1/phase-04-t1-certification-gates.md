# Phase 4 (T1.C): Windows Electron Real-Runtime Certification

**Goal:** Execute the full automated verification suite against a live Windows 11 Electron process. Prove all transport invariants and earn the authoritative `[P0-Transport Certified]` status.

---

## Commit 7: E2E Transport Verification Suite & P0-Transport Certification

### 1. Files & Scripts to Create & Modify
- `test/e2e/terminal-transport-sync.cjs`:
  - Dedicated Playwright / Electron runner executing the 5 core transport gates against live `standalone.js` and `TerminalManager`:
    1. **GATE-B Test (Sequence Gap Healing):**
       - Intercept preload IPC to drop chunks 200..249.
       - Emit chunk 250.
       - Assert renderer detects gap, transitions to `GAPPED`, queries delta, renders contiguous 200..250.
       - Assert latency: $p95 < 250\text{ms}$.
       - Compare final scrollback buffer with `@xterm/headless` test oracle: 0 missing bytes, 0 duplicates.
    2. **GATE-C1 Test (Sidebar Hidden Streaming):**
       - Spawn active PowerShell session running counting loop.
       - Close docked sidebar (`isSidebarOpen = false`).
       - Stream 1,000 lines over 15 seconds.
       - Reopen sidebar.
       - Assert all 1,000 lines are immediately visible in DOM without manual reload.
    3. **GATE-C2 & GATE-J Test (Delta Expiry & Honest Degradation):**
       - Inject artificial sequence jump exceeding `MAX_DELIVERY_JOURNAL_CHUNKS` (e.g. 5,000 chunks).
       - Query delta $\rightarrow$ receive `DELTA_EXPIRED`.
       - Assert renderer transitions to `DEGRADED`.
       - Assert in-pane warning badge `[Terminal Display Out of Sync]` is visible.
       - Assert renderer DOES NOT mark state `READY`.
    4. **GATE-I Test (Bootstrap Recovery on Idle PTY):**
       - Spawn session, emit 500 lines, settle to idle prompt.
       - Reload renderer webContents.
       - Assert `api.syncTerminalView()` executes on attach and brings view up to seq 500 without waiting for a new chunk.
- `package.json`:
  - Add script: `"test:terminal-transport": "npm run compile && node scripts/run-electron.cjs test/e2e/terminal-transport-sync.cjs"`.

### 2. Certification Evidence & Report Generation
- The test script generates a machine-readable certification receipt:
  `plans/reports/terminal-p0-transport-certification.json` containing:
  - Exact timestamp, git commit, Windows build version.
  - Per-gate execution timings, memory high-water marks, and byte fidelity hash comparisons.
  - Formal verdict: `[P0-Transport Certified]`.

### 3. Definition of Done (Commit 7)
- [ ] `npm run test:terminal-transport` runs cleanly on Windows 11 and passes 100% of Gates B, C1, C2, I, and J.
- [ ] Zero memory leaks: renderer heap memory stabilizes after 10,000 streaming chunks.
- [ ] `plans/reports/terminal-p0-transport-certification.json` is generated with verdict `PASS`.
- [ ] Subsystem is officially declared `[P0-Transport Certified]`, unlocking Phase T2 (View Registry refactoring).

# Candidate reframings (anonymized, unordered)
Five independent read-only candidates answered the same immutable evidence packet
(`ultra-unblock-packet.md`). Author and dispatch order are stripped; the labels below are
random. Score each on the packet's rubric (A symptom-to-technique fit, B depth of
application, C actionability, D honesty about unknowns) 1-20 per criterion, then select
one winner unchanged or reject all.


---

## Candidate A

```json
{
  "application": "Application of Collision-Zone Thinking to AntiFan (file:line evidence):\n\n1. Collision Zone A: Presentation vs Control-Plane Authority (H1 - CONFIRMED)\n- Evidence: `scripts/probe-project-windows-matrix.cjs:259-296` seeds 5 projects into `config/workspace-capsules.json`. But in `src/main/index.ts:2120`, `capsuleManager = new WorkspaceCapsuleManager({ filePath: capsuleStoragePath })` is constructed without `affiliationAuthority: { projectRegistry }`.\n- In `src/main/control-plane/control-plane-runtime.ts:162-169`, only the initial boot project/workspace (Alpha/d1) is registered into `this.workspaces` via `ensureInitialWorkspace`.\n- `ProjectRegistry.prototype.attachWorkspace` (`src/main/project/project-registry.ts:75`) and `registerProject`…
  "technique": "Collision-Zone Thinking",
  "h1_h2_h3": {
    "H3": {
      "verdict": "FALSIFIED_AS_CAUSE_OF_R7",
      "evidence": "terminal-manager.ts:1872-1881 uses creationCapsuleId provenance and does not inspect getActive() or reject foreign capsules. R7 failure is caused by DaemonTerminalProxy async createSession returning a Promise when called synchronously without await in probe script line 2137 (documented in terminal-capabilities.ts:460-466)."
    },
    "H2": {
      "verdict": "CONFIRMED_AND_REFINED",
      "evidence": "Toolbar view resizing is duplicated between project-window-shell.ts:538-540 and native-tab-host.ts:4537-4539; unmaximize/setBounds in R12a leaves the toolbar renderer at 1184px while native availableWidth is 944px. Lingering toolbar/chrome views prevent clean shell disposal in R6a."
    },
    "H1": {
      "evidence": "src/main/index.ts:2120 constructs WorkspaceCapsuleManager without affiliationAuthority; control-plane-runtime.ts:162-169 only registers initial boot workspace; project-registry.ts:75 attachWorkspace has 0 callers in src/main/index.ts. When Beta (d2) attempts open-tab, resolveWorkspaceForSession fails with WORKSPACE_MISMATCH.",
      "verdict": "CONFIRMED"
    }
  },
  "residual_unknowns": [
    "Exact daemon process attachment state during the specific 14:39Z test run (whether DaemonTerminalProxy was connected via an orphaned daemon on the host or if in-process fallback was active). Settle check: read the 14:39Z stdout for '[index] Terminal Host Daemon connected' vs '[index] Terminal Host Daemon unavailable'.",
    "Why nativeLayout(betaKey, betaAnchorTab).pageRect in R5a was null: whether betaAnchorTab's view was not yet attached to window B's contentView hierarchy or if B was minimized. Settle check: inspect viewRects(court.windowFor(betaKey)) before and after R5a."
  ],
  "symptom_match": "The 10 failing rows form a tangle of interlocking lifecycle and authority defects where fixing one row risks another, caused by conflicting subsystem assumptions at boundary seams rather than localized single-file logic errors.",
  "status": "DONE",
  "unblock_path": [
    "Step 1: Wire Control-Plane Registry Ingestion (Flips R2, R4c, R3a, R3c). In src/main/index.ts:1196 (ensureProjectWindow), when a project window opens, register its project and workspace in ProjectRegistry/WorkspaceRegistry via controlPlane.workspaces.ensureInitialWorkspace or projects.attachWorkspace, or pass affiliationAuthority to WorkspaceCapsuleManager in src/main/index.ts:2120. Proving instrument: node scripts/run-electron.cjs scripts/probe-project-windows-matrix.cjs (assert rows R2, R4c, R3a, R3c PASS).",
    "Step 2: Fix Split Review Auto-Reload Destruction in src/main/browser/native-tab-host.ts:5525-5528 (Flips R10a, R10b). Guard did-navigate handler so that initial mobileView mount does not call siblingView.webContents.reload() when desktop view is already loaded with the same URL, and ensure R5a disables splitMode or restores desktop pane focus before completing. Proving instrument: Probe matrix rows R5a, R10a, R10b.",
    "Step 3: Align Toolbar Resize and Chrome View Teardown in ProjectWindowShell and NativeTabHost (Flips R12a, R12b, R6a). Unify toolbarView.setBounds triggering on BrowserWindow 'resize'/'will-resize' so the toolbar renderer viewport updates synchronously with native content geometry, and ensure shell disposal cleans up all WebContentsViews so browserShellCount() drops to 1 in R6a. Proving instrument: Probe matrix rows R12a, R12b, R6a.",
    "Step 4: Fix Terminal createSession Async Interface Alignment (Flips R7). In scripts/probe-project-windows-matrix.cjs:2137, wrap terminal.createSession with await Promise.resolve(planeOf().terminal.createSession(BETA.path, BETA.capsuleId)), and ensure DaemonTerminalProxy forwards or preserves capsuleId provenance. Proving instrument: Probe matrix row R7.",
    "Step 5: Run Post-Exit Orphan Watcher and Phase 5 Certification Matrix (Flips R9E, R9c, full matrix). Run scripts/run-electron.cjs scripts/probe-project-windows-matrix.cjs --verify-orphans and verify generation of plans/260927-0315-project-windows/reports/project-windows-matrix.json with 22/22 green."
  ]
}

[Some lines truncated to 768 chars]
```


---

## Candidate B

```json
{
  "unblock_path": [
    "Step 1: Bridge CapsuleAffiliationAuthority into ControlPlane ProjectRegistry & WorkspaceRegistry at startup (src/main/index.ts:2120 & control-plane-runtime.ts:162). Whenever a capsule is loaded or created, synchronize it into ControlPlaneRuntime.projects and workspaces. Instrument: `node --test .compiled/test/main/project-workspace-ownership.test.js`. Flips matrix rows: R2, R3a, R4c, R3c.",
    "Step 2: Unblock Project Chooser UI & openProjectWindow fallback. Update src/renderer/standalone.js to display the project picker/switcher on all shells, and update src/main/index.ts:1308-1320 so that openProjectWindow without an explicit projectId displays a quick-pick palette of known capsules instead of returning CANCELLED. Instrument: `node scripts/run-electron.cjs scripts/probe-project-windows.cjs`. Delivers the user's primary goal (choosing and switching across 3-5 projects).",
    "Step 3: Align DaemonTerminalProxy.createSession API contract (src/main/terminal-daemon/daemon-client.ts:388). Make createSession synchronous by pre-minting the session ID or update callers/harness to await the session creation, and forward capsuleId to the daemon. Instrument: `npm run smoke:terminal`. Flips matrix row: R7.",
    "Step 4: Fix active-view attachment inspection in R5a and layout invalidation in R12a/R12b. In probe-project-windows-matrix.cjs:1608, activate betaAnchorTab before measuring native tab rects (background tabs in WebContentsView are detached from contentView). In ProjectWindowShell.applyChromeBounds (src/main/browser/project-window-shell.ts:538), ensure webContents.invalidate() or layout notifications are dispatched to sync innerWidth. Instrument: `node scripts/run-electron.cjs scripts/probe-project-windows-matrix.cjs`. Flips matrix rows: R5a, R12a, R12b.",
    "Step 5: Enforce clean attachment release and reservation cleanup in R6a and R10a/R10b. Ensure revoked attachments explicitly release pending reservations in closeCoordinator so that idle window close succeeds without timeout. Instrument: `node scripts/run-electron.cjs scripts/probe-quit-coordination.cjs`. Flips matrix rows: R6a, R10a, R10b, R9E."
  ],
  "technique": "Collision-Zone Thinking",
  "symptom_match": "Cross-domain authority deadlock between Presentation Capsules, Control Plane Registries, and Window Shell Authority: The solo user running 3-5 concurrent workspaces across multiple monitors has no project chooser (the chip is read-only, 'Mở dự án…' in src/renderer/standalone.js:128 is display:none on project windows and returns CANCELLED on unassigned), while automated background agent dispatches fail closed with WORKSPACE_MISMATCH because non-boot projects loaded from workspace-capsules.json are never registered into ControlPlaneRuntime.projects/workspaces.",
  "application": "Root Cause Synthesis:\nThe missing project picker and the WORKSPACE_MISMATCH matrix failures share one unified architectural root cause: Project Identity Fragmentation across decoupled subsystems. In this codebase, 'Project' exists in three non-communicating islands:\n1. Presentation & Storage: WorkspaceCapsuleManager (src/main/project/workspace-capsule.ts:60-110) persists project metadata in workspace-capsules.json, instantiated in src/main/index.ts:2120 WITHOUT affiliationAuthority.\n2. Control Plane Registry: ControlPlaneRuntime (src/main/control-plane/control-plane-runtime.ts:162-169) only registers the boot project (ALPHA) via workspaces.ensureInitialWorkspace(). ProjectRegistry (src/main/project/project-registry.ts:99-105) has ZERO re…
  "status": "DONE",
  "residual_unknowns": [
    "Unknown 1: Windows 11 DirectComposition rendering latency for WebContentsView resize propagation — settling check: create a standalone test invoking BrowserWindow.setBounds() followed by reading toolbarView.webContents.executeJavaScript('window.innerWidth') at 10ms intervals to verify the exact debounce required for synchronous layout stability.",
    "Unknown 2: ConPTY process tree lifecycle when 5 project windows concurrently invoke DaemonTerminalProxy across multiple monitor DPI boundaries — settling check: execute `npm run smoke:terminal` with `ANTIFAN_USE_TERMINAL_DAEMON=1` under 5 initialized project shells."
  ],
  "h1_h2_h3": {
    "H3": {
      "evidence": "src/main/terminal-daemon/daemon-client.ts:388, src/main/browser/terminal-manager.ts:1872, src/main/index.ts:1529, scripts/probe-project-windows-matrix.cjs:2125",
      "verdict": "FALSIFIED_AND_REFINED"
    },
    "H1": {
      "evidence": "src/main/control-plane/control-plane-runtime.ts:162-169, src/main/index.ts:2120, src/main/tools/capability-catalogue.ts:358, src/main/project/project-registry.ts:100",
      "verdict": "CONFIRMED"
    },
    "H2": {
      "evidence": "src/main/browser/project-window-shell.ts:538-540, test/main/project-window-shell-disposal.test.ts:5-15, scripts/probe-project-windows-matrix.cjs:1890-1910",
      "verdict": "FALSIFIED"
    }
  }
}

[Some lines truncated to 768 chars]
```


---

## Candidate C

```json
{
  "application": "Detailed codebase evidence and analysis across the lifecycle cluster:\n\n1. R12a / R12b — Toolbar Viewport (1184px) vs Native Geometry (944px / 1920px):\n- In `scripts/probe-project-windows-matrix.cjs:1104`, `alphaToolbar` is captured once at boot: `const alphaToolbar = await toolbarFor(alphaKey)`. At boot (`lines 1199-1200`), window A is sized to width 1200 (workArea bounded), giving content width 1184px (`1200 - 16px` Windows non-client frame).\n- In R12a (`lines 1891-1894`), `alphaWindowRef.setBounds({ width: 960, height: 640 })` resizes the window. `nativeLayout()` (`line 1902`) dynamically computes `native.geometry.availableWidth = 944px` on the fly via `window.getContentBounds()`.\n- However, `layout = await chromeLayout(alphaToolbar)…
  "status": "DONE",
  "h1_h2_h3": {
    "H3": "CONFIRMED: TerminalManager maintains global process-wide active capsule state (src/main/browser/terminal-manager.ts:981-1000) rather than owner-scoped session allocation, blocking terminal creation for project B when window A is focused.",
    "H2": "FALSIFIED / REFINED: R12a/R12b and R6a do not share a single cause in 'leftover toolbar#2'. R12a/R12b is a geometry/viewport propagation desync where BrowserWindow.setBounds does not synchronously update WebContentsView layout before probe evaluation. R6a is a close refusal caused by live-use evidence encountering unknown run states from unregistered projects (downstream of H1) and auditOwnContentsDisposed timing, compounded by this.toolbarView not being cleared to null in project-window-shell.ts:966.",
    "H1": "CONFIRMED: Capsule affiliation in config/workspace-capsules.json is completely decoupled from ControlPlaneRuntime's ProjectRegistry/WorkspaceRegistry. ControlPlaneRuntime only registers the boot project (src/main/control-plane/control-plane-runtime.ts:162-169), and WorkspaceCapsuleManager has no affiliationAuthority wired (src/main/index.ts:2120). This causes WORKSPACE_MISMATCH on all project B dispatches."
  },
  "residual_unknowns": [
    "Exact duration required for Electron WebContentsView renderer to complete resize reflow on Windows after BrowserWindow.setBounds without an explicit CDP Page.setDeviceMetricsOverride or IPC layout roundtrip. Check: evaluate window.innerWidth via a requestAnimationFrame poll inside the toolbar WebContents following setBounds.",
    "Whether Electron 43 on win32 synchronously fires 'closed' on BrowserWindow when window.close() is called during an authorized close attempt with child WebContentsViews attached. Check: inspect BrowserWindow closed event timestamp relative to auditOwnContentsDisposed settle timer in a standalone script.",
    "Whether any in-flight background tasks remain in browserPort.waitRegistry during R6a that contribute to live-use busy evidence. Check: read closeReservations.snapshot() and browserPort.waitRegistry immediately prior to court.requestClose(alphaKey)."
  ],
  "symptom_match": "Interlocking lifecycle/authority collisions where Control-Plane registry decoupling (H1) cascades into Close-Coordinator live-use refusals (R6a), while Electron WebContentsView geometry propagation races against native window resize (R12a/R12b) and active tab view detachment drops native rect measurement (R5a).",
  "unblock_path": [
    "Step 1: Unify Capsule & Project Registry Authority (Fixes H1 -> Flips R2, R4c, R3a, R3c). Wire WorkspaceCapsuleManager affiliation authority or synchronize ProjectRegistry/WorkspaceRegistry upon capsule loading in src/main/index.ts and control-plane-runtime.ts. Proving instrument: node scripts/run-electron.cjs scripts/probe-project-windows-matrix.cjs (R2-R3c slice).",
    "Step 2: Fix Active Tab Rect Measurement in Virtualized Host (Flips R5a). In scripts/probe-project-windows-matrix.cjs (or NativeTabHost.getTabContentBounds), ensure nativeLayout inspects the tab's current view whether attached or unattached, or switch active tab to betaAnchorTab before asserting split independence. Proving instrument: probe-project-windows-matrix.cjs R5a assertion.",
    "Step 3: Fix Close-Coordinator Live-Use Unknown Propagation and Shell Cleanup (Flips R6a). In src/main/index.ts (enumerateCloseLiveUseRuns) and close-live-use.ts, correctly attribute project runs and treat completed/unregistered runs cleanly; in project-window-shell.ts:964-967, null this.toolbarView and ensure auditOwnContentsDisposed completes promptly. Proving instrument: node scripts/run-electron.cjs scripts/probe-quit-coordination.cjs and matrix R6a.",
    "Step 4: Synchronous Chrome Layout Propagation & Maximize/Unmaximize Handlers (Flips R12a, R12b). In src/main/browser/native-tab-host.ts, add listeners for 'maximize' and 'unmaximize' on shell, expose an explicit synchronous flushLayout() or await the toolbar renderer's resize before sampling, and re-fetch the live toolbar surface in probe script instead of reusing the initial 1200px snapshot. Proving instrument: matrix probe R12a and R12b.",
    "Step 5: Scope Terminal Session Allocation to Target Window Owner (Fixes H3 -> Flips R7). In src/main/browser/terminal-manager.ts:981-1000, decouple session creation from global active capsule by accepting explicit ownerKey/capsuleId without global state contamination. Proving instrument: matrix probe R7."
  ],
  "technique": "Collision-Zone Thinking"
}

[Some lines truncated to 768 chars]
```


---

## Candidate D

```json
{
  "h1_h2_h3": {
    "H3": "CONFIRMED AND EXPANDED. R7 failure is dual-cause: (1) Contract signature mismatch: DaemonTerminalProxy.createSession is async returning Promise<string> while TerminalManager.createSession is sync returning string; scripts/probe-project-windows-matrix.cjs:2137 calls it synchronously, getting a Promise object instead of a string. (2) Process-global capsule contamination: TerminalManager.setCapsule / effectiveCreationCapsuleId couples terminal creation to process-global active capsule rather than the invoking window host's verified capsule.",
    "H2": "CONFIRMED WITH REFINEMENT. R12a and R12b fail because toolbar WebContentsView innerWidth does not track native setBounds width without explicit renderer resize notification/zoom reflow. R6a fails because project-window-shell.ts:964 never nulls this.toolbarView during disposeChrome, causing toolbar#2 to survive disposal audit or race page close deadlines. They share the common root of chrome WebContentsView lifecycle and geometry desynchronization in ProjectWindowShell.",
    "H1": "CONFIRMED. Capsule affiliation in WorkspaceCapsuleManager is completely decoupled from ControlPlaneRuntime's ProjectRegistry/WorkspaceRegistry. WorkspaceCapsuleManager is instantiated without affiliationAuthority in src/main/index.ts:2120. ControlPlaneRuntime (src/main/control-plane/control-plane-runtime.ts:162-169) only registers the boot workspace (ALPHA). When BETA is opened via ensureProjectWindow, it is never registered in controlPlane.workspaces. Thus, capability calls for BETA throw WORKSPACE_MISMATCH from CapabilityCatalogue.resolveAuthoritativeWorkspace (src/main/tools/capability-catalogue.ts:358), directly causing R2, R3a, R4c, and R3c."
  },
  "application": "Applying Meta-Pattern Recognition to this codebase reveals that the 10 failing matrix rows do not represent 10 isolated bugs, but rather a recurring architectural schism: Presentation Track (UI views, ProjectWindowShell, WorkspaceCapsuleManager) vs Control-Plane Track (ProjectRegistry, WorkspaceRegistry, CapabilityCatalogue, TerminalManager).\n\n1. Root Cause Analysis of H1 (R2, R3a, R4c, R3c Cluster):\n- In scripts/probe-project-windows-matrix.cjs:259-296 & 314-329, five project capsules (alpha through epsilon) are written to config/workspace-capsules.json with explicit projectIds and workspaceIds.\n- At startup, src/main/index.ts:2120-2122 instantiates capsuleManager = new WorkspaceCapsuleManager({ filePath: capsuleStoragePath }) with NO …
  "unblock_path": [
    "Step 1: Unify Project/Workspace Registration (Fixes H1: R2, R3a, R4c, R3c). In src/main/index.ts, instantiate a single shared ProjectRegistry before capsuleManager and pass { projectRegistry } as affiliationAuthority to WorkspaceCapsuleManager; pass that same ProjectRegistry into ControlPlaneRuntime options.projects. In ensureProjectWindow (src/main/index.ts:1178), call controlPlane.workspaces.ensureInitialWorkspace(record.projectId, record.workspaceId, record.workspacePath, dataRoot) whenever a project window opens. Proving instrument: node scripts/run-electron.cjs scripts/probe-project-windows-matrix.cjs (asserting rows R2, R3a, R4c, R3c flip from FAIL to PASS).",
    "Step 2: Reconcile Terminal Creation Contract & Capsule Scoping (Fixes H3: R7). In src/main/terminal-daemon/daemon-client.ts, update createSession to support optional capsuleId and align return signature or handle sync session reservation. In TerminalManager (src/main/browser/terminal-manager.ts:1872), ensure createSession strictly tags the created SessionRecord with the passed capsuleId parameter without mutating or reading this.currentCapsuleId. Proving instrument: node scripts/run-electron.cjs scripts/probe-project-windows-matrix.cjs (row R7 flips from FAIL to PASS).",
    "Step 3: Fix Active Tab View Attachment in Split Review (Fixes R5a). In scripts/probe-project-windows-matrix.cjs:1605 (R5a), ensure betaHost activates betaAnchorTab before measuring native tab content bounds, or update NativeTabHost to ensure measured target tab views are queryable even when in the background. Proving instrument: node scripts/run-electron.cjs scripts/probe-project-windows-matrix.cjs (row R5a flips from FAIL to PASS).",
    "Step 4: Resolve Toolbar WebContentsView Sizing and Disposal Leak (Fixes H2: R12a, R12b, R6a). In src/main/browser/project-window-shell.ts:540, trigger toolbarView.webContents.send('window-resized', geometry.availableWidth) or dispatch renderer resize upon applyChromeBounds. In project-window-shell.ts:964, explicitly null out this.toolbarView = null! after detach and ensure webContents.destroy() finishes before audit deadline. Proving instrument: node scripts/run-electron.cjs scripts/probe-quit-coordination.cjs followed by probe-project-windows-matrix.cjs (rows R12a, R12b, R6a flip from FAIL to PASS).",
    "Step 5: Fix Input Focus Preservation Across Background Navigation (Fixes R10a, R10b). Ensure alphaPage retains input focus by calling el.focus() and awaiting visual stability before asserting value in R10a/R10b. Proving instrument: node scripts/run-electron.cjs scripts/probe-project-windows-matrix.cjs (rows R10a, R10b flip from FAIL to PASS).",
    "Step 6: Execute Full Phase 5 Acceptance Matrix & Post-Exit Orphan Verification. Run `node scripts/run-electron.cjs scripts/probe-project-windows-matrix.cjs` followed by `node scripts/probe-project-windows-matrix.cjs --verify-orphans`. Proving instrument: Receipt generated at plans/260927-0315-project-windows/reports/project-windows-matrix.json with 22/22 automated rows passing."
  ],
  "status": "DONE",
  "technique": "Meta-Pattern Recognition",
  "symptom_match": "The 10 failing matrix rows across 4 seemingly distinct domains (R2/R3a/R4c/R3c authority rejections, R5a null geometry, R7 terminal creation failure, R6a/R12a/R12b chrome lifecycle/sizing desync) all match the meta-pattern of a 'Dual-Track Authority Split': the presentation layer (capsules, shells, Electron WebContentsViews) creates or restores state that is never bound or synchronized into the control plane's authoritative in-memory registries (ProjectRegistry, WorkspaceRegistry, TerminalManager/Daemon).",
  "residual_unknowns": [
    "Exact reason for window A's close retention in R6a on the live run: whether it was haltedBy 'busy', 'unknown-outcome' due to PAGE_CLOSE_OUTCOME_DEADLINE_MS expiring on about:blank, or auditOwnContentsDisposed reporting toolbar#2 alive. Settle with: Inspecting reports/quit-coordination-run.txt or running `node scripts/run-electron.cjs scripts/probe-quit-coordination.cjs` and asserting report.haltedBy and report.refusals.",
    "Whether WebContentsView toolbar innerWidth in R12a/R12b requires explicit window.dispatchEvent(new Event('resize')) in toolbar.js or DPR zoom compensation. Settle with: Evaluating `alphaToolbar.executeJavaScript('window.innerWidth')` before and after dispatching a resize event in the toolbar webContents.",
    "Whether DaemonTerminalProxy contract should be normalized to synchronous ID reservation (matching TerminalManager) or matrix.cjs should await createSession. Settle with: Checking all callers of terminal.createSession across src/main/control-plane and src/main/browser."
  ]
}

[Some lines truncated to 768 chars]
```


---

## Candidate E

```json
{
  "unblock_path": [
    "Step 1: Unblock Authority Collision (Flips R2, R4c, R3a, R3c to PASS). Instrument: scripts/probe-project-windows-matrix.cjs --filter=R2,R3a,R3b,R3c,R4c. In src/main/index.ts ensureProjectWindow (lines 1170-1205), register newly opened project and workspace records into controlPlane.projects and controlPlane.workspaces so ProjectRegistry and WorkspaceCapsuleManager share the authoritative registry. Wire affiliationAuthority into WorkspaceCapsuleManager constructor (line 2120). Certifies criteria 2, 3, and 4.",
    "Step 2: Unblock Terminal Daemon Proxy Interface Mismatch (Flips R7 to PASS). Instrument: scripts/probe-project-windows-matrix.cjs --filter=R7. Update DaemonTerminalProxy.createSession (daemon-client.ts:388) to accept capsuleId, and ensure callers in scripts/probe-project-windows-matrix.cjs:2137 await the returned promise. Ensure TerminalManager session creation respects the explicit capsuleId parameter without mutating global currentCapsuleId. Certifies criterion 7.",
    "Step 3: Unblock Chrome Viewport Layout Synchronization (Flips R12a, R12b to PASS). Instrument: scripts/probe-project-windows-matrix.cjs --filter=R12a,R12b. In ProjectWindowShell.applyChromeBounds (project-window-shell.ts:538), force a WebContents layout pass or notify the toolbar webContents of the resized viewport rect via safeSendWebContents; in probe-project-windows-matrix.cjs:1903/2013, refresh toolbar reference via toolbarFor(alphaKey) before measuring. Certifies criterion 12.",
    "Step 4: Unblock Unload Veto & Clean Up plainTab Before R6a (Flips R6a, R8a, and enables R8b-R12 completion). Instrument: scripts/probe-quit-coordination.cjs, followed by scripts/probe-project-windows-matrix.cjs --filter=R6a,R8a. Explicitly close plainTab at the end of R12b. In ProjectCloseCoordinator.runClose (project-close-coordinator.ts:800-840), ensure webContents.close({ waitForBeforeUnload: true }) handles the veto settlement asynchronously without blocking on synchronous tab persistence or deadlocking the main event loop. Certifies criteria 6 and 8.",
    "Step 5: Execute Full Matrix & Merge Post-Exit Orphan Receipt (Flips R0, R8b, R8c, R9a, R9b, R9c, R9d, R9E, S1, S2, S3). Instrument: Phase 1: `node scripts/run-electron.cjs scripts/probe-project-windows-matrix.cjs`; Phase 2: `node scripts/probe-project-windows-matrix.cjs --verify-orphans`. Because run() now reaches completion, finally runs, writes plans/260927-0315-project-windows/reports/project-windows-matrix.json, arms the detached watcher, and phase 2 verifies no orphan processes survive. Hardware rows (R1-HW, R2-HW, R6-HW) legitimately remain declared BLOCKED. Certifies full Phase 5 acceptance criteria."
  ],
  "technique": "Collision-Zone Thinking",
  "application": "1. Upstream Authority Gap (H1 CONFIRMED):\n- In `src/main/index.ts:2120-2122`, `WorkspaceCapsuleManager` is instantiated without passing `affiliationAuthority`: `capsuleManager = new WorkspaceCapsuleManager({ filePath: capsuleStoragePath });`.\n- In `src/main/control-plane/control-plane-runtime.ts:162-169`, `workspaces.ensureInitialWorkspace` seeds only the boot workspace (ALPHA).\n- When secondary project windows (BETA through EPSILON) are created via `ensureProjectWindow` (`src/main/index.ts:1170-1205`), the shell and NativeTabHost are created, but neither `controlPlane.projects.registerProject` nor `controlPlane.workspaces.attach/register` is ever called.\n- When an agent attachment targets BETA (`probe-project-windows-matrix.cjs:1355`),…
  "h1_h2_h3": {
    "h3_terminal_manager_active_capsule": {
      "status": "CONFIRMED_WITH_ASYNC_PROXY_DEFECT",
      "upstream_file_lines": [
        "src/main/index.ts:1523-1528",
        "src/main/terminal-daemon/daemon-client.ts:388-391",
        "src/main/browser/terminal-manager.ts:637",
        "src/main/browser/terminal-manager.ts:981-1000",
        "scripts/probe-project-windows-matrix.cjs:2137"
      ],
      "subsystem": "TerminalManager / DaemonTerminalProxy"
    },
    "h2_leftover_toolbar_shared_cause": {
      "subsystem": "ProjectWindowShell / Layout & Lifecycle",
      "upstream_file_lines": [
        "src/main/browser/project-window-shell.ts:538-540",
        "src/main/browser/project-window-shell.ts:725-740",
        "src/main/browser/project-window-shell.ts:905-910",
        "scripts/probe-project-windows-matrix.cjs:856",
        "scripts/probe-project-windows-matrix.cjs:1903"
      ],
      "status": "FALSIFIED_AS_SHARED_CAUSE"
    },
    "h1_capsule_registry_decoupling": {
      "subsystem": "ControlPlane / WorkspaceRegistry",
      "status": "CONFIRMED",
      "upstream_file_lines": [
        "src/main/index.ts:2120-2122",
        "src/main/control-plane/control-plane-runtime.ts:162-169",
        "src/main/project/project-registry.ts:99-105",
        "src/main/tools/capability-catalogue.ts:358"
      ]
    }
  },
  "symptom_match": "Phase 1–4 implementation passes isolated historical probes (11:37Z and 09:47Z) but fails 10 of 22 rows in the current full-system Phase 5 matrix; the matrix run terminates abruptly at row R8a without writing a receipt or triggering the detached orphan watcher (R9E BLOCKED). The failures appear as an intractable tangle across project affiliation, window resizing, tab input, terminal sessions, and window closing.",
  "status": "DONE",
  "residual_unknowns": [
    "Exact deadlock condition in R8a during court.attemptClose with armed beforeunload: verify whether webContents.close({ waitForBeforeUnload: true }) or synchronous persistSync deadlocks the main thread when executed inside a headless/scripted harness. Settle via a standalone throwaway probe running only R8a with verbose lifecycle logging.",
    "Renderer viewport layout event timing in WebContentsView (R12a/b): verify whether calling webContentsView.webContents.invalidate() or explicitly dispatching a synthetic resize event to the toolbar WebContents updates window.innerWidth immediately. Settle via a read-only probe inspecting toolbar WebContents devtools/metrics after setBounds.",
    "Behavior of NativeTabHost.disposeChildViewContents() under detached daemon: verify whether surviving terminal sessions keep PTY descriptors open preventing process termination. Settle via inspecting osChildPids() before and after daemon.shutdownHost()."
  ]
}

[Some lines truncated to 768 chars]
```

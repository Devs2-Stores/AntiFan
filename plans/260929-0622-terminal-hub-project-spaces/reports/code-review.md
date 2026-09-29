# Code Review — Terminal Hub + Project Spaces

Reviewer: staff review, scoped to the plan file list. Evidence: git diff on all scoped modified files, full reads of space-manifest.ts / space-open.ts / sync-identity.ts, symbol-level grep of every new call seam, and live test/probe runs.

## Scope

- Files reviewed: src/main/project/workspace-capsule.ts, space-manifest.ts, space-open.ts, sync-identity.ts, src/main/browser/terminal-manager.ts, native-tab-host.ts, src/main/terminal-daemon/{protocol,daemon-client,daemon-entry,output-batcher}.ts, src/preload/standalone-preload.ts, src/renderer/standalone.{js,css}, src/shared/contracts.ts, 6 new/changed test files. Seam checks crossed into src/main/index.ts, tab-devtools-host.ts, element-picker.ts, ipc-router.ts, preview-url-codec.ts (read-only).
- LOC: ~1,460 added / ~170 removed across scoped files.
- Scoped verification run: npx tsx --test test/unit/space-manifest.test.ts test/unit/space-template.test.ts test/unit/sync-identity.test.ts test/main/space-open.test.ts → 47/47 pass; test/main/terminal-new-in-folder.test.ts test/renderer/terminal-hub-folder-groups.test.ts → 15/15 pass.
- Live repro: throwaway TSX probe against the real TerminalManager + stubbed node-pty proved finding F1 (below).

## Overall assessment

The security spine of the feature is well built: single-buffer read/hash/confirm (space-open.ts:105-115), field-level parse errors, containment by realpath, per-folder open lock, awaited daemon mints, ownership refusal for foreign folders, and honest result vocabulary are all in place and tested. The defects concentrate in the lifecycle half: a session respawn path that silently strips the watcher guard, and a sync-duplicate check that only covers one of the two role-assignment routes.

## Critical

None that block unconditionally, but F1 is a direct violation of the plan contract invariant.

## High

### F1 — restartWithProvenance drops role/idlePolicy/spaceTerminalId; a restarted watcher becomes sleepable

terminal-manager.ts:2235-2246 preserves name, capsuleId, ownerKey, category across a restart respawn — and nothing else:

    const prevName = targetSession?.name;
    const prevCategory = targetSession?.category;
    const prevCapsuleId = targetSession?.capsuleId;
    const prevOwnerKey = targetSession?.ownerKey;
    ...
    if (prevCategory) s.category = prevCategory;   // role/idlePolicy/spaceTerminalId absent

Repro (throwaway probe, real manager, fake PTY boundary — actually executed):

    before restart: {"role":"sync","idlePolicy":"never","space":"watch"}
    sleep before restart: {"ok":false,"reason":"SLEEP_REFUSED_WATCHER"}
    after restart: {"state":"running"}              // role meta gone
    sleep after restart: {"ok":true} state= sleeping // guard defeated

Impact: antifan:terminal:restart on a sync-marked or idlePolicy:"never" shell silently removes SLEEP_REFUSED_WATCHER — the invariant the plan contract names ("sleepSession refusal must hold through daemon and after restart"). The same respawn drops spaceTerminalId, so a subsequent space:open mints a duplicate of a declared terminal (space-open.ts:147-152 matches on it). Restore-from-disk paths DO call restoreRoleMeta (terminal-manager.ts:1299, 1490, 1547, 1870), so the fix is local: carry role, idlePolicy, spaceTerminalId beside prevCategory.

### F2 — Space-opened sync terminals bypass the duplicate-watcher check

Phase 6 requirement: "Before a role:sync terminal starts (phase-5 open, or hub row menu Danh dau la sync), if a live session with the same identity exists → SYNC_DUPLICATE…". Only the second half is implemented: findSyncDuplicate is consulted inside SET_ROLE (native-tab-host.ts:3446-3463). The manifest path (applyManifest, space-open.ts:139-163) mints role:"sync" shells with idlePolicy:"never" and never calls syncIdentity/findSyncDuplicate — and cannot return SYNC_DUPLICATE since SpaceOpenResult reason union (contracts.ts) has no such member. Two folders bound to haravan:org:theme each with a sync terminal in their space.json open two uploaders over the same theme with no warning — the exact failure the feature exists to warn about.

## Medium

### F3 — .antifan/ gitignore warning (Phase 5 acceptance) is unimplemented

Phase 5: "Warn once if .antifan/ is not gitignored and the folder is a git repo (URLs may be private)." No code path checks .gitignore or .git anywhere in the diff (grep gitignore src/ → no match; SPACE_INIT at native-tab-host.ts:4193 writes and returns without it). Either implement or explicitly cut; the phase file records it as an acceptance item.

### F4 — Annotation picker folder optgroup degrades on the devtools inspect path

element-picker.ts:18-22 groups sessions by folderKey. native-tab-host.ts:7428 feeds it selectAnnotationTargets(this.visibleTerminalSessions()) — stamped rows, groups work. tab-devtools-host.ts:507 (startInspect, the live inspect path) feeds selectAnnotationTargets(tm.listSessions()) — raw summaries, never run through stampFolderProjection (native-tab-host.ts:6491), so no folderKey and the menu falls back to a flat list. Fix by routing the devtools call through the host stamped projection (visibleTerminalSessions), which also restores owner-scoped visibility that tm.listSessions() ignores.

### F5 — Sleeping declared terminals are "reused" but never woken or commanded

applyManifest counts state === "sleeping" as live reuse (space-open.ts:149) — it continues without waking the shell or typing spec.command. For a shell/agent spec carrying a command, the Space silently leaves the declared work not running and reports success. Either wake-then-type, or re-mint, or surface the state distinctly; current behavior makes terminalsReused claim more than it delivered.

### F6 — hasTab path match is a suffix check, not containment

native-tab-host.ts:4153: decodeURIComponent(url).endsWith("/" + spec.path). Two defects:
- Suffix equality means path:"b/x.md" dedupes against an open antifan-preview://cap/a/b/x.md — a tab for a file the Space does not declare counts as already-open.
- The check ignores the URL capsule host, so a preview tab for b/x.md in a different capsule of the same window also dedupes.

Fix: compare against parsePreviewUrl(url) (already imported at native-tab-host.ts:51) with capsuleId + decoded path equality, wrapped for URIError.

### F7 — relativeTabPath does not reject Win32 device names / ADS

space-manifest.ts:79-96 blocks absolute/UNC/../drive-letter spellings, but path:"NUL", "CON", "COM1", or "file.txt:stream" pass spelling checks, resolve inside the folder via resolveSpaceTabPath (missing leaf → ancestor containment), and hand createPreviewTab a device or alternate-stream path. NUL is mostly harmless; CON can block a reader. Cheap fix: reject ":" in any segment and ^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$ on the final basename.

## Low

### F8 — Space button hidden by the mint button visibility guard

standalone.js in ensureCategoryHeader queries header.querySelector(".terminal-tab-category-mint"); both the + mint button and the Space button carry that class. The visibility line (mintBtn.style.display = group.folderPath ? "" : "none") hits whichever is found first. Harmless today (mint is appended first, so Space is never mis-hidden) but brittle — give Space its own class or query by attribute.

### F9 — Daemon-mode typeCommand failures are invisible

space-open.ts:160 awaits deps.typeCommand, but in daemon mode it resolves to DaemonTerminalProxy.writeTo, which maps RPC failure to false (daemon-client.ts:418-419). await deps.typeCommand(...) therefore resolves false and applyManifest proceeds — the manifest command is dropped and the open still reports terminalsOpened. Check the result and count (or throw) on false.

### F10 — createConfirmationStore trusts its own file shape

space-open.ts:56-60 casts parsed JSON to Record<string, string[]> without validating values; isConfirmed then calls .includes on whatever parsed[key] is. A hand-edited space-confirmed.json with a non-array value throws inside isConfirmed, failing the whole openSpace as CREATE_FAILED-class noise. Trivial Array.isArray guard; the file is data-root user-writable.

### F11 — Contract shape: sleep refusal reasons leak past TerminalSleepResult

The SLEEP_SESSION route returns {ok:false, reason:"INVALID_PAYLOAD"|"NOT_PERMITTED"} (native-tab-host.ts:3351, 3361) — reasons outside the TerminalSleepResult union (contracts.ts: "SLEEP_REFUSED_WATCHER" | "NOT_RUNNING"). Callers only special-case SLEEP_REFUSED_WATCHER, so behavior is fine, but the IPC envelope and the declared type now disagree. Either widen the IPC-facing result type or document that the route envelope is a superset.

### F12 — output-batcher.ts adaptive-window removal is scope drift

The adaptive gap*1.5 coalescing window and the exported DAEMON_OUTPUT_FLUSH_MS_CAP were deleted (output-batcher.ts diff; no remaining references). The plan flags the sibling plan batcher bug as THEIR failing suite — this file is in this plan scope list only for "role/idlePolicy propagation", which the batcher change is not. Not a defect (no references break), but it ships an unreviewed-in-this-plan behavior change; confirm intent and that the sibling plan adaptive-window tests were retired, not weakened silently.

### F13 — folderFactsCache / folderHeaderSessionIds grow unbounded

folderFactsCache (native-tab-host.ts:1138) keys every cwd spelling ever seen and never evicts; folderHeaderSessionIds (renderer) never prunes a folder key whose group vanished. openLocks (space-open.ts:46) is cleaned on settle — fine unless a mint hangs forever. Practically small; note only.

## Positive observations (risk calibration only)

- TOCTOU on the manifest is genuinely closed: one buffer is read, validated, hashed and executed (space-open.ts:103-107); CONFIRM_MISMATCH precedes reuse; recordConfirmed keeps only the latest hash per folder so an older approved file re-prompts (space-open.ts:62-68).
- Containment is two-layered correctly: spelling-level refusal in relativeTabPath + realpath/junction containment in resolveSpaceTabPath, including the missing-leaf-via-ancestor case; the junction test on win32 passes (space-manifest.test.ts).
- hasWatcherGuard covers pane→base and base→pane directions (terminal-manager.ts:2482-2492), and pane restore deliberately skips role meta so a pane cannot smuggle a stale never that outlives its parent marking.
- Sender trust is real: surface is resolved from the sender webContents against loadsExpectedPage (ipc-router.ts:164-168, project-window-shell.ts:594-597), not from a self-declared flag, and project windows cannot mint or open foreign folders (native-tab-host.ts:4056-4069).
- Daemon seam discipline holds: createSession is awaited at both mint call sites (native-tab-host.ts:4079-4086, :4176-4184), meta propagates through HostNewSessionParams → daemon-entry → in-process manager, and sleepSession refusal survives the round-trip (proved by terminal-daemon-provenance.test.ts:360-365).
- The minted-name badge is correctly read-only: displayLabel is stamped projection-side only, and inline rename seeds from session.name, not the badge.

## Recommended actions (priority order)

1. F1 — carry role/idlePolicy/spaceTerminalId in restartWithProvenance; add a regression test asserting sleepSession still refuses after restart().
2. F2 — run findSyncDuplicate in applyManifest for role:"sync" specs; add SYNC_DUPLICATE (+ optional acknowledgeDuplicate on the request) to SpaceOpenResult.
3. F3 — implement the .antifan/ gitignore warn-once or drop it from phase-5 acceptance explicitly.
4. F4 — feed tab-devtools-host.startInspect the stamped session list.
5. F5/F6/F9 — correctness fixes for sleeping-terminal reuse, preview-tab dedup, and daemon typeCommand result handling.
6. F7/F8/F10/F11 — hardening cleanups.
7. F12 — reconcile the batcher change with the sibling plan before phase-7 verification runs their suites.

## Status: DONE_WITH_CONCERNS

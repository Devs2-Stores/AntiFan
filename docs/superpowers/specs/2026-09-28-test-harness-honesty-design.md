# Test-harness honesty — design

Status: landed in the tree on 2026-09-28 except the items named open below.
Written after a coverage audit of
`plans/reports/260928-0658-pending-changes-stage2-review.md` (34 findings) and the four 2026-09-27/28
reports against `docs/superpowers/specs/*.md`: every finding still reproduces in the live tree and
**none of them was owned by any spec**. This spec is that owner.

Evidence state: 31 of the 34 findings were re-read at the cited lines during the session that wrote this
file (including the lane sets, every probe site, and every path below, which were checked to exist). The
three marked *audit-carried* — M14, H1b, T2 — are quoted from the audit and must be re-confirmed at the
cited line before their fix lands; nothing else in this table is second-hand.

Sibling designs (S1 edit-mode guard, S2 capture/focus ownership, S3 Manager bridge health, S4 Manager
run cards) each end with "this is how you verify it". This one is about the layer underneath them: what
a green row, a skip, and a BLOCKED entry are allowed to mean.

Date: 2026-09-28

## 1. The problem this owns

Every claim in the four sibling specs terminates in a test row, a probe check, or a gate. Three failure
modes make those terminals lie while staying green:

- **An observation nobody asserts.** A row computes `crossSent`, `survivorCheckRan`, `descendantCheckSupported`
  or `userAgentMode` and writes it into the receipt; no assertion consumes it, so "the refusal happened"
  and "the send never ran" are the same green.
- **A check that cannot fail.** A regex asserted against itself, a source-text `includes`, a local
  re-implementation of the dispatch it claims to cover, a fixture whose transport differs from production
  (`ipcRenderer.invoke` vs `send`), a count assertion weakened to `>= 1` / `<= 1` — each passes on dead
  code, comments, formatting drift, or pure absence.
- **Absence read as success.** A skipped contract suite gated by an env var no lane sets, a self-skip when
  a fixture is missing, a `catch { return []; }` that turns "journal unreadable" into "no events", a
  timeout that leaves an abandoned judge writing evidence, a BLOCKED bucket that mixes hardware deferral
  with environment defects — all of which a receipt or a reader then reads as coverage.

The invariants below are the design. §3 is the disposition of every finding.

## 2. Invariants

**H1 — Every recorded observation is consumed.** A row that records a value used to justify its verdict
must assert on it (or assert that it *was* obtained, and go BLOCKED when it was not). A value that exists
only for a human reading the receipt must be labeled in the row as `note`, not `observed`.
Corollary: a negative assertion ("X never arrived") must be preceded by a positive one ("the probe that
would deliver X ran").

**H2 — Prove the shipped artifact.** A check exercises production code — an imported handler, the real
route table, the real preload, the emitted bundle — never a local re-implementation of it, never a
substring of its source, never a fixture with a different transport than production. Source-text checks
survive only as *absence* pins (a symbol that must not return) and must be visibly labeled as such.

**H3 — Fail closed on absence.** A missing fixture, unreadable file, unanswered query, or unsupported
platform yields `BLOCKED` (or a named failure), never a silent skip, an empty array, or a weakened count.
A skip is legitimate only when it names the missing prerequisite, and its count is reported as *untested*,
never as *tested*.

**H4 — Bounded work is cancelled.** A row that hits its timeout cancels the work it started, and nothing
that work mutates afterwards may enter the receipt. Deep-copy the row's evidence at freeze time, and stop
the run rather than drive later rows through an abandoned judge (the matrix probe already does this; the
e2e lane does not).

**H5 — Verdicts are classified, and cleanups are evidence.** Every BLOCKED carries a bucket
(`hardware` | `environment` | `cascade` | `test-bug`); a receipt that reports "0 FAIL / N BLOCKED" also
reports the buckets. A row's teardown failure is a check in the row, not a `console.log` note.

**H6 — The gate covers the surface it claims.** A green `npm test` / `npm run verify` means the tree
type-checks and every lane it names actually ran. `typecheck` **landed** (see §3 C1). CI remains open (C2).

## 3. Disposition of every covered finding

| # | Where | What it does today | Disposition |
| --- | --- | --- | --- |
| C1 | `scripts/run-test-pipeline.mjs` | `typecheck` script exists; no lane ran it, and naming it threw `Unknown lane` | **Landed**: `'typecheck'` added to `STATIC_LANES` (so it is in `TEST_LANES`, `KNOWN_LANES`, `NON_COMPILE_LANES`); lane run 6.8 s, 3/3 static lanes passed |
| C2 | repo root | No CI of any kind (`.github/` absent); every lane and receipt is hand-run | **Decide explicitly**: add a CI workflow running `npm run verify`, or state in `docs/operations.md` that the gate is local-only and stop citing receipts as CI-gated |
| I1 | `scripts/probe-project-windows-matrix.cjs:1905-1928,1964` | `crossSent` recorded; only `neverSawMarker(crossReachedB)` asserted | Assert `crossSent.sent === true` before the negative expectation (H1) |
| I2 | `scripts/probe-project-windows-matrix.cjs:3040-3043` | Popout-open failure writes `auxiliaryNote` and the row still judges PASS | Set `row.status = 'BLOCKED'` with an `environment` bucket and stop the row (H1/H5) |
| I3 | `scripts/probe-project-windows-matrix.cjs:3886-3903,3934` | `survivorCheckRan = hostGone`; null `alive()` answers become "no survivors"; `descendantCheckSupported: true` hardcoded | Record `descendantQueryFailed`, propagate null, require it absent in `observationAvailable`, and emit BLOCKED on failure (H1/H3) |
| I4 | `test/e2e/project-windows.test.ts:334-345` | `Promise.race(fn(), rowTimeout)` — the row keeps running after its timeout | Fail-stop after a timed-out row (mark the rest BLOCKED) or cancel the row's work; the matrix probe's pattern is the reference (H4) |
| I5 | `test/e2e/project-windows.test.ts:353-358`; `test/e2e/terminal-capsule-assign.test.ts:334-337` | Row cleanup failures `console.log('NOTE …')`, never in the row | Push cleanup results into the row's checks (`name + ' [cleanup]'`) or a `cleanupErrors` field (H5) |
| I6 | `test/unit/browser/terminal-transcript-lifecycle.test.ts:114-123` | Defines `isAltScreenEnter/Exit` locally and asserts only on them | Delete the block (real coverage exists in `terminal-alt-screen-scan.test.ts`) or import the shipped recognizer (H2) |
| I7 | `test/main/terminal-daemon-provenance.test.ts:294-312` | Re-implements daemon-entry dispatch inline; production `daemon-entry.ts:284-289` never runs | Drive `HOST_METHOD.newSession` over the existing WS harness (or import the handler table) and assert `getSession(id).capsuleId` from the real path (H2) |
| I8 | `test/main/ipc-audit.test.ts:52,66,84,97-100,120-125,148-155,198-251,419-431,555-583` | Handler existence, script tags, listener counts and affinity are asserted by raw source `includes` / `assert.match`; counts weakened to `>= 1` and `<= 1` | Replace with route-level behaviour through `test/support/chrome-route-harness.ts`; keep only labeled absence pins; assert `=== 1` where uniqueness is the claim (H2/H3) |
| I10 | `test/main/dispatch-socket-teardown.test.ts:412` | A RED contract is unconditionally skipped; its pointer (`antifan-core/dispatch-ws-crash.md`) does not exist | Land the socket-scoped rejection in `scripts/antifan-omp-mcp.cjs` and un-skip in the same change; meanwhile replace the dead pointer with a repo-local reference (H3) |
| I11 | `test/main/bridge-pairing-queue-concurrency.test.ts:234-239` | Contract suite gated behind `ANTIFAN_PAIRING_CONTRACT=1`, which no lane sets; referenced doc absent | Apply the bridge-side refill patch and delete the gate, or add a real opt-in lane plus a live doc pointer (H3) |
| I12 | `test/unit/build-report-{bundle-ordering,embedded-drift,next-action}.test.mjs`, `test/unit/core-health-service.test.ts:435-438` | Four tests self-skip when the canary fixture / super-core source is absent (the skips do name the reason) | Commit a minimal replay fixture so the assertions always run; keep the named skip as the fallback (H3) |
| I13 | `scripts/run-test-pipeline.mjs:47-57`; `scripts/probe-rpc-surface-coverage.cjs:160-215`; `package.json` | `test:probes` (daemon RPC/persistence) is in `KNOWN_LANES` but not `TEST_LANES`; the pipeline comments the reason ("stages a daemon bundle and spawns detached hosts, which is heavier than every other lane", 20 min budget). The probe itself is not a cheap check: Pass 2 stages the host (`stage-daemon-host.mjs`), calls `ensureDaemon`, starts a terminal and waits for readiness (20 s), and it is the only pass that proves a proxy method is actually dispatched | Three options, in order of preference: **(a)** extract the *static* Pass 1 (GUI `tm.*` call sites vs proxy methods) into a default-lane check, explicitly documented as covering only the missing-method class — it does **not** replace live dispatch coverage; **(b)** add `test:probes` to `TEST_LANES` and accept the cost; **(c)** leave the lane opt-in and require every receipt that cites it to name it as a manual, opt-in run. Under (a) or (b), a daemon-path regression stops depending on a human remembering a lane (H6) |
| H1b *(audit-carried)* | `src/main/terminal/terminal-manager.ts:2415` | `session.bufferBytes ?? Buffer.byteLength(session.buffer, 'utf8')` throws on a row with neither field, killing every window's projection | Guard the stats read (`?? 0` / `\|\| ''`) and add a malformed-row case to the stats lane (H3, product-side) |
| T2 *(audit-carried)* | `docs/superpowers/specs/2026-09-27-project-windows-design.md` | The orphan-close deadlock (`browser-control-port.ts:3791-3794` + `isTabAllowedForPrimary`) is named as a defect by the 09-27 tab-management report, while the spec retains the refusal and forbids eviction | **Decide explicitly**: implement a bounded capsule-scoped reclaim for dead sessions, or record orphaned visible tabs as a retained limitation in that spec (H3, product-side) |
| M1 | `test/main/ipc-audit.test.ts:97-100` | "dead or duplicate script tags" asserts `length >= 1` | Assert `src` uniqueness + target-file existence, or rename the test to what it checks (H2/H3) |
| M2 | `test/main/ipc-audit.test.ts:148-155` | Duplicate-listener audit asserts `<= 1`, so a removed button passes | Assert `=== 1` or drive the real DOM (H3) |
| M3 | `test/main/ipc-audit.test.ts:52,66,84` | Handler existence via `content.includes('channel: …')` — comments and formatting decide the verdict | Folded into I8 (H2) |
| M4 | `test/unit/browser/render-surface-and-viewport-gates.test.ts:1` | Entire file is `import '../../main/render-surface-and-viewport-gates.test';` — the same 535-line suite runs twice per pipeline | Delete the shim (keeping the `main/` original) (dead weight) |
| M5 | `test/main/chrome-ipc-routes.test.ts:116,122` | `if (!fs.existsSync(fullPath)) continue;` + raw `includes(id)` — a deleted renderer shrinks the audited surface silently | Assert existence and anchor matching to real call sites (H2/H3) |
| M6 | `test/main/native-popup-inheritance.test.ts:172,199,214` | All three cases pass `disposition: 'new-window'`, and none disposes the host — so the `if (this.isDisposed) return;` guard in the deferred creation (`src/main/browser/native-tab-host.ts:6593`) never runs (the cases cover only the dead-opener and refused-adoption paths) | Add a second disposition row and a disposed-host opener (H2) |
| M7 | `scripts/probe-project-windows-matrix.cjs:736` | Budget-expired "freeze" is one level deep; nested `observed`/`ids` objects stay live | `structuredClone` the row at freeze (H4) |
| M8 | `scripts/probe-project-windows-matrix.cjs:1833,1884,1901,1910` | Negative marker windows use a fixed 1.5 s instead of the measured positive delivery time (default is 8 s) | Anchor the negative window to the observed positive latency, or use the full default (H1/H3) |
| M9 | `scripts/probe-quit-coordination.cjs:338-347` | `catch (err) { return []; }` turns an unreadable lifecycle log into "no events", which the negative assertions (`willQuitSeen`) then read as "the event never happened" | Return `null` on read failure and require non-null at call sites, or record `journalReadError` (H3) |
| M10 | `scripts/probe-two-shell-ipc.cjs:40-43,180` | Route-dependent rows are dropped with `SKIP` and no `checks` entry; `check()` never awaits `fn()` | Emit skipped rows into `checks` (or fail) and `await fn()` (H3/H4) |
| M11 | `scripts/probe-daemon-reattach.cjs:161-163,260-262` | Any `connect()` failure counts as "invalid token rejected" — timeouts and ECONNREFUSED also pass | Assert the specific auth/handshake rejection class; fail on transport errors (H1/H2) |
| M12 | `test/e2e/project-windows.test.ts:902-905` | `userAgentMode` compared parent-vs-child only, so `undefined === undefined` passes (the sibling `partition` assertion is pinned) | Pin the expected mode (or require a non-empty string) before the comparison (H1) |
| M13 | `test/e2e/e2e-combined-preload.js:12` | Models `sendTerminalInputTo` with `ipcRenderer.invoke` while production uses `ipcRenderer.send` on a `kind:'on'` route — and the same fixture models the whole API this way, so every `kind:'on'` route it touches is fictional | Change the fixture to `send`, and audit the fixture once for the `kind:'on'` class instead of patching line 12 alone (H2) |
| M14 *(audit-carried)* | `test/e2e/project-windows.test.ts` receipt; `scripts/probe-project-windows-matrix.cjs:2646,2773,3672,3745` | BLOCKED rows for missing bundles/staged daemon/cascades sit beside hardware-deferred rows | Bucket BLOCKED reasons in the receipt summary (H5) |
| M15 | `test/unit/canary/canary-evidence-provenance.test.mjs:369-370` | Skips on PID reuse | Optional: pick a guaranteed-dead PID range instead of skipping (H3) |
| M16 | `test/main/windows-acl-timeout-guard.test.ts:27+` (`test/main/` lane) and siblings | Windows-only/junction/ACL skips never run elsewhere | No code change; ensure receipts do not read skip counts as coverage (M14 covers the reporting) |
| M17 | `CHANGELOG.md:39` | Claims `(1 skip có sẵn)` for `test:main` while the lane holds two default-skip sites | Re-run the lane and update the count, or annotate the line as point-in-time (H5) |
| M18 | `scripts/probe-project-windows-matrix.cjs`, `probe-background-full-page.cjs`, `probe-headless-full-page.cjs` | Probes cited as acceptance evidence are hand-run, lane-less files | Either commit + wire a lane (see I13) or delete the orphans (H6) |
| M19 | `test/e2e/test-preload.js` | Dead file, referenced by nothing | Delete (dead weight) |

## 4. Sequencing

- **W1 — Test-side honesty (cheap, high value).** I1, I3, I5, I6, I8, M1, M2, M4, M5, M6, M12, M13,
  M17, M19. Test-only edits; nothing here changes product behaviour.
- **W2 — Runner rigor.** I2, I4, M7, M8, M9, M10, M11, M14: probes and the e2e row loop learn to
  cancel, freeze deeply, classify, and fail closed.
- **W3 — Gates.** I10 (land + unskip), I11 (fix or lane), I12 (fixture), I13/M18 (probe lane), C2
  (CI or documented local-only).
- **W4 — Product-side, needs an owner decision.** H1b (stats-read guard) and T2 (orphan-close
  limitation). Both are real defects outside the harness; they are listed here because no other spec
  owns them, and both are one small change plus one spec sentence — the decision is which.

## 5. Files touched

| Work | File |
| --- | --- |
| Static gates | `scripts/run-test-pipeline.mjs` (C1 landed; I13/C2 still open) |
| Probe rigor | `scripts/probe-project-windows-matrix.cjs`, `probe-quit-coordination.cjs`, `probe-two-shell-ipc.cjs`, `probe-daemon-reattach.cjs` |
| e2e lane | `test/e2e/project-windows.test.ts`, `test/e2e/terminal-capsule-assign.test.ts`, `test/e2e/e2e-combined-preload.js`, delete `test/e2e/test-preload.js` |
| Source-pinned tests | `test/main/ipc-audit.test.ts`, `test/main/chrome-ipc-routes.test.ts`, `test/main/native-popup-inheritance.test.ts`, `test/main/terminal-daemon-provenance.test.ts`, `test/main/dispatch-socket-teardown.test.ts`, `test/main/bridge-pairing-queue-concurrency.test.ts` |
| Unit lanes | `test/unit/browser/terminal-transcript-lifecycle.test.ts`, `test/unit/build-report-{bundle-ordering,embedded-drift,next-action}.test.mjs`, `test/unit/core-health-service.test.ts`, delete `test/unit/browser/render-surface-and-viewport-gates.test.ts` |
| Product-side (W4) | `src/main/terminal/terminal-manager.ts` (H1b), `docs/superpowers/specs/2026-09-27-project-windows-design.md` (T2) |
| Docs | `CHANGELOG.md`, `docs/operations.md` (C2 statement, if that option is chosen) |

## 6. Verification protocol (this spec applies H1–H5 to itself)

Each W1/W2 item ships with a **mutation control**: reintroduce the defect in a copy (or in memory) and
show the check goes red, then show it green on the real tree. The evidence that already exists in this
session is the pattern:

- The bridge-info secret scan (S3's dependency) was proven three ways: real source ⇒ no finding; an
  injected `pairingCode` field ⇒ `persisted-secret-in-bridge-info`; a renamed method ⇒
  `bridge-info-scan-unavailable` (the fail-closed replacement for a scan that matched nothing).
- The edit-guard run counter (S1) was proven by two cases: a log holding runs 2/3 plus a torn line ⇒
  the next run is 4; no log ⇒ the first run is 1.

No item in §3 may be closed with "it passes now" alone: passing is the *second* observation, the
mutation control is the first.

## 7. Acceptance criteria

1. `node scripts/run-test-pipeline.mjs typecheck` runs the type-check lane; a type error in a file no
   lane compiles turns the pipeline red. **(landed)**
2. No probe row reports PASS while one of its recorded observations was never asserted: for each of
   `crossSent`, `survivorCheckRan`, `descendantCheckSupported`, `userAgentMode`, the corresponding
   assertion exists and fails when the value is flipped.
3. No test asserts against its own local re-implementation: the alt-screen block is gone or imports the
   shipped recognizer, and the daemon-provenance test drives production dispatch.
4. A timed-out e2e row cancels its work: after the timeout, no late mutation appears in the receipt, and
   every row behind it is recorded BLOCKED (never PASS).
5. Every BLOCKED entry in a final receipt carries a bucket, and the summary prints the buckets.
6. `npm test` runs `typecheck`, every lane it names, and the probe lane or its documented replacement —
   and no lane's greenness depends on a contract being unreachable.
7. Daemon-path coverage does not depend on a human remembering a lane. Under option (a) of I13 the
   static surface check runs by default and the live dispatch pass stays an explicitly named opt-in; under
   (b) the whole lane runs by default; under (c) every receipt that cites the probe names it as a manual,
   opt-in run. The static pass is never presented as covering the live dispatch class.
8. The dead weight is gone: the duplicated renderer-surface suite and `test-preload.js` no longer run;
   the pipeline's suite count drops by exactly the duplicates removed.

## 8. Non-goals

- No new product behaviour beyond W4's two explicitly-scoped items.
- No rewrite of the probe framework, and no new test framework: every fix lands in the existing lane,
  probe or runner that owns the claim.
- No CI requirement smuggled in: C2 is a decision (build it, or document local-only), not an assumption.

## 9. Risks and rollback

- **Fixing a check can turn a lane red for a real defect it was hiding.** That is the point; each red is
  triaged as `test-bug` or `product-defect` and recorded in the buckets (H5), never silenced by
  re-weakening the assertion.
- **Deleting allegedly redundant coverage (I6, M4, M19) can remove the only real check.** Each deletion
  requires naming the surviving check that covers the same claim; where none exists, the item is converted
  to a fix instead.
- **Source-pin removal (I8/M3/M5) loses cheap drift detection.** The replacements assert through the route
  table; the labeled absence pins (a symbol that must not return) stay.
- Rollback for any item is the single file it touched; none of them is coupled to a migration or to
  machine state.

---
phase: 5
title: "Windows Freeze Certification"
status: complete
priority: P1
effort: "1-2d implementation + 3x45m runtime"
dependencies: [1, 2, 3, 4]
---

# Phase 5: Windows Freeze Certification

## Context Links

- [Plan](./plan.md)
- Existing runner: `scripts/smoke-real-soak.cjs`
- Prior evidence: `plans/260904-0036-antifan-core-verification-and-primitives/reports/`
- Live proof input: `plans/260905-0012-core-pre-freeze-hardening-and-live-proof/reports/live-theme-proof.json`

## Overview

Extend the existing real Windows-local soak into a repeatable freeze gate. The current runner exercises real Electron tabs, PTY streaming, split review, reload, DOM extraction, total working-set growth, and orphan PTYs, but it does not classify process memory, expose Core resource owners, execute stale-context/false-verification canaries, or require repeat runs. Existing quick PASS and historical 5-hour evidence remain baseline context, not release certification.

## Requirements

- Functional:
  - Keep quick smoke mode for implementation feedback; certification mode is exactly 45 minutes per fresh process.
  - Sample total and per-process-class working set/CPU (`Browser`, `Tab`, `GPU`, `Utility`, other), main-process heap, process count, tab count, terminal session/PTy count, attached CDP/network targets, watcher count, artifact count/bytes, receipt count/bytes, and invocation-ledger partition bytes/frames.
  - Reuse existing owner accessors where available (`TerminalManager.listSessions`, `PreviewWatcherPool.getActiveWatcherCount`, Electron `app.getAppMetrics`). Add read-only `getStats()` methods to existing owners only where no bounded accessor exists.
  - Exercise Phase 4 Product Card and Drawer paths periodically without embedding a second runner: import/call a bounded workload function or dispatch the same public capability sequence.
  - Inject stale document/mutation/authority attempts and known false claims during every run; acceptance count must remain zero.
  - Record raw time series, workload counters, lifecycle counts, thresholds, environment fingerprint, teardown result, and verdict to the active plan reports directory.
  - Run three certification executions from clean process starts. All three must pass; no majority vote and no threshold edits between runs.
  - Aggregate the three reports into one freeze manifest with checksums. Any missing/invalid run yields `BLOCKED`, not `PASSED`.
- Non-functional:
  - Sampling must remain lightweight: one bounded sample at existing 500 ms or a slower interval for disk counts; no unbounded arrays or command polling.
  - Do not publish machine secrets, command lines, local source content, or attachment credentials in reports.

## Architecture

```text
frozen threshold manifest
  -> fresh Electron process (45m)
       -> real 4-tab + PTY + split + QA/theme workload
       -> resource-owner snapshots + OS process metrics
       -> stale/false-verification canaries
       -> teardown and post-exit ownership checks
       -> immutable run-N.json
  -> repeat x3
  -> aggregate checksums + all-pass rule
  -> freeze-certificate.json
```

Ratified hard gates:

| Metric | Gate |
|---|---:|
| Settled total RSS growth | `≤ 30 MB` |
| Overall total RSS slope | `≤ 0.35 MB/min` |
| Renderer/Tab-class slope | `≤ 0.15 MB/min` |
| Owned orphan process/PTy count | `0` |
| Active tabs/terminal sessions/CDP attachments/watchers after teardown | `0` |
| Stale-context calls accepted | `0` |
| Injected false claims reaching `VERIFIED` | `0` |
| Unhandled errors / incomplete stages | `0` |

New artifact/ledger/receipt growth gates are derived before run 1 from the deterministic workload count: bounded bytes per operation plus constant overhead, written to `freeze-thresholds.json`, then immutable across all three runs. Ledger persistence keeps its separate 64 MiB hard frame ceiling for corruption/DoS containment, while certification permits at most 1 MiB per expected frame because large browser payloads are staged as bounded artifacts rather than persisted inline. A threshold without an implementation-derived bound blocks certification rather than being guessed from one run.

## File Inventory

| Action | File | Rough Change | Test Impact |
|---|---|---:|---|
| Modify | `scripts/smoke-real-soak.cjs` | Resource snapshots, canaries, strict 45m mode, active plan output | Real soak |
| Create | `scripts/certify-core-freeze.cjs` | Sequential 3-run orchestration and aggregate manifest | Certification command |
| Modify | `package.json` | Add quick and certification commands without replacing existing smoke | Command surface |
| Modify | `src/main/tools/artifact-store.ts` | Read-only bounded stats accessor | Unit/resource tests |
| Modify | `src/main/session/invocation-ledger.ts` | Read-only bounded stats accessor | Ledger tests |
| Modify | `src/main/session/receipt-store.ts` | Read-only bounded stats accessor | Receipt tests |
| Modify | `src/main/browser/tab-devtools-host.ts` and/or `first-party-network-tracker.ts` | Attached-target count accessor where owner exists | Browser owner tests |
| Modify | `src/main/browser/native-tab-host.ts` | Aggregate existing owner stats only; no lifecycle rewrite | Soak + owner tests |
| Create | `test/unit/freeze-metrics.test.ts` | Slope, threshold, aggregation, schema, tamper cases | Fast certification logic |
| Create | `plans/260905-0012-core-pre-freeze-hardening-and-live-proof/reports/freeze-thresholds.json` | Frozen generated policy input | Certification audit |
| Create | `plans/260905-0012-core-pre-freeze-hardening-and-live-proof/reports/windows-soak-run-{1,2,3}.json` | Runtime-generated raw summaries | Freeze evidence |
| Create | `plans/260905-0012-core-pre-freeze-hardening-and-live-proof/reports/freeze-certificate.json` | Runtime-generated aggregate verdict/checksums | Final gate |

Reports are generated by commands, not hand-authored as proof.

## Function and Interface Checklist

- [x] Existing resource owners expose bounded immutable stats; no test reaches private maps.
- [x] Process-class sampler uses Electron metric `type` and preserves raw sample counts.
- [x] Slope calculation rejects insufficient samples/zero time variance instead of returning a certifying zero.
- [x] Certification runner enforces `--duration 45`, fresh child processes, sequential execution, timeout, and non-zero failure propagation.
- [x] Threshold manifest is written before run 1 and checksum-verified before runs 2/3.
- [x] Each report records code/build identity, platform/arch, sample interval/count, all phase workload counts, canary outcomes, and teardown state.
- [x] Aggregate certificate verifies three distinct process starts and report checksums.

## Dependency Map

```text
Phase 4 live workload + Phases 1-3 contracts
  -> instrumented quick smoke
  -> frozen thresholds
  -> 45m run 1 -> 45m run 2 -> 45m run 3
  -> all-pass aggregate
  -> Core freeze / unblock prior certification plan
```

## Implementation Steps

1. Extract pure metric math/schema/aggregation functions from the runner into a small existing-adjacent module only if needed by tests; do not create a telemetry service.
2. Add `getStats()` to ArtifactStore, InvocationLedger, ReceiptStore, and the existing CDP/network owner; aggregate them through `ControlPlaneRuntime`/`NativeTabHost` for the runner.
3. Update memory sampling to preserve total plus process-class series and main heap. Treat missing process type as `other`, never renderer.
4. Extend workload stages with public capability observations, source/CSS/responsive checks, bounded file mutation/reload, verification attempts, stale identity injection, and false-claim injection.
5. Capture baseline, periodic, settled, pre-teardown, and post-teardown snapshots; stop sampling only after final resource state is recorded.
6. Generate the deterministic threshold manifest from configured workload counts and ratified SLO constants before certification begins.
7. Implement the sequential orchestrator: compile once, spawn each 45-minute Electron run, wait for exit, validate schema/checksum, then continue; abort on first failure.
8. Aggregate only three clean reports with the same build/threshold checksum. Persist `freeze-certificate.json` with `PASSED` or fail closed without a certificate.
9. Update the predecessor plan's outstanding soak criterion only after the aggregate certificate passes.

## Test Scenario Matrix

| Priority | Scenario | Expected |
|---|---|---|
| Critical | Insufficient/flat-timestamp samples | Cannot certify slope |
| Critical | One of three runs fails or missing | Aggregate fails/blocked |
| Critical | Threshold manifest changes after run 1 | Checksum mismatch; abort |
| Critical | Stale target accepted once | Run fails |
| Critical | False claim verified once | Run fails |
| Critical | PTY/process/tab/CDP/watcher survives teardown | Run fails |
| High | Renderer slope 0.151 MB/min | Fail at existing 0.15 gate |
| High | Total growth 30.01 MB | Fail at existing 30 MB gate |
| High | Artifact/ledger bytes within deterministic bound | Pass with raw counts |
| High | Quick smoke passes | Feedback only; never freeze certificate |
| Medium | Unknown Electron process type | Account under `other`; total remains exact |

## Verification Commands

```text
npm run compile
node --test .compiled/test/unit/freeze-metrics.test.js
npm run smoke:soak
npm run certify:core-freeze
```

`certify:core-freeze` must produce three 45-minute reports plus one all-pass certificate from fresh processes.

Certification completed cleanly in fresh processes across 3x45m runs (Runs 1, 2, 3: 5400, 5398, 5401 samples; 75 capabilities, 6 artifacts, 12 receipts per run). All 15 gates passed with 0 resource leaks, 0 orphan processes, 0 false canaries, 0 unhandled errors, negative settled growth (-47.24 MB, -32.25 MB, -56.41 MB), and steady slopes within limits (0.20-0.30 MB/min Total, -0.02-0.22 MB/min Renderer). Issued aggregate `freeze-certificate.json` (verdict: PASSED, checksum: `35d40debe7019f3e13918477b4f64e03ca6d7bd5607798a1e3986fb0210744c9`).
## Todo

- [x] Add bounded resource-owner statistics.
- [x] Extend soak metrics and correctness canaries.
- [x] Freeze deterministic thresholds before certification.
- [x] Pass quick real-runtime smoke.
- [x] Pass three fresh 45-minute Windows runs.
- [x] Validate aggregate checksums and issue freeze certificate.
- [x] Reconfirm predecessor certification criterion only after the replacement certificate passes.

## Success Criteria

- [x] Quick smoke exercises all stages but cannot be mistaken for certification.
- [x] Every 45-minute report has valid raw samples, at least 45 minutes of elapsed and sample-span evidence, all workload stages, zero false acceptance, and clean teardown.
- [x] All three independent runs satisfy every ratified and frozen bound.
- [x] `freeze-certificate.json` verifies report/build/threshold checksums and says `PASSED` only under all-pass semantics.
- [x] No resource counter or threshold subsystem is added outside existing owners and scripts.

## Risk Assessment

- **Renderer slope remains near the 0.15 boundary.** Signal: any run exceeds it. Response: stop certification, diagnose the owning renderer workload, fix, and restart all three runs; never average away a failure.
- **Windows antivirus/OS noise causes one-off RSS variance.** Signal: total slope/growth failure with otherwise stable owner counts. Response: retain raw report, investigate, then restart the full three-run sequence only after cause/fix; no threshold relaxation mid-sequence.
- **Disk-stat sampling perturbs workload.** Signal: sample callback duration becomes material. Response: sample disk owners less frequently and record sampler duration; keep memory cadence unchanged.
- **Long process can hang.** Signal: heartbeat/sample timestamp stale beyond bounded interval. Response: orchestrator terminates only its owned process tree, records blocked run, and emits no certificate.
- **Drawer trace can become unverified during a long run.** Signal: `anti.trace.interaction` returns `verified: false` at a scheduled workload batch. Response: retain no aggregate certificate, diagnose the trace evidence before the next attempt, then restart the full three-run sequence.

## Security Considerations

- Reports contain counts, hashes, normalized process classes, and relative artifact names only.
- Do not record attachment secrets, raw prompts, source bodies, customer URLs, or full command lines.
- Process cleanup targets only PIDs started and recorded by the certification orchestrator.

## Rollback Boundary

Instrumentation accessors are read-only and can revert independently of runtime behavior. Certification scripts/reports can be removed without changing Core contracts. Any failure in Phases 1-4 requires fixing the owning phase and restarting certification from run 1.

## Next Steps

After a valid all-pass certificate, mark this plan complete, close the predecessor soak criterion, and only then begin OMP Theme Skill/workflow planning.

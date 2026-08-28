# Code Review Record — Ultra Verifier (best-of-5)

Date: 2026-08-28. Skill: ak:code-review --ultra over the uncommitted measured-performance-optimization diff.

## Protocol
- Stage 1 (spec compliance): controller pass — PASS (scope matches plan Phases 1/4/5/6; Phases 2/3 untouched; telemetry guarded).
- Stage 2: five independent read-only candidates (same evidence packet `local://ultra-review-evidence.md`), one parallel wave; same-tier
  best-of-5 (runtime has no per-subagent model tiers).
- Finalizer: strongest-model verifier, anonymized relabeling, 1-20 rubric scoring: Candidate 3 (rank 1), 5, 1, 4, 2 (rank 5).
  Verdict: union ready, 0 findings rejected at verifier stage.
- Final verification gate: compile, full suite, focused suites, e2e renderer smoke, harness scenarios — run once over the union.

## Union findings (12) and disposition

| # | Finding | Severity | Disposition |
|---|---|---|---|
| 1 | `isTextLike` exact-match MIME misses parameters/suffixes → redaction bypass | Important | FIXED: `split(';')[0]` + `+json`/`+xml` suffix handling |
| 2 | Eager telemetry arg evaluation on hot paths (ptyData byteLength, broadcast double-stringify, countAttachedViews) in production mode | Important | FIXED: guarded behind `isBenchmarkEnabled()` at terminal-manager ptyData, bridge broadcast, tab-host layout/switch |
| 3 | Terminal/split disposal nulls write targets without canceling in-flight dispatcher RAF | Important | FIXED: `dispatcher.cancel(target)` before nulling in syncTerminalPool + unmountSplit |
| 4 | syncTerminalPool clears pendingChunks on snapshot delivery (claimed data loss) | Important | **REJECTED (evidence)**: snapshot is authoritative and already embeds pre-hydration chunks; flushing would duplicate content. e2e `terminal-renderer-smoke.cjs` Step 5 asserts zero duplication (`earlyChunkCount === 1`), Step 4b asserts no replay. Re-run GREEN after all other fixes. |
| 5 | Harness milestone stats count null samples as measured (fail-open) | Important | FIXED: `observationRows` filters finite numbers; null-only → unmeasured |
| 6 | AppDriver.kill() guards tree-kill with exitCode → taskkill never runs on Windows | Important | FIXED: taskkill first, then best-effort `child.kill()`; spawn `detached: !isWindows` so POSIX group-kill is valid |
| 7 | `queuedBytes` accounting drifts (chunk-envelope add vs coalesced-frame subtract) | Minor | FIXED: per-entry `bytes` on PendingOutboundFrame; queue-empty ⇒ exact 0 |
| 8 | `dispose()` client close loop without exception isolation | Minor | FIXED: per-client try/catch |
| 9 | copy-static `existsSync` dst guard serves stale dispatcher on incremental builds | Minor | FIXED: always copy when source exists |
| 10 | Dead UTF-8 slicing helpers in standalone.js | Minor | FIXED: removed |
| 11 | Duplicate `runs` key in harness report literal | Minor | FIXED: `runCount: RUNS` + `runs` array |
| 12 | Harness temp dirs never cleaned | Minor | FIXED: rmSync in kill(); verified no accumulation on Windows |

## Fix-driven findings (found while fixing)
- F13: `redactSecrets` regex could not match quoted JSON keys — and an intermediate `"?"`-based fix would have corrupted JSON
  syntax (`{"password=[REDACTED]"}`). FIXED (final): two-pass redaction — (1) JSON-key-aware syntax-preserving pass
  `/("(?:token|secret|password|api[_-]?key)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi` → `$1"[REDACTED]"` (replaces the VALUE only,
  escaped-quote aware, valid JSON survives), then (2) legacy flat `key[:=]value` rule producing `api_key=[REDACTED]`
  unchanged for non-JSON text. Regression tests assert parameterized + `+json` MIME classification AND
  `JSON.parse(text).password === '[REDACTED]'`.
- F14: `mime.split(';')[0]` TS2532 under noUncheckedIndexedAccess — `?? ''` guard.

## Verification evidence
- `npm run compile`: green (tsc + copy-static incl. dispatcher).
- `npm test`: 342 tests / 73 suites / 0 fail, exit 0 (run twice — once mid-fix, once final).
- Focused: workflow-and-artifact-security + bridge-server: 19/19 (incl. new MIME/JSON redaction test).
- e2e `terminal-renderer-smoke.cjs`: 11/11 steps PASS (Session-4 zero-duplication, split close exercising new cancels).
- Harness `--scenario artifact`: binaryByteEqual=true, redactedDecisions accurate, `runCount: 1`.
- Harness `--scenario cold-start --runs 2`: all milestones measured; TMPDIR benchmark dirs BEFORE=0 AFTER=0
  (kill() cleanup works, taskkill tree kill exercised).

## Ranking appendix
Scores (C1 correctness / C2 severity / C3 coverage / C4 production-readiness, 1-20):
C3 20/20/18/20; C5 20/19/15/17; C1 19/17/16/18; C4 18/17/12/14; C2 18/18/7/12.
Candidate 3 highest; union merged findings from all five (defects surfaced only in lower-ranked candidates were retained).
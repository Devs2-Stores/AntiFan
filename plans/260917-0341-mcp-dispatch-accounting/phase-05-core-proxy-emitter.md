---
phase: 5
title: "core.* Proxy Emitter & Its Reader"
status: pending
priority: P2
effort: "6h"
dependencies: [1]
---

# Phase 5: `core.*` Proxy Emitter & Its Reader

## Overview

The ledger has **zero** `core.*` frames because those calls return in-process before invocation identity is minted (`scripts/antifan-omp-mcp.cjs:1534-1535`, before `:1561`). This phase makes the 51 `core.*` tools visible through a separate, bounded, non-throwing attempt store written by the stdio proxy — and makes that store **readable in the same change**, because a store nothing reads is not telemetry.

**Cuttable as a pair.** If this phase is dropped, Phases 1-4 and 6 are unaffected and the Hub shows `core.*` as an explicit labelled hole. It is P2 and independent of the ledger reader.

## Requirements

- **Functional:**
  - One bounded attempt record per `core.*` dispatch: `{ timestamp, method (post-`CAPABILITY_MAP` name), requestedAs (the caller-typed value), attemptKind: 'dispatched' | 'unknown-capability', outcome: 'ok' | 'error', errorCode?, durationMs, provenance: 'omp-proxy', unit: 'proxy-attempt' }`.
  - **The outcome must be observed, not assumed.** `invokeCore` is `async` (`:522`), so the record is emitted from the **settled promise**, never from a `finally` that runs at promise-return time:

    ```js
    const t0 = Date.now();
    const p = invokeCore(mappedEarly, params);
    p.then(
      () => emitCoreAttempt({ outcome: 'ok', durationMs: Date.now() - t0 }),
      (err) => emitCoreAttempt({ outcome: 'error', errorCode: err && err.code ? err.code : 'ERROR', durationMs: Date.now() - t0 }),
    );
    return p;
    ```
    The `catch` on an un-awaited async call is dead code and a `finally` fires before settlement; both forms are forbidden here, and a test forces a rejection to prove the record says `error` with a non-zero duration.
  - **Bounded records.** `method` and `requestedAs` are caller-derived (`:1533` is `CAPABILITY_MAP[method] || method`): normalize each to ≤128 chars on a tool-name pattern, cap `errorCode` at 64, and **refuse** (never truncate-and-write) any serialized record over a 4 KB budget, counting refusals in the store header. Contrast the house pattern: `fallback-recorder.ts:95-101` bounds every string, `invocation-ledger.ts:803` rejects an oversized frame.
  - **Bounded rotation.** Byte cap per file, plus a **retained-file ring**: at most N rotated files (default 5), oldest pruned. A byte cap alone mints files without limit — the exact uncapped pattern this plan documents elsewhere and must not reproduce. Concurrency: the filename carries `<pid>` so two proxies cannot share one file, and the size check happens in the async writer, never as a `statSync` on the caller's path.
  - **Path comes only from the app.** Target directory is read from `ANTIFAN_PROXY_TELEMETRY_DIR`; absent ⇒ write nothing and emit exactly one stderr notice `proxyTelemetryUnavailable`. **No default, no plausible-path fallback** — the anti-pattern this phase exists to reject is `SUPER_CORE_DB` defaulting to a repo-relative location (`:451-452`).
  - **A reader exists, and it lives with the writer.** The canonical reader is on the proxy itself — `node scripts/antifan-omp-mcp.cjs --core-attempts [--json] [--dir <store>]` — because the module that owns the store's schema is the only place that can read it without a second, drifting parser. It reports attempt count, `ok`/`error` mix, `errorCode` histogram, p50/p95 `durationMs`, unknown-capability count, refusals, `instrumentedSince`, and the launch-path table. The accounting CLI must **not** re-implement that parsing: its `--core-attempts` **delegates** by spawning the proxy with the matching flags (forwarding `--dir` from its own resolved store so the `--store`/`ANTIFAN_DATA_ROOT` precedence holds identically, and forwarding `--json`), streaming stdout/stderr through and propagating the exit code. The Hub shows the summary plus a labelled hole for uninstrumented paths, or the labelled hole alone.
  - **Coverage is disclosed per launch path, not implied.** Measured today: the variable can only reach a proxy spawned through `scripts/antifan-agent.cjs` (response `src/main/bridge/bridge-server.ts:2156-2173` → `:515` → `childEnv` `:761-793` → `spawnAgentChild` `:798`). It does **not** reach `bin.antifan-mcp` (`package.json:12`), `npm run mcp` (`:17`), or Codex (`~/.codex/config.toml` registers no AntiFan MCP server; `src/main/agent/codex-execution-backend.ts:81-100` builds an env that reaches no proxy). Because `childEnv` spreads the sanitized parent environment (`:756`, `:762`) and this key is **not** scrubbed like the bridge token (`:757-759`), a caller can pre-set it and the value reaches the agent's whole subtree — documented as a limitation, not papered over.
  - **The wrap point is not the only place a `core.*` call can end.** `invoke()` refuses *before* the wrap in two further classes — the session tool-surface policy and the advertised required-field contract — so a call refused there is neither a dispatch nor an attempt, and the store undercounts "`core.*` calls" by exactly those two classes. That must be named in both the printed launch-path table and the Hub's labelled hole, because "0 attempts" for a tool that is in fact being refused pre-wrap is otherwise indistinguishable from "not instrumented" — and those two states call for completely different responses.
  - Each store records `instrumentedSince`; the surface states in words that **0 attempts means "not yet instrumented", never "unused"**, and that an attempts-derived rate is a **pessimistic bound** (unknown-capability and abandoned calls are attempts too).
- **Non-functional:**
  - Never throw into the dispatch path; the emit runs after the outcome is known; the append is not awaited before returning the result.
  - Never block: no synchronous filesystem call on the caller's path, no unbounded in-memory queue (drop with a counter past a small bound rather than growing without limit).
  - Module scope must stay side-effect-free: the compile-time budget gate `require`s the proxy module (`scripts/check-mcp-budget-dominance.mjs:83`) before it does anything else.
  - **It is closed at process end:** a proxy that exits immediately after its last call must still have flushed, so the writer registers a flush on `beforeExit`/`exit` — a fire-and-forget append on a stdio server's normal lifetime loses records otherwise.

## Related Code Files

- Modify: `scripts/antifan-omp-mcp.cjs` — the emitter AND its canonical `--core-attempts` reader (it parses only the store it wrote)
- Modify: `src/main/bridge/bridge-server.ts:2156-2173` (produce the path), `scripts/antifan-agent.cjs:756-793` (forward it; do not scrub it silently)
- Modify: `scripts/antifan-mcp-dispatch-account.cjs` (the `--core-attempts` reader — Phase 4 creates the file)
- Create: `test/unit/mcp-proxy-emitter.test.mjs` (`.mjs` runs from source per `package.json:43`, so no compile is needed to execute it)

## Implementation Steps

1. Read `scripts/antifan-omp-mcp.cjs:1505-1570` and record the exact wrap point: `core.*` early return before the bootstrap gate, with `method` and `mappedEarly` both in scope.
2. Implement `emitCoreAttempt(record)` as a module-scope function with no top-level side effects: bounds → serialize → byte-budget check → append via the async writer with the pid-suffixed file and the retained-file ring → count refusals/drops.
3. Wrap the dispatch exactly as the snippet above (promise-aware). Do **not** place the emitter inside `invokeCore`, and state the true reason: the raw caller name and the post-map name are only both in scope at the call site. (An earlier revision justified this with "the compile gate executes `invokeCore`" — false: the gate calls the **catalogue** binding, `def.execute(...)` at `:305-317`, built from `packages/super-core/src/index.ts` at `:47`, and never reaches the proxy's `invoke`.)
4. Implement the proxy's `--core-attempts` reader over the store the proxy writes, and make the accounting CLI's `--core-attempts` delegate to it (spawn with the resolved `--dir`, forward `--json`, propagate the exit code). Do not copy the store's parsing into the CLI.
5. Write `test/unit/mcp-proxy-emitter.test.mjs`: (a) success path emits `ok` with a non-zero duration; (b) **forced rejection** emits `error` with the propagated `errorCode`; (c) oversized `method` is refused, not truncated, and the refusal counter increments; (d) an absent path variable writes nothing and emits one notice; (e) two records on two pids land in two files.
6. Run the phase gate: `npm run compile && node --test --test-force-exit test/unit/mcp-proxy-emitter.test.mjs` (plus the CLI section against a temp directory with a hand-written store).

## Success Criteria

- [ ] Every `core.*` attempt that reaches the wrap point produces exactly one bounded record, and an attempt that fails produces `outcome: 'error'` with its `errorCode` and a duration that reflects the attempt.
- [ ] No record exceeds the byte budget; over-budget attempts are refused and counted, never written truncated.
- [ ] Retained files are bounded by the ring; per-pid filenames mean two proxies never interleave in one file.
- [ ] No synchronous filesystem call on the dispatch path; the dispatch returns without awaiting the append; a pending flush runs at process end.
- [ ] Without the injected variable: zero writes, one `proxyTelemetryUnavailable` notice, no plausible-path fallback.
- [ ] The CLI reads the store it writes (attempts, mix, error histogram, p50/p95, unknown-capability count, `instrumentedSince`).
- [ ] The launch-path table is printed/documented, naming the paths that cannot carry the variable; 0 attempts renders as "not instrumented", never as "unused".
- [ ] `npm run compile` stays green and nothing observable changes for a caller: the `core.*` result value, error object and timing are untouched.

## Test Scenario Matrix

| # | Scenario | Fixture | Expected |
|---|----------|---------|----------|
| P1 | Success attempt | stubbed `invokeCore` resolves | one record, `outcome: 'ok'`, `durationMs >= 0`, `unit: 'proxy-attempt'` |
| P2 | **Forced failure** | stubbed `invokeCore` rejects `CORE_UNAVAILABLE` | `outcome: 'error'`, `errorCode: 'CORE_UNAVAILABLE'`, `durationMs > 0`, caller still sees the rejection |
| P3 | Unknown capability | `method` not in `CAPABILITY_MAP` and not `core.*`-mapped | `attemptKind: 'unknown-capability'`, record still bounded |
| P4 | Oversized method | 50 kB `method` string | refused, refusal counter increments, no file growth beyond the budget |
| P5 | No path variable | env unset | no file created, exactly one notice |
| P6 | Rotation ring | force cap with N+2 files | oldest pruned, file count ≤ N |
| P7 | Two pids | two emitter instances, one directory | two files, no interleaved partial lines |
| P8 | Compile safety | `npm run compile` | budget gate passes; the emitter never runs during compile |
| P9 | CLI reader | temp store with mixed outcomes | counts, mix, histogram and p50/p95 match the fixture; `instrumentedSince` present |
| P10 | Exit flush | emit then exit immediately | the record is on disk |

## Dependency Map

```
Phase 1 (contract freeze: units, provenance labels, UNMEASURED vocabulary)
        └──► Phase 5 (this): proxy emitter + CLI core-attempts reader
                    └──► Phase 6 (docs: provenance table, launch-path holes, CLI usage)
Phase 4 (creates the CLI harness the reader section is added to)
```

## Risk Assessment

| Risk | Signal it broke | Pre-decided response |
|---|---|---|
| The record is emitted before the outcome exists | every record says `ok` with ~0 ms while `core.*` fails | emit from the settled promise; P2 forces a rejection |
| The emitter runs during compile | a store appears while building | module scope side-effect-free; path variable only from the app env; P8 |
| A rogue client floods the store | sustained growth with pathological record sizes | field bounds, record byte budget, retained-file ring, drop counter |
| The store is written but never read | a populated directory with no surface | the CLI `core-attempts` section is part of this phase's definition of done |
| Records are lost at exit | a call's attempt missing from the store | `beforeExit`/`exit` flush; P10 |
| Coverage is assumed to be complete | a path with calls and no records | launch-path table printed and documented; 0 means "not instrumented" |
| The wrap point alters dispatch behaviour | caller-visible result/timing changes | never touch `invokeCore`, the identity block, or the error channel; P1/P2 assert the caller's view |

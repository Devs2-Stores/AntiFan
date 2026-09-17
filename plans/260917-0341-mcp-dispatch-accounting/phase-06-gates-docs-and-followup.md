---
phase: 6
title: "Gates, Docs & Follow-Up"
status: pending
priority: P1
effort: "5h"
dependencies: [2, 4, 5]
---

# Phase 6: Gates, Docs & Follow-Up

## Overview

Close the plan: add a **source-only** build gate that pins the IPC payload's shape, register the deferred canonicalizer defect as a machine-tracked follow-up in the repository's own bottleneck registry, document what the reader does and does not measure, and produce an acceptance receipt that exercises the live-store races the unit fixtures cannot.

Everything in this phase is a repo-native mechanism: this repository has **no CI** (`.github/` does not exist under the app root), so "assertion" means a gate in the `npm run compile` chain or a test lane, never a workflow file.

## Requirements

- **Functional:**
  - Create `scripts/check-mcp-dispatch-payload.mjs` and wire it into the `compile` chain in `package.json` **after** `copy-static` and `build:extension` (i.e. last), for a reason that is load-bearing: the chain currently runs `tsc` (which emits `toolbar.js`) before `copy-static` (which copies `toolbar.html`), so a gate that fails in between leaves a fresh renderer script beside a stale document — the new tab would then never appear and nothing would explain why. A gate that can fail must not sit inside that window.
  - The gate's inputs are **source text and a committed fixture only**. It must not read `control-plane-v2/invocations`, `.antifan/telemetry`, `.antifan-data`, `ANTIFAN_DATA_ROOT`, or `process.cwd()`. This is the property that makes it safe on a launch path: `main.cjs:42` runs `npm run compile` before the app starts and calls `process.exit(1)` on a non-zero exit, so a gate whose inputs are live machine data can brick `npm start` / `npm run dev` on a dirty store. The existing budget gate is safe for exactly this reason — it reads no runtime data at all.
  - Gate rules, each with a fixture that must fail it:
    1. **Allowlist.** The serialized payload's key set is a subset of the frozen aggregate allowlist (`status, reasonCode, affected, evidenceRefs, asOf, storePath, census, fileRollups, rows, totals, reconciliation`, plus per-row `name, calls, frames, superseded, states, errors, latency, excludedLatency, firstSeen, lastSeen, lowerBound`). `fileRollups` is the per-file roll-up Phase 1 exposes (`{ file, quarantineLike, tempLike, frames, admitted, namedInvalid }`) so the margin identity is checkable without a re-scan; it carries file **names**, never absolute paths. This allowlist doubles as the build-time half of constraint D.
    2. **No frame passthrough.** The serialized payload contains none of `runtimeLeaseToken`, `authoritySnapshot`, `runtimePid`, `runId`, `attemptId`, `tabId`, `browserEpoch`, `revisionNumber`, `requestId`, `paramDigest`, `policyDigest`, `attachmentId`, `idempotencyKey`, `evidence`. This is the build-time half of the wire-projection rule, and the identifier list is the one constraint D names rather than a subset of it.
    3. **No absolute path or URL in payload strings — values *and* keys.** No value **and no object key** matches a drive-letter or POSIX-absolute shape, and none matches `^https?://`; the failure trail names the full path to the offending key (`payload.rows[0].errors["C:\Users\Admin\secrets"]`-style) so an operator can find it without guessing. `storePath` is a display label; the absolute path lives in the CLI receipt. Keys are the part of this rule that earns its keep: the first revision walked values only, which is how the gate came to return OK on a payload carrying an absolute path as a histogram key.
    4. **`UNMEASURED` semantics.** When the fixture payload is the empty-store case, the gate asserts `status === 'UNMEASURED'`, `totals === null`, `rows === []` and then **skips the shape assertions (rules 1–3)**. The scope is exact, so state it that way: an `UNMEASURED` payload is deliberately unconstrained by rules 1–3 *in the declared empty-store role*, and that is not a hole in the other direction — the budget-expired fixture is a **different declared role** that still gets rules 1–3 plus its own frozen expectations (`UNMEASURED` + `READ_BUDGET_EXCEEDED` + `census: null` + `totals: null` + `rows: []`). An earlier revision compared totals across payloads without a null guard, so `null === null` failed the build on any machine with no data root — a gate that fails on absence is worse than no gate.
    5. **Static-input self-check.** A unit test greps the gate's own source for the forbidden store tokens and for any `fs` read outside `--fixture`, so a later "helpful" edit that starts reading the live store fails a test rather than silently re-arming the launch-path hazard.
  - The gate runs on **committed fixtures** under `test/fixtures/mcp-dispatch-payload/` (hand-built, containing no live frame, no real path, no customer URL). Live-store verification is an **acceptance** activity with captured output, never a compile-time input. **Fixtures alone are not sufficient, and the first revision proved it in both directions:** fed a real payload it had never been written against, the gate rejected the CLI's own document (rule 1) while accepting a payload carrying an absolute path as a histogram **key**. So one test builds a small synthetic store in a temp directory, runs the CLI against it, takes `payload` from the real `--json` output, and runs all five rules over that document — the gate must be shown able to accept real reader output, not only the fixtures it was authored with.
  - Register the deferred `canonicalJsonStringify` defect in `plans/bottlenecks.json` using a predicate kind that registry actually supports: `file-regex` over `src/shared/control-plane-contracts.ts` matching the array branch (`.join(`, `:510-511`) with status `open`, so `present: true` while the defect stands. `check-bottlenecks.mjs` supports only `any-of | all-of | campaign-verdict-ledger | manual | file-regex | file-absent-regex | json-path-equals | json-path-missing | script-exists | script-matches` and returns `NO_PREDICATE` (exit 1) for anything else — the earlier "or an equivalent executable check" wording was not expressible in that grammar. The behavioural half of the follow-up (a frame with an `undefined` array slot still failing strict verification after a round trip) lives in a **unit test**, not in the registry.
  - `docs/operations.md`: add a new section for this suite covering (a) what the reader measures and the retention horizon; (b) the quarantine margin and why it is a margin rather than a recovery; (c) the `POST_CENSUS_APPEND` / `POST_CENSUS_TRUNCATE` / `VANISHED` / `CENSUS_DRIFT` vocabulary and the `lowerBound` flag; (d) the CLI usage including `--store`, `--as-of`, `--freeze`, `--no-memo`, `--core-attempts`; (e) the `core.*` provenance table with every launch path that cannot carry the environment variable. **Do not touch the Theme QA PII section (`:143-145`)**: that guarantee is scoped to Theme QA report artifacts and says nothing about telemetry, and the earlier revision wrongly cited it as covering fallback telemetry.
  - Produce an acceptance receipt under `reports/` that records, with raw command output: the CLI's `--as-of` run against the live store; a second run on a frozen copy proving byte-identity modulo `asOf`; a **mid-read append** run and a **compaction mid-read** run against a live store (the two races the frozen-copy proof cannot see); a machine-state run where no store resolves, expecting `UNMEASURED`; and the `check-mcp-dispatch-payload.mjs` red-on-seeded-fixture / green-on-real-tree pair.
- **Non-functional:**
  - Every gate either reads committed artifacts or reports `UNMEASURED`; none may fail because a store is absent, empty, or large.
  - `npm run compile` stays green on the real tree, and no gate introduces a failure mode that depends on machine state.
  - Docs edits name mechanisms and paths; no unverifiable claim survives (specifically: no "242 capabilities" or "23 unknown frames" style constant — those are approximations with named methods, not facts).

## Related Code Files

- Create: `scripts/check-mcp-dispatch-payload.mjs`, fixtures under `test/fixtures/mcp-dispatch-payload/`, `reports/acceptance-mcp-dispatch-accounting.md`
- Modify: `package.json` (compile chain, last position; and a `scripts` entry for the CLI if Phase 4 did not add it), `plans/bottlenecks.json`, `docs/operations.md`
- Read-only reference: `scripts/check-mcp-budget-dominance.mjs:30-47` (fixture-driven precedent), `scripts/certify-core-freeze.cjs:38-56` (the freeze-identity input list), `scripts/copy-static.mjs:106` (the copy list — a new `scripts/*.mjs` is not copied, and does not need to be)

## Implementation Steps

1. Write the gate against two committed fixtures (a measured payload and the empty-store payload) and prove the red path by seeding a payload that carries `runtimeLeaseToken`.
2. Wire it last in `package.json`'s `compile` chain and confirm the earlier stages cannot be skipped by its failure.
3. Add the self-check test for forbidden store tokens in the gate's own source.
4. Register the bottleneck row with the `file-regex` predicate and verify `npm run audit` behaves (`present: true`, exit 0 while the defect stands).
5. Add the operations section; explicitly verify the Theme QA PII section is unchanged.
6. Re-certify core freeze: the seam extraction in Phase 2 changes `.compiled/src/main/session/invocation-ledger.js`, one of the eleven inputs hashed by `computeBuildIdentity()` (`scripts/certify-core-freeze.cjs:43`, compared `:142`, written `:176`). Run the certification and record the new identity in the receipt rather than leaving a stale one. Two implementation facts confirmed by the extraction itself: the seam's own emit (`.compiled/src/main/session/invocation-frame-checksum.js`) is **not** in the eleven-input list, and the constant's re-export surfaces in the emit as a `defineProperty` **getter**, not a copied value binding — so assert the runtime value (`67108864`) rather than pattern-matching a literal in the emitted text.
7. Run the live acceptance rows and capture raw output into the receipt.
8. Run the full verification: `npm run compile`, then `test:fast`, `test:main`, `test:unit`, then `npm run audit` and `npm run plans:check`.

## Success Criteria

- [ ] `check-mcp-dispatch-payload.mjs` fails on a seeded payload carrying a frame field and passes on the real tree; it reads no live store and no ambient path, proven by its own test.
- [ ] It sits after `copy-static`/`build:extension`, so a failure cannot leave a fresh renderer script beside a stale document.
- [ ] The empty-store fixture yields `status: 'UNMEASURED'` with the shape assertions (rules 1–3) skipped for that declared role only; no rule can fire on `null === null`.
- [ ] `totals` expectations cover both budget outcomes: a ceiling-tripped fixture renders rows with `lowerBound: true` plus `totals.truncation = { ceiling, filesRead, filesSkipped, order }` and the "partial: N of M files" label (newest-first selection, covered window disclosed); a time-budget expiry renders `UNMEASURED`/`READ_BUDGET_EXCEEDED` with `rows: []`.
- [ ] `plans/bottlenecks.json` gains exactly one row with a supported predicate kind; `npm run audit` exits 0 while the defect is present.
- [ ] `docs/operations.md` documents the vocabulary, the margin, the CLI flags, and the `core.*` launch-path table; the Theme QA PII section is byte-identical to before.
- [ ] The acceptance receipt contains raw output for: live `--as-of` run, frozen-copy byte-identity, mid-read append, compaction mid-read, no-store `UNMEASURED`, gate red/green pair, and the re-certified core-freeze identity.
- [ ] Full lane run recorded: `npm run compile` + `test:fast` + `test:main` + `test:unit` + `npm run audit` + `npm run plans:check`.
- [ ] No hard-coded file, frame, or partition count appears anywhere in this phase's artifacts.

## Test Scenario Matrix

| # | Scenario | Fixture | Expected |
|---|----------|---------|----------|
| G1 | Allowlisted payload | measured fixture | exit 0 |
| G2 | Seeded frame passthrough | fixture + `runtimeLeaseToken` | exit non-zero, names the offending key |
| G3 | Absolute path in payload | fixture with `C:\...` in a string | exit non-zero |
| G4 | URL in payload | fixture with `https://…` | exit non-zero |
| G5 | Empty store | empty fixture | exit 0; asserts `UNMEASURED` + `totals: null`; shape assertions (rules 1–3) skipped for this declared role |
| G6 | Gate source self-check | grep test over the script | no store token, no ambient-path read |
| G7 | Chain position | run `compile` with a seeded failure | `copy-static` already ran; no fresh-JS/stale-HTML window |
| G8 | Bottleneck row | `npm run audit` | predicate `present: true`, exit 0 |
| G9 | `plans:check` scope | run it | validates frontmatter only; not claimed as a deliverable check |
| G10 | Mid-read append (acceptance) | live store, appender running | `POST_CENSUS_APPEND` reported; totals disclosed as a bound; no `MEASURED` claim |
| G11 | Compaction mid-read (acceptance) | live store, trigger compaction | `CENSUS_DRIFT` ⇒ `UNMEASURED`, no rows, or a re-read with a consistent census |
| G12 | No store (acceptance) | clean environment | `UNMEASURED` + reason + no rows; no write anywhere |
| G13 | Frozen-copy determinism (acceptance) | frozen snapshot | two CLI runs byte-identical over every store-derived value — i.e. modulo `asOf` and `census.limits.elapsedMs` (the pass's own wall-clock self-measurement, which can never be deterministic and must be **named**, never silently normalized away) |
| G14 | Core freeze (acceptance) | after Phase 2 extraction | new build identity recorded; certification re-run |

## Dependency Map

```
Phase 4 (payload + CLI)  ─┐
Phase 5 (proxy store)    ─┴─► Phase 6 (this): gate + registry + docs + receipt
Phase 2 (seam extraction) ───► core-freeze re-certification (step 6)
```

## Risk Assessment

| Risk | Signal it broke | Pre-decided response |
|---|---|---|
| The gate reads machine state and blocks launch | `npm start` fails on a dirty or absent store | source + committed fixture only; self-check test; G5/G6 |
| The gate fails on absence (`null === null`) | every machine without a data root fails `npm run compile` | `UNMEASURED` short-circuits the shape assertions (rules 1–3) for the declared empty-store role; G5 |
| A gate failure leaves mixed artifacts | new tab never appears with a green build log | gate runs last, after `copy-static`; G7 |
| The registry row is not expressible | `NO_PREDICATE` on `npm run audit` | use `file-regex`; behavioural check lives in a unit test; G8 |
| Docs overstate what was measured | a reader quotes "242 capabilities" or a fixed frame count | approximations carry their method; no constants; G9 |
| The receipt certifies only the easy path | green receipt with no live-race evidence | mid-read append and compaction rows are required; G10/G11 |
| The extraction invalidates certification silently | stale core-freeze identity | re-certify in this phase; G14 |
| A later edit re-arms the launch-path hazard | the self-check test fails | G6 is the tripwire, and it is a test, not a convention |

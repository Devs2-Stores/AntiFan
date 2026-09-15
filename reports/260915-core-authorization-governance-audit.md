# Core authorization change — governance audit (MCP pairing grant)

- **Audit date:** 2026-09-15
- **Repository:** `E:\Work\apps\AntiFan`
- **HEAD at audit:** `36fb49793eec821b093cc6bb459bcc6109eb4009` (2026-09-15 15:49:53 +0700)
- **Change set under audit:** uncommitted working-tree edits to
  `src/main/bridge/bridge-server.ts`, `src/main/tools/capability-catalogue.ts`,
  `scripts/antifan-agent.cjs`, `scripts/antifan-omp-mcp.cjs`
- **Verdict:** `IMPLEMENTED`, **NOT CERTIFIABLE AS COMPLETE** — 5 gates green, 5 artifacts/gates open
- **Super Core records:** receipt `rcpt-4e715b3d-0769-47dc-b4ca-88d9667786a4`, anti-pattern
  `ap-611a9d85-f151-4c70-816c-839cede2ed63`, fix pattern `fix-aaa240a1-2dd4-4f9f-802e-639dfea6eb89`
- **Full report:** `E:\Work\customizes\Seahorse2\antifan-core\core-governance-gates.md`

## 1. What the change set is (separated from pre-existing noise)

The tree also carries ~29 modified files / ~5000 insertions of unrelated concurrent work. Inside
`src/main/bridge/bridge-server.ts` two independent changes are mixed: the pairing-grant authorization
change (audited here) and a terminal-congestion queue rewrite (`dataParts`, `head` index,
`BRIDGE_TERMINAL_FRAME_OVERHEAD_BYTES`) which is **not** part of this change set and was not audited.

Audited hunks:

| File | Audited change |
|---|---|
| `src/main/bridge/bridge-server.ts` | `PAIRING_GRANT_UNKNOWN` 400 for unknown/non-string `requestedGrant` (:924-932); `grantSource: 'requested'\|'ceiling'\|'default'` (:977); `console.warn` on the silent default (:983); `grantSource` returned in the 200 body (:1020) |
| `src/main/tools/capability-catalogue.ts` | both `POLICY_DENIED` throws (:396, :478) now interpolate `capabilityRisk`, `sessionGrant`, `allowEval`, `runtimeMode` (:398, :480) |
| `scripts/antifan-agent.cjs` | `requestedGrant: resolveSessionGrant()` (:356); `assertGrantNotDowngraded()` + `ANTIFAN_GRANT_DOWNGRADED` (:382-390); `'PAIRING_GRANT_UNKNOWN'` added to `TERMINAL_PAIRING_ERRORS` (:225-226) |
| `scripts/antifan-omp-mcp.cjs` | same (:965, :991-999, and `TERMINAL_PAIRING_ERRORS` :834-835) |

Anchors were read live; several of these files were being edited concurrently by other agents during
the audit, so each anchor carries its search key (error code / symbol / literal) and should be
re-resolved by grep rather than trusted as a fixed coordinate. **The change set grew mid-audit:** the
`'PAIRING_GRANT_UNKNOWN'` entry in `TERMINAL_PAIRING_ERRORS` did not exist when the audit started and
was added at 17:57:51 (`antifan-agent.cjs`) and 18:01:22 (`antifan-omp-mcp.cjs`). Every finding below is
a timestamped snapshot, not a statement about a frozen revision.

## 2. Governing requirements a Core authorization change must satisfy

| # | Requirement | Source |
|---|---|---|
| R1 | Scope B 4-Stage Verification Gate: pre-flight read → anchored edit → **proof-of-work (narrowest test / compiler check / runtime probe)** → binary yield `VERIFIED_COMPLETE` or `BLOCKED` | `AGENTS.md` §2; `CLAUDE.md` §2 |
| R2 | Never claim completion without verifiable proof (stdout logs, diff anchors, test traces) | `AGENTS.md` §3; `CLAUDE.md` §3 |
| R3 | Bug fix protocol: prove reproduction → fix → prove resolution | `.cursor/rules/development-rules.md` §3 |
| R4 | A new regression test for a bug **must fail on the unfixed codebase and pass on the fixed one**; "tests pass" claims need raw stdout with runner + counts | `.cursor/rules/testing-rules.md` §3 |
| R5 | Internal core logic must run against real instances (mocks only for third-party network APIs) | `.cursor/rules/testing-rules.md` §1 |
| R6 | Type/build gating: run the compiler/typechecker immediately after editing | `.cursor/rules/development-rules.md` §2 |
| R7 | No layer may fabricate a value the caller did not supply for a field its own advertised schema marks required; enforcement lives at the publishing surface and at `dispatchAuthenticated` | `docs/mcp-advertised-schema-enforcement.md` |
| R8 | `src/main/` is the Core boundary, locked against non-bugfix modification; official freeze requires the source-bound 3×45-minute certification | `plans/260902-1022-core-freeze-hardening-and-skills-rollout/plan.md` §5.6; `docs/operations.md` "Theme QA & Verification Gate Operations" |
| R9 | Anti-patterns recurring ≥3 times must be written to Super Core; knowledge is written to Super Core/Ledger **only after the fix is verified** | `reports/MASTER-FIX-PLAN.md` Phase 7 / §D |
| R10 | Every `plans/**/plan.md` must declare a recognised `status:` frontmatter bucket | `scripts/check-plans.mjs` |
| R11 | Ledger entries follow the append-only Entry Contract | `E:\Work\docs\SUPER_CORE_LEDGER.md` §Entry Contract |

## 3. Gate results on this tree

| Gate | Read-only? | Result |
|---|---|---|
| `npm run audit` (`scripts/check-bottlenecks.mjs`) | yes — reads `plans/bottlenecks.json` + HEAD files | **PASS** exit 0 · 36 rows `CLOSED=23 REFUTED_OK=4 MANUAL=9`, 7 `STALE` warnings on manual rows |
| `npm run plans:check` (`scripts/check-plans.mjs`) | yes | **PASS** exit 0 · `plans=511 classified=511 no-frontmatter=0 pending=460 done=32 active=12 superseded=6 blocked=1` |
| `scripts/audit-core-purity.ts` (via `.compiled/scripts/audit-core-purity.js`) | yes | **PASS** exit 0 · `[OK] Core Purity Audit Passed` |
| `scripts/check-emit-integrity.mjs` | conditional — may `rmSync(.compiled/.tsbuildinfo)` | **PASS** exit 0 · `1 emit file(s) missing, but all sources are newer than build info — preserving incremental build info` (`.compiled/test/main/pairing-grant-authority.test.js`). Replicated read-only first (`antifan-core/emit-integrity-readonly-probe.mjs`) to prove the deletion branch was inactive: 356 expected emits, 0 missing |
| `scripts/check-mcp-budget-dominance.mjs` | yes | **PASS** exit 0 · 237 capabilities, largest policy 180000 ms (`browser.visual_compare`), proxy ceiling 240000 ms |
| `scripts/audit-capability-reachability.mjs` (new, untracked, the change set's own harness) | yes | **FAIL** exit 1 · `tier non-monotonicity: grant='execute' loses 133 capability(ies) that 'write' reaches`. Pre-existing policy property, **not** caused by the pairing fix |
| `node --test .compiled/test/main/bridge-server.test.js` | narrow, isolated temp roots | **PASS** 23/23, 0 fail. Printed the new default-grant `console.warn` live |
| `node --test .compiled/test/main/capability-catalogue.test.js` | narrow | **FAIL** exit 1 · `navigate` result shape (`unexpected target.url`) — owned by concurrent `browser-control-port` work, not this change set |

### Gates deliberately NOT run

| Gate | Why not |
|---|---|
| `npm run certify:core-freeze` / `npm run smoke:soak` | **Mutating and heavy.** `scripts/certify-core-freeze.cjs` runs `npm run compile` (forbidden), deletes stale outputs, writes `freeze-thresholds.json` + 3 soak reports + a certificate, and spawns Electron for three 45-minute runs |
| `npm run compile`, `tsc -p ./` | Forbidden: concurrent `src/**` editors plus a live dev file watcher |
| `npm run typecheck` | `--noEmit`, but it is a full-program compile contending with concurrently-edited sources; deliberately not run. **Required before completion.** |
| `npm test`, `npm run verify` | Forbidden by the audit brief (long, concurrent editors). `npm run verify` = static lanes `audit` + `plans:check` (both run, green) then `compile` + `test:canary`/`test:fast`/`test:site-clone`/`test:integration`/`test:main`/`test:e2e` |
| `core.check_phase_gate` (Super Core) | **Mutating despite its name:** `packages/super-core/src/index.ts:638` `INSERT INTO phase_gates(...)` on every call |
| `core.snapshot`, `core.import`, `core.adjudicate`, `core.rollback` | Mutate the evidence store / take a release snapshot |
| `scripts/freeze-certification-core.cjs` | Library only (`module.exports` at :363, no `require.main`) — direct execution is a no-op, so there is no gate result to obtain |

## 4. Missing / failing artifacts, concretely

| Artifact | Expected path | Status | Must contain |
|---|---|---|---|
| Regression suite run evidence | `.compiled/test/main/pairing-grant-authority.test.js` + raw stdout | **MISSING** — source exists (717 lines, untracked, created 17:54) but was never emitted, so it has never executed. Satisfies R1/R2/R4 only once run | Runner name (`node --test`), total/pass/fail counts, and both directions of the regression proof (red on unfixed, green on fixed) |
| Plan record | `plans/<YYMMDD-HHMM-slug>/plan.md` + `phase-*.md` | **MISSING** for this change set (the only in-flight plans are terminal-sidebar and the 260914 scout) | Frontmatter with a recognised `status:` (R10), scope, phases, acceptance criteria, cross-plan notes |
| `CHANGELOG.md` entry | `CHANGELOG.md` under `## [v1.3.6] - Unreleased` | **MISSING** — not owned by this audit | A bullet naming the four files, the `PAIRING_GRANT_UNKNOWN`/`grantSource` contract, the client downgrade assertion, and the defect it fixes |
| Core Freeze certificate | `plans/260905-0012-core-pre-freeze-hardening-and-live-proof/reports/freeze-certificate.json` | **STALE / FAILING** — issued `2026-09-05T21:30:36Z`, 393 commits before HEAD. Note its `buildIdentity` hashes 11 artifacts and does **not** cover `bridge-server.js` or `capability-catalogue.js`, so the existing certificate cannot detect this change by hash | A re-issued certificate from `npm run certify:core-freeze` whose threshold manifest echoes this change's build identity |
| Typecheck evidence | raw `npm run typecheck` stdout | **MISSING** (R6) | Exit code 0 / error list |
| One red lane | `.compiled/test/main/capability-catalogue.test.js` | **FAILING**, unrelated owner | Green lane, or an explicit attribution that it is out of scope |
| Super Core Ledger entry (Core-level) | `E:\Work\docs\SUPER_CORE_LEDGER.md` Part 2 | **BLOCKED BY AN OPEN USER DECISION** — `reports/MASTER-FIX-PLAN.md` FIX-7.3 records that whether the Ledger accepts Core/harness-level entries is undecided (`A.10`, branches (a)/(b)). Not written: an auditor must not settle that decision by writing an entry | If branch (b) is chosen, one append-only Entry per the Entry Contract with the Core IDs recorded here |

## 5. Artifacts created by this audit

- `plans/journals/2026-09-15-core-authorization-change-governance-audit.md` — journal entry
- Super Core: `ap-611a9d85-f151-4c70-816c-839cede2ed63` (anti-pattern),
  `fix-aaa240a1-2dd4-4f9f-802e-639dfea6eb89` (fix pattern), `rcpt-4e715b3d-0769-47dc-b4ca-88d9667786a4`
  (decision receipt, verdict `BLOCKED_PENDING_GATES`)
- `reports/260915-core-authorization-governance-audit.md` — this report
- `E:\Work\customizes\Seahorse2\antifan-core\core-governance-gates.md` — full report with the gate
  command transcript and requirement citations

No `src/`, `scripts/`, `extension/`, `test/` or `main.cjs` file was modified, and nothing was
reverted, staged or committed.

## 6. Explicitly unverified

- The regression suite's own pass/fail: its source was never compiled.
- `npm run typecheck`, `npm test`, `npm run verify`: not run.
- `npm run certify:core-freeze`: not run, so Core Freeze re-certification is pending.
- Whether the `grant='execute'` tier loss should be treated as a blocker for this change: it is
  reported, not adjudicated here.

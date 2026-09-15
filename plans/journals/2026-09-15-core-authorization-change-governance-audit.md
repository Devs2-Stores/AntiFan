---
title: Core authorization change governance audit (MCP pairing grant)
date: 2026-09-15
summary: Audited the uncommitted pairing-grant authorization fix against the repo's Core gates. Five gates green, five artifacts/gates open; change is implemented but not certifiable.
---

# Core authorization change governance audit — MCP pairing grant

## What happened

Audited the uncommitted Core authorization fix in `E:\Work\apps\AntiFan` at HEAD
`36fb49793eec821b093cc6bb459bcc6109eb4009` against the repository's own Core gates. The change set is
the `requestedGrant`/`grantSource` fix in `src/main/bridge/bridge-server.ts`, the enriched
`POLICY_DENIED` in `src/main/tools/capability-catalogue.ts`, and
`requestedGrant: resolveSessionGrant()` + `assertGrantNotDowngraded()` in
`scripts/antifan-agent.cjs` and `scripts/antifan-omp-mcp.cjs`.

The tree was already dirty with ~29 modified files and ~5000 insertions of unrelated work, and two
further artifacts belonging to this change set (`test/main/pairing-grant-authority.test.ts`,
`scripts/audit-capability-reachability.mjs`) were created by a concurrent agent *during* the audit, so
every finding below is timestamped and re-resolved live rather than read from the first snapshot.

## Decision

The fix is implemented and the loud-default branch is live-proven, but the change set is **not
certifiable as complete**. A decision receipt recording this verdict was written to Super Core as
`rcpt-4e715b3d-0769-47dc-b4ca-88d9667786a4`, with the anti-pattern
`ap-611a9d85-f151-4c70-816c-839cede2ed63` (SILENT_PAIRING_GRANT_FALLBACK_MAKES_A_RISK_TIER_UNREACHABLE)
and the fix pattern `fix-aaa240a1-2dd4-4f9f-802e-639dfea6eb89` (FIX-PAIRING-GRANT-001).

Gates green on this tree: `npm run audit`, `npm run plans:check`,
`scripts/audit-core-purity.ts`, `scripts/check-emit-integrity.mjs`,
`scripts/check-mcp-budget-dominance.mjs`, plus the narrow pre-existing suite
`.compiled/test/main/bridge-server.test.js` (23/23). Gates red or open:
`scripts/audit-capability-reachability.mjs` (exit 1, tier non-monotonicity at `grant='execute'` —
pre-existing, not caused by this fix), `.compiled/test/main/capability-catalogue.test.js` (exit 1 on a
`navigate` result-shape assertion owned by concurrent `browser-control-port` work), and the new
regression suite which has no emit and has therefore never run. No plan record, no `CHANGELOG.md`
entry, and no re-issued Core Freeze certificate exist for this change.

## Next steps

1. Emit and run `test/main/pairing-grant-authority.test.ts`; it is the only artefact that satisfies
   the regression-proof rule in `.cursor/rules/testing-rules.md` §3.
2. Either fix the `grant='execute'` tier loss or record it as an accepted policy property, so the new
   reachability harness can be quoted as a green gate.
3. Add the plan record under `plans/<YYMMDD-HHMM-slug>/plan.md` (frontmatter `status:` is gated by
   `npm run plans:check`) and the `CHANGELOG.md` entry under `[v1.3.6] - Unreleased`.
4. Re-certify Core Freeze: `npm run certify:core-freeze` was not run (it compiles and executes three
   45-minute Electron soak runs); the current certificate was issued 2026-09-05, 393 commits ago.
5. Full `npm run verify` remains required-before-complete and was deliberately not run (concurrent
   editors).

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.

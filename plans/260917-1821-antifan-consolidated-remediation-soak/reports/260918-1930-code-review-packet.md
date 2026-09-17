# Code review evidence packet — pending changes (2026-09-18)

Immutable packet. Every candidate reviewer receives this identical packet.

## Scope (what is under review)

Uncommitted working-tree changes in `E:\Work\apps\AntiFan`:

- **Pinned diff (authoritative):**
  `plans/260917-1821-antifan-consolidated-remediation-soak/reports/260918-1930-pending-diff.patch`
  (2515 lines, `git diff` output — staged is empty, so this is unstaged + all
  modified tracked files). Review the diff, not the whole repo; read the
  surrounding files when the diff alone cannot prove a claim.
- **Untracked inventory:** `.../reports/260918-1930-untracked.txt`
  (note: `.tmp-*.cjs`, `*.diff`, `_verify/` are scratch artifacts, and
  `packages/site-clone/src/generators/html-parse-fidelity.ts` is a new source
  file — judge it on the same bar as tracked code).

Changed areas, by owner:

1. **Session register durability** — `src/main/session/issue-register.ts`
   (largest change, +307/-…): disk-reconciled monotone writes, `DURABILITY_FAILED`
   on unreadable/unwritable registers, refusal to shrink a non-empty register,
   `readIssuesFromDisk`, merged writes, verification-register isolation via
   `ANTIFAN_VERIFICATION_REGISTER_DIR`.
2. **Runtime-scoped attachment authority** — `src/main/run/attachment-registry.ts`,
   `src/main/control-plane/control-plane-runtime.ts`: replay drops frames whose
   lease carries a foreign `runtimeId`; `renewAttachment` tolerates an unknown
   backend lineage; restart no longer wedges pair-minted attachments.
3. **Test/harness isolation** — `test/golden-slice-e2e.test.ts`,
   `scripts/freeze-theme-workload.cjs`, `scripts/smoke-theme-golden-live.cjs`:
   scratch data root / verification-register dir so harness runs stop polluting
   live data.
4. **OMP bridge hook** — `.omp/hooks/pre/antifan-core-bridge.ts`: three newly
   bound lifecycle events (`turn_end`, `agent_end`, `session_shutdown`) recording
   one evidence row each with re-entry dedupe, releasing pack identity on
   shutdown. NOTE: behavioral tests for these three bindings are being added to
   `test/unit/context-bridge.test.mjs` concurrently — treat the bindings as
   unverified by tests until those land; judge the logic itself.
5. **Renderer / toolbar + MCP stats** — `src/renderer/toolbar.{ts,html,css}`,
   `test/renderer/mcp-stats-hub.test.ts`: MCP-stats surface and toolbar wiring.
6. **Browser/tab hosts** — `src/main/browser/tab-devtools-host.ts`,
   `src/main/browser/scripts/injected-script-store.ts`,
   `src/main/tools/browser-capabilities.ts`, `src/main/tools/browser-control-port.ts`,
   `src/main/tools/adapters/tree-walker-sanitizer.ts`.
7. **site-clone package** — `packages/site-clone/src/**` (asset harvester,
   localizer, control-state journeys, generators) + `scripts/materialize-surface.cjs`,
   `scripts/test-clone-features.cjs`.
8. **Docs/scripts of the running plan** — `scripts/run-omp-soak.cjs` (soak duration
   hint 120), `plans/260916-1037-antifan-defect-remediation-master/plan.md`.

## Confirmed constraints (project contract, not negotiable)

From `AGENTS.md` (Level 0, repo root) and `C:\Users\Admin\.claude\CLAUDE.md`:

- No placeholders, stubs, mocks, or synthetic fallbacks in shipped paths; real
  behavior only.
- Never weaken/delete a test to reach green; a test that pins wording or
  implementation is a defect to delete, not to re-pin.
- Evidence before claims: any completion claim needs a fresh executed check.
- Public contracts change only when intended; callers migrate with the change.
- Compile gate: `npx tsc -p .`; the unit suite runs from `.compiled/test/**`.

## Acceptance criteria for this review

- Findings must be **specific, evidenced (`file:line`), and reproducible** —
  a reviewer claim without a cited location is dropped by the verifier.
- Severity ladder: **Critical** (data loss, silent corruption, security,
  unrecoverable wedge), **Important** (wrong behavior on a real path,
  regression, missing guard on an observable contract), **Minor** (maintainability,
  clarity, naming), **Nit** (style; report at most 3).
- Prefer: correctness on failure paths, idempotency/monotonicity guarantees,
  error-vs-success honesty (codes/messages that lie), lost-update races between
  concurrent writers, resource leaks (listeners, timers, file handles), and
  verification gaps (claims asserted without a check).
- Do **not** report: desired-but-unrequested features, "consider adding tests"
  without naming the exact unverified behavior, restyling, or anything the diff
  neither introduced nor touched.
- Requested scope is a constraint, not a finding.

## Verification state (already executed, 2026-09-18)

- `npx tsc -p .` → clean.
- `node --test` over the register/lifecycle/semantic/verification/evaluator
  suites → **81 pass / 0 fail** (`.compiled/test/unit/...`).
- Hook binding: **no executed check yet** (tests being added) — the honest status
  is `[INFERENCE]` for the three new bindings.
- Live probes (app restarts, soak) have not run yet.

## Deliverable

A Stage-2 quality review of the pinned diff: findings with severity, `file:line`,
the concrete failure scenario, and the smallest fix. Read-only — do not edit any
file, do not run mutating commands, do not write shared artifacts.

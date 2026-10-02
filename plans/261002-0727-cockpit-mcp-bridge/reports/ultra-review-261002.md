# Ultra review — pending cockpit diff (5 candidates + verifier)

**Verdict: FAIL** — 21/22 findings evidence-validated, 0 rejected. Ranking appendix: A(19) > B(17) > M=D(16) > E(15) > F(14) > G(14) > C(13) > I(13) > H(12) > K(12) > J(11) > L(11) > Q=N=P=R(10) > O(9) > S=U(8) > T=V(7). Full validated union + verifier rationale: `agent://UltraVerifier`, `.scratch/ultra-candidate-union.md`.

## Blocking subset (must fix before ship)

| # | Finding | Anchor | Fix |
|---|---------|--------|-----|
| A | CAS base captured at enqueue — two saves in one RTT deterministically drop the second mutation (F6) | `toolbar.ts:871` | move `baseUpdatedAt` read inside the `.then` |
| B | `THEME_CHECKLIST_LOAD/SAVE` forward renderer `workspaceRoot` unconfined → arbitrary-dir FS R/W (F4/F13 parity) | `native-tab-host.ts:2593,2603` | confine vs sender window's resolved root or resolve in main |
| D | `cockpit_scan` discards `navigateAndWait` false → QA on stale page (F1 class) | `cockpit-capabilities.ts:310` | throw `NAVIGATION_FAILED` on false |
| E | scope memo URL-keyed while `resolveTargetWorkspace` reads ambient state → stale/misrouted identity; provisional pins forever; `releaseTab` dead (F7) | `cockpit-port.ts:111-136` | never memoize provisional; invalidate on root drift; wire releaseTab |
| M | `copy-static.mjs` dropped `standalone.*` → packaged build ships no terminal renderer | `copy-static.mjs:41-47` | restore the four files to `filesToCopy` |

## Conditional blocking

- C (`confineWorkspaceRoot` fail-open on empty root) — one-line fix; blocks if bridge-only/empty-root modes in scope.
- G/F/H cluster — jointly violate "existing ticks survive cutover"; G (legacy-key deletion before persisted union) blocks alone.
- I (CAS opt-in on absent base) — cheap fix, recommended blocking.

## Non-blocking validated

J (Date.now CAS stamp), K (corrupt-reads-as-absent), L (`params.tabId` swallowed), N (empty-tabId error row repaints badge), O (tmp sweep no staleness check), P (any-scope busy gate), Q (sleeping unreachable for parked-while-waiting), R (LOAD vs push ordering), S (pet controller double-init, latent — no `activate` on win32), T (double listSessions), U (missing `.thinking` beacon CSS), V (dead `'thinking'` union member).

## Coverage gap

Live E2E never run: visible `cockpit_mark` flip, bound≠active `cockpit_scan`, CAS interleave, migration union on a real profile. A and D are deterministic — provable in a short manual session.

# VERDICT — Cookie/Cache session architecture (ultra run, 2026-09-19)

Closes `plans/reports/260919-cookie-cache-ultra-packet.md` (immutable packet) against the code
that shipped in v1.3.6. Every claim below has a re-runnable command or a `path:line`.

## 1. Selection

All five candidate plans (`CAND-X1`…`CAND-X5`, anonymized map in `.mapping.json`) converged on the
same three-phase design — one non-ambient target-session resolver, per-partition cookie durability,
truthful Chrome-sync reporting — and differed only in emphasis and extra staging. The implemented
design is that converged core; whatever each candidate added beyond it was not required to retire
AC1–AC8.

**Stated plainly:** the verifier's per-candidate scores were not persisted anywhere in this repo, so
this file does **not** claim a rank order it cannot show. What it does is certify the outcome: which
acceptance criterion is met, by what code, and by what evidence.

## 2. Acceptance criteria → disposition

| AC | Disposition | Evidence |
|---|---|---|
| AC1 — no path may write credentials into an ephemeral/capsule jar | **Met** | `local-session-vault.resolveCredentialJar()` rejects a RAM jar (`EPHEMERAL_TARGET_REJECTED`) and a workspace jar (`CAPSULE_TARGET_REJECTED`); `test/main/credential-target-jar.test.ts` |
| AC2 — all six credential entry points resolve from an explicit profile id | **Met** | `getActiveTabSession()` has 0 call sites in `src/main`; `NativeTabHost.resolveTargetProfileSession()` is the only resolver and throws `TARGET_SESSION_INVALID` off `persist:profile-*`; entry points `app-menu.ts`, `native-tab-host.ts`, `tab-context-menu.ts` |
| AC3 — vault reports the jar and refuses a hollow success | **Met** | export refuses to overwrite with an empty store (`EMPTY_STORE_REJECTED`); results carry `targetJar` + `googleAuthCount` (`local-session-vault.ts:305,345,363,391`), surfaced in both menu items (`app-menu.ts:216,236`); `test/main/local-session-vault.test.ts` |
| AC4 — the migration no longer writes an unreadable namespace | **Met** | `capsule-partition-migration.ts` strips every leading `capsule-` before mapping, so the copy target is `persist:profile-<id>`; `test/main/capsule-partition-migration-pure.test.ts` |
| AC5 — dead stores reclaimed by a guarded, idempotent, auditable path | **Met** | `src/main/browser/dead-store-cleaner.ts` + `npm run prune:dead-stores` (`--apply` required, tab/capsule vetoes, containment assertion, deferred `EPERM`/`EBUSY` instead of failure); `test/main/dead-store-cleaner.test.ts`, `scripts/smoke-dead-store-housekeeping.cjs`, `scripts/inventory-dead-stores.cjs` |
| AC6 — cache configuration matches reality | **Met (one switch kept, with its measurement recorded)** | `--disk-cache-dir` removed from `src/main/index.ts:199` — it provably wrote 0 bytes since it was added. `--disk-cache-size` stays at `index.ts:222` with the measurement that contradicts the old belief recorded beside it (`index.ts:203`: the live jar's cache measured 168–171 MB while the switch said 128 MB, so partition caches are evicted by Chromium's own policy). Removing it too would change the default session's cache behaviour on evidence this run does not have, so it was left alone and documented instead; `scripts/smoke-cdp-hydration.cjs` |
| AC7 — durability measurably better across a hard kill | **Met** | `src/main/browser/cookie-durability.ts` arms `cookies.on('changed')` per partition, debounces 1 s, `flushStore()`; imported session cookies get a 30-day TTL; `scripts/smoke-cookie-hardkill-durability.cjs` — armed jar keeps its cookie after `taskkill /F`, control jar loses it, `armedReArm=false`, `FLUSH_OBSERVED` |
| AC8 — every fix has a fail-before/pass-after reproduction | **Met** | hardkill smoke (armed vs control jar), boot-housekeeping smoke (defer on boot 1, reclaim on boot 2), companion drift test (names the 8 missing domains pre-fix), popup count contract (`actual: 2, expected: 1` pre-fix), dead-store cleaner (holder alive ⇒ deferred, holder gone ⇒ reclaimed) |

## 3. Verification at close

- `npm run test:main` — 1369 tests, 1367 pass, 0 fail, 2 skipped.
- `npm run test:unit` — 1155 tests, 1150 pass, 0 fail, 5 skipped.
- `npm run prune:dead-stores` — idempotent; re-run on the real root reports nothing dead left.

## 4. Carried, not closed (by design)

- Chrome ≥ 127 App-Bound Encryption v20 makes a signed-in real profile unreadable through a clone;
  CDP import returns zero cookies and the app now names the cause (`chrome-profile-sync.ts:495-503`).
- Which client owns Google's rotating `*PSIDTS`/`*PSIDRTS` is a policy choice (one owner per
  account), not a code defect: `docs/research-cache-cookie-mechanism.md` §P2#7.
- The UA/`userAgentData.brands` fingerprint mismatch remains a measured correlation with no A/B.

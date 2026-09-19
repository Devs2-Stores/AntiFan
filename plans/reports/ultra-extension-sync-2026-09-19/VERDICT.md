# VERDICT — Chrome → AntiFan cookie channel (ultra run, 2026-09-19)

Closes the run against `EVIDENCE-PACKET.md` in this directory. The packet is
immutable; this file is the verifier verdict plus the disposition of every item
it listed, each with the evidence that settles it.

Finalizer verdict: **the packet's §1 root cause is confirmed and is the one that
was repaired**; no candidate proposed a rival cause that survived. The pack was
produced by five independent read-only diagnostics from the same packet, scored
on evidence chain, rival elimination, line-level specificity, and testability.

## 1. Root cause (confirmed, repaired)

The companion-extension channel dropped every Google/YouTube cookie: the
sender's scope (`src/extension/domain-scoper.ts` `SCOPE_PROFILES`) contained
seven domains the receiver's grant allowlist
(`src/main/bridge/bridge-server.ts` `DEFAULT_EXTENSION_ALLOWED_DOMAINS`) did not,
and the `/api/cookies/import` filter discards non-matching cookies **silently**.

Repair: the allowlist now carries the missing domains (`google.com`,
`youtube.com`, `googleusercontent.com`, `gstatic.com`, `google.com.vn`,
`shopifycloud.com`, `bizweb.vn`); the response reports `filteredCount` so a
dropped cookie is visible instead of quiet; the extension popup reports the
count the receiver **accepted**.

| Check | Before | After |
|---|---|---|
| `scripts/probe-companion-grant-scope.cjs` (real route, default grant) | `importedCount: 0`, no cookie written | `importedCount: 3`, `filteredCount: 1`, out-of-scope cookie still denied |
| `test/main/extension-companion-pipeline.test.ts` → "default grant reaches every domain the companion extension is scoped to send" | fails, naming all 8 missing domains | passes |
| `test/main/extension-sync-report.test.ts` → "the popup is told what the bridge accepted…" | `count: 2` (echoed what the extension attempted) | `count: 1`, `attempted: 2` |

The popup test was proven discriminating by patching the built module back to
`count: targetCookies.length` (fail: `actual: 2, expected: 1`) and restoring it
(pass). The drift test covers both halves in one run: a `.google.com` cookie
lands while `.evil.test` is denied.

## 2. Item disposition

| Item | Disposition | Evidence |
|---|---|---|
| §1 allowlist asymmetry | **Fixed** | `default` grant probe 0 → 3 imports; drift test fails before, passes after |
| §2 two lists, no drift guard | **Fixed** | the new contract test drives one import per regex in `SCOPE_PROFILES`, so sender scope ⊆ receiver allowlist is enforced, not documented |
| S1 clone path can never import (Chrome ≥136 + ABE v20) | **Fixed (diagnosis)** | `src/main/browser/chrome-profile-sync.ts:495-503` now names ABE v20, the 136+ CDP block, and both channels that do work (Companion extension, Session Vault) instead of only the vault |
| S2 rotating `*PSIDTS`/`*PSIDRTS` copied verbatim | **Documented, not coded** | `docs/research-cache-cookie-mechanism.md` P2#7 + CHANGELOG "Giới hạn còn lại": two clients rotating one session invalidate each other by design; dropping the token locally would break the sign-in it is meant to carry. Contract: one browser owns Google, resync one-way |
| S3 vault cannot distinguish "restored" from "signed in" | **Fixed** | `googleAuthCount` on export/import results (`local-session-vault.ts:305,345,363,391`) surfaced in both menu items (`app-menu.ts:216,236`) |
| S4 `prune-dead-stores` could never reclaim the live cache dir | **Fixed (root cause)** | `plans/reports/260919-store-reclaim-boot-race.md`: the fire-and-forget legacy migration held source partitions, so the reclaim pass reported `EPERM`/deferred and re-armed its own gate. Migration is now awaited before the pass. Live `Profile/Cache` (220 MB) deletion stays gated by "no live default session + 24 h quiet" — applied at boot on the next restart |
| S5 %TEMP% debris | **Reclaimed** | 57 `af-*` roots / 345 MB removed; cleaner re-run reports 0 remaining |
| S6 UA/UA-CH correlation | **Untouched (non-goal)** | §4 forbids further spoofing; sign-in works, so no A/B was run |

## 3. Verification (fresh, this session)

- `npm run compile` — clean.
- `npm run test:main` — **1369 tests, 1367 pass, 0 fail, 2 skipped** (baseline 1368; +1 is the popup contract test).
- `npm run test:unit` — **1155 tests, 1150 pass, 0 fail, 5 skipped** (unchanged).
- `scripts/prune-dead-stores.cjs` — `scanned: 0`, `deleted: 0`; nothing dead left on the temp root, real store untouched.

## 4. Residual risk / what is still required from the user

1. **Restart AntiFan Desktop** — the running instance holds the old in-memory main bundle; the bridge-side fix takes effect only after restart.
2. **Reload the Companion extension at `chrome://extensions`** — the real popup count and the new warning text come from `extension/popup.js`; the already-installed extension needs the reload to pick it up.
3. Google's rotating cookies remain single-owner (S2). Syncing one browser at a time is the supported contract.

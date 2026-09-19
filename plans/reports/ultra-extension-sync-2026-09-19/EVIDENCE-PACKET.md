# EVIDENCE PACKET — Chrome → AntiFan cookie channel (immutable)

Date: 2026-09-19. Repo: `E:\Work\apps\AntiFan` (Electron app, TS → `.compiled`, CommonJS).
Mode: `ak-fix --ultra`. Candidates plan ONLY. No candidate edits files, runs fixes, or mutates state.

## 0. User goal (verbatim intent)

"Nghiên cứu sâu cơ chế Cache/Cookie hiện tại. Rất nhanh hết, lúc ăn lúc không… không đồng bộ được từ Chrome."
Then: "Fix hết đi rồi commit và push nhé."

Prior session already fixed: (a) three "Sync Chrome Profile" menus + two Session Vault menus resolving different target sessions (`getActiveTabSession()` deleted; one resolver `NativeTabHost.resolveTargetProfileSession()`, fail-closed `TARGET_SESSION_INVALID`); (b) migration dead-end namespace; (c) 30-day TTL backfill for session cookies on import; (d) persisted writer + boot reclaim. Evidence: `docs/research-cache-cookie-mechanism.md`, `plans/journals/2026-09-19-cache-cookie-mechanism-deep-dive.md`, `CHANGELOG.md` entry "# Sua loi - Co che Cache/Cookie…".

## 1. CONFIRMED ROOT CAUSE (do not re-derive)

**The companion-extension cookie channel silently drops every Google/YouTube cookie.**

Sender scope (`src/extension/domain-scoper.ts:3-11`, bundled into `extension/background.js:779-790`):

```ts
export const SCOPE_PROFILES = {
  google: [ /(^|\.)google\.com$/, /(^|\.)youtube\.com$/, /(^|\.)googleusercontent\.com$/,
            /(^|\.)accounts\.google\.com$/, /(^|\.)gstatic\.com$/, /(^|\.)google\.com\.vn$/ ],
  ecommerce: [ /(^|\.)haravan\.com$/, /(^|\.)myharavan\.com$/, /(^|\.)myshopify\.com$/, /(^|\.)shopify\.com$/,
               /(^|\.)shopifycloud\.com$/, /(^|\.)sapo\.vn$/, /(^|\.)mysapo\.net$/, /(^|\.)bizweb\.vn$/ ],
};
```

Receiver allowlist (`src/main/bridge/bridge-server.ts:40-51`) — the grant pinned to the native-messaging handshake:

```ts
export const DEFAULT_EXTENSION_ALLOWED_DOMAINS: string[] = [
  'haravan.com','myharavan.com','hstatic.net','sapo.vn','mysapo.net',
  'mysapo.vn','bizwebvietnam.net','dktcdn.net','shopify.com','myshopify.com',
];
```

Filter that consumes it (`bridge-server.ts:1490-1500`), applied when `verifiedExtensionGrant` is set:

```ts
const candidateCookies = verifiedExtensionGrant
  ? (verifiedExtensionGrant.allowedDomains && verifiedExtensionGrant.allowedDomains.length > 0
      ? rawCookies.filter((c) => { const domain = c.domain?.replace(/^\./,'') ?? '';
          return verifiedExtensionGrant.allowedDomains.some(rawAllowed => { const allowed = rawAllowed.replace(/^\./,'');
            return domain === allowed || domain.endsWith('.' + allowed); }); })
      : [])
  : rawCookies;
```

Asymmetry: sender scope ⊅ allowlist in 7 domains — `google.com`, `youtube.com`, `googleusercontent.com`, `gstatic.com`, `google.com.vn`, `shopifycloud.com`, `bizweb.vn`. The Google family is exactly what the user tried to sync. `importedCount` ≈ 0 while HTTP is 200 `success: true`; the extension popup reports "Đã đồng bộ thành công N cookies" (`extension/popup.js:136`, N = `importedCount`).

Live channel facts (Tier-1):
- `E:/Work/.antifan-data/runtime/logs/native-host.log` — the companion extension IS installed in the user's real Chrome and handshakes repeatedly. Last: `{"action":"HANDSHAKE"}` → `{"status":"SUCCESS","token":"…","port":20130,"activeCapsuleId":"capsule-96f81431…","activePartition":"persist:profile-profile-2"}`.
- Grant minted at `src/main/index.ts:670-674`: `issueExtensionGrant(tabHost.getSharedProfilePartition('clean'), DEFAULT_EXTENSION_ALLOWED_DOMAINS)` → the default (broken) list is what every installed extension gets.
- `NativeTabHost.isValidCapsulePartition` accepts `persist:profile-*` (`native-tab-host.ts:3479-3482`) → the pinned partition is accepted, so the partition gate is NOT the failure.
- `main.log` = heartbeats only; the bridge has no request logging, so the drop is invisible in logs.
- Scoping by allowlist is an intentional, tested contract: `test/main/extension-companion-pipeline.test.ts:554-590` ("Only the cookie in allowedDomains must be imported"; empty list denies all). So the defect is the *contents* of the default list, not the filter.

Reproduction (deterministic, from the tests' own harness): mint a grant with `DEFAULT_EXTENSION_ALLOWED_DOMAINS`, POST `{cookies:[{name:'SID',domain:'.google.com',…}], partition:'persist:profile-profile-2', source:'chrome-extension-delta'}` to `/api/cookies/import` → expect `importedCount: 0` pre-fix, `1` post-fix. Harness reference: `test/main/extension-companion-pipeline.test.ts` (real `BridgeServer` on an ephemeral port + grant + stub host).

## 2. STRUCTURAL ROOT (why it drifted)

The extension's scope lives in `src/extension/domain-scoper.ts`; the bridge's allowlist is a hand-maintained literal in `src/main/bridge/bridge-server.ts`. Two lists, one feature, no shared source and no drift guard. Any domain added on the sender side silently vanishes on the receiver side. The fix class must remove the possibility, not just add six strings.

## 3. SECONDARY ITEMS (each independently confirmed)

- **S1 — Chrome profile clone path can never import cookies on modern Chrome.** Chrome ≥136 ignores `--remote-debugging-port`/`--remote-debugging-pipe` unless `--user-data-dir` points to a NON-standard directory (Chromium policy, Chrome for Developers blog 2025-03-17 + issues.chromium.org/429117827); a non-standard dir means a different App-Bound Encryption key, so the clone's cookies cannot be decrypted (≥127 ABE v20). Both halves verified from primary sources; the app's own clone path measured 0 cookies. The message already surfaces ABE + points at the Session Vault (`src/main/browser/chrome-profile-sync.ts:495-503`), but it does not mention the ≥136 CDP block nor the extension channel that can actually deliver Google sessions.
- **S2 — rotating Google cookies are copied verbatim.** `__Secure-1PSIDTS` / `__Secure-3PSIDTS` (and `__Secure-{1,3}PSIDRTS`) are per-session rotating tokens bound to one client; copying a snapshot to a second Chromium leaves two clients rotating the same session (the packet's P2#7 "sanctioned strategy: single owner" was never implemented). Import transform: `extensionCookieImportSetDetails` (`src/main/browser/chrome-profile-sync.ts:44+`), shared by the bridge endpoint and the vault.
- **S3 — vault results never distinguish "restored" from "signed in".** `exportVaultToFile`/`importVaultFromFile` (`src/main/browser/local-session-vault.ts`) report only cookie counts; menu strings at `src/main/browser/app-menu.ts:210-240`. A restore of a backup without Google auth reports success and the user is still logged out.
- **S4 — `prune-dead-stores` can never reclaim the live cache dir.** `scripts/prune-dead-stores.cjs` requires a 24 h quiet period for every deferred path; a failed deletion of `Profile/Cache` refreshes the directory mtime, resetting the gate. Measured: `Profile/Cache` deferred at 220 MB (app running holds it via NetworkService); reclaiming only happens offline. Cache is disposable; partitions are state.
- **S5 — %TEMP% debris.** ~57 `af-*` roots, 345 MB, left by earlier smoke runs (including two `af-cookie-hardkill-*` from flaky runs). Operational cleanup, no code.
- **S6 — fingerprint (UA/UA-CH) stays an unverified correlation.** App Chromium major (`process.versions.chrome` → `getChromeVersion()`, `src/main/browser/google-auth-identity.ts:9-11`) differs from the Chrome that minted the cookies; `navigator.userAgentData.brands` is empty while the app rewrites `sec-ch-ua` headers to claim Chrome brands. No A/B was run and sign-in currently works, so the packet's non-goal applies: do NOT spoof more. A candidate proposing to change the UA/hints must reject itself under §4.

## 4. NON-GOALS (any plan violating these is rejected)

- No widening of the endpoint's auth model: bearer grant still required, origin gate unchanged, extension grants stay pinned to one partition, rejections stay fail-closed.
- No new runtime dependency in the main process (in particular `tldts` must not become a main-process dependency; the extension bundle may keep using it).
- No UA/client-hints spoofing expansion (S6).
- No live `haravan`/`shopify`/`sapo` theme pushes, no git destructive commands, no `rm -rf` on user data roots.
- No relaxing or deleting existing tests to get green; the allowlist contract test must keep asserting that an out-of-scope domain is denied.
- Keep Vietnamese user-facing strings; match existing comment conventions (explain the invariant, no plan/phase/finding codes).

## 5. ACCEPTANCE (what the plan must prove)

1. A `.google.com` cookie POSTed through the real `/api/cookies/import` with a native-messaging-style grant lands in the target session, while an out-of-scope domain (e.g. `.evil.test`) is still denied — one test, both halves.
2. A drift guard exists so the two scope lists cannot diverge again (shared source preferred; a test that fails on divergence is the minimum).
3. `npm run compile` green; `npm run test:main` and `npm run test:unit` green (baseline 1365 / 1150 pass, 0 fail).
4. Each changed behavior has a test that fails before the change and passes after.
5. `git log`/diff show the fix scoped to the channel + the secondary items; commit messages conventional, no AI references.

## 6. ENVIRONMENT / CONSTRAINTS

- Node v24.13.0; Windows 11; app running the OLD compiled bundle (restart needed after `.compiled` changes — the running instance keeps the in-memory main bundle).
- The companion extension in the user's Chrome is already installed: any bridge-side fix takes effect immediately; any extension-side change needs a manual reload in `chrome://extensions` — say so in the plan.
- `.compiled` is a build output; `scripts/build-extension.mjs` bundles `src/extension/*` → `extension/background.js` (committed artifact).
- `scratch/` is gitignored (evidence probes live there).

## 7. DELIVERABLE PER CANDIDATE

One fix plan: chosen repair per item (F/S), exact files + anchors, ordered change list, risk notes with the blast radius, and the acceptance commands. Ground it in this packet; do not re-derive §1; do not edit anything.

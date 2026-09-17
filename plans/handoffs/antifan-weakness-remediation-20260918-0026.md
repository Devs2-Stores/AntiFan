# Handoff — AntiFan weakness remediation (register-first)

> **Artifact type:** continuation contract for a successor coding agent.
> **Author session:** read-only investigation of 7 user-reported weakness items + cross-cutting defects, 5 adversarial candidates + 1 adjudicating verifier.
> **Author wrote ZERO lines of product code.** Nothing in `src/`, `packages/`, `scripts/`, `test/` was modified by this session.
> **Redactions applied:** 0 secret values were ever read, copied, or embedded. See section 7 for one on-disk credential exposure the user declined to rotate.

---

## 1. Mission and current status

**Mission.** Eliminate the defects found in a 7-item weakness investigation of AntiFan Browser Desktop, in an order that does not destroy evidence while fixing it. Start by defusing an armed, single-call, irreversible data-loss path in the verification register.

**Desired outcome.** A fresh agent session shows: `anti.verification.list` returns the 1,000 records that are actually on disk; no failure is reported under a false code; the session-bound tab is addressable from a no-argument call; the split terminal is visible and nameable; the capture pipeline either succeeds or refuses with a truthful, mechanism-specific reason.

**Status: investigation COMPLETE, execution NOT STARTED.**

- Done: full read-only audit; all anchors re-verified in source; 5 independent remediation candidates produced; 1 independent verifier adjudicated them; verdict and 8-step order locked (section 8).
- Done: protective backup of the at-risk register (section 3).
- Done: user answered all 5 blocking questions (section 2).
- Remaining: **all product-code work**. Zero of the 8 steps have been implemented.
- **Urgency: P0 on step 1.** The data-loss path is live right now and requires exactly one ordinary tool call to trigger.

**Deliverables produced by the author session**
- `plans/reports/260918-0040-antifan-weakness-audit-and-remediation.md` — full Vietnamese report, all 7 items, 4 new defects, 14-defect frequency table, adjudicated program.
- `scratch/antifan-weakness-evidence-packet-260917.md` — frozen evidence packet (raw evidence, `[T1]`/`[T2]`/`[INFERENCE]` graded).

---

## 2. Scope and guardrails

**Repository / workspace:** `E:\Work\apps\AntiFan` (git top-level confirmed `E:/Work/apps/AntiFan`). Branch `main`.

**Permitted changes:** the 8 steps in section 8, and only those, in that order.

**Prohibited — these are Level-0 invariants and a user directive cannot waive them:**

- No AI/model/daemon loop inside AntiFan. The architecture is: external agents own reasoning, AntiFan owns execution + verification evidence.
- No new MCP tool name without running `npm run accounting:mcp-dispatch`. This gates `core.candidates`, per-tab audio mute, and any `evaluate_file`.
- Never delete, skip, or weaken an existing test. The freeze change must **ADD** a gate and must never relax `DEFAULT_STABILITY_POLICY`. Diff must show added assertions only.
- No `force` bypass anywhere.
- Never spawn `hrv`; never make `haravan-uploader.ts` perform a real upload (live remote write requiring approval).
- No destructive VCS (`git reset --hard`, `git clean -fd`, `git checkout -- .`, `git push --force`), no `rm -rf`, no uncoordinated `taskkill`. **This matters acutely here — see the dirty working tree in section 3.**
- Do not re-run the capsule→profile migration and do not delete the 84 dead partition namespaces.
- Do not raise capture time budgets (already attempted; `CAPTURE_EMPTY_PAYLOAD` = 0 proves prior rounds worked that axis).
- Do not build an auto-rebind/retarget daemon. A human browses the same window concurrently.
- Do not unify the two capture settle gates (that is a QA verdict policy change, not a mechanism fix).
- Do not "fix" `CAPABILITY_ERROR`s that are correct relays of the page's own JS errors (see section 6).
- Do not revive the held gate-calibration plan S1–S5.
- Never write to the live register under test. Prove the guard on a **copied fixture in a temp dir**.

**User constraints and approvals collected this session (2026-09-18):**

| # | Question | User answer | Consequence |
|---|---|---|---|
| 1 | Rotate the exposed Haravan credentials? | **Declined** ("không cần Rotate") | Recorded; do not rotate; do not re-ask. Exposure stays documented. |
| 2 | Is "main terminal" the split's parent pane or an independent pane? | **The split IS a separate independent pane** (confirmed with a screenshot: bottom pane labelled `❯ Terminal (Split)`, its own Windows PowerShell, prompt `PS E:\Work\apps\F1genz_review>`) | All of M1/M2/M3 in scope. The split must be nameable as its own session, otherwise the QA cursor points at a shell not running the dev server → `DURABILITY_FAILED`. |
| 3 | Restart the app once? | **Approved** | Do it, but **only after step 1** (see section 7). |
| 4 | Approve evidence-store writes (adjudicate 108 candidates + replay regression)? | **Approved** | Approval held, **not spent**. Must not be executed before step 1. |
| 5 | Approve the OMP config change (`tools.xdev: false`)? | **Approved** | Still requires a routing precheck + immediate revert on failure. |

**Calendar/timezone:** system date at capture `2026-09-18 00:26:02 +07:00`.

---

## 3. Current state

### Git

| Field | Value |
|---|---|
| Inside work tree | `true` |
| Top level | `E:/Work/apps/AntiFan` |
| Branch | `main` |
| HEAD | `36994303cfb2dd1e34664c13c0d4c958c97a4225` |
| HEAD subject | `docs(plan): mark the success criteria against executed evidence` (2026-09-17 13:25:51 +0700) |
| Working tree | **DIRTY — 65 status entries, 18 modified, 47 untracked** |
| `git diff --stat` | **18 files changed, 1153 insertions(+), 59 deletions(-)** |

### 🔴 CRITICAL: the working tree contains at least three unrelated in-flight workstreams, none committed

This is the single most important fact in this handoff. **None of this work is the author session's.** A successor that runs `git stash`, `git checkout -- .`, or `git reset --hard` will destroy hours of another session's work. A successor that edits these files without inspecting the diffs will mix workstreams and produce an unreviewable change.

**Workstream A — capture pipeline rework (DIRECTLY OVERLAPS the plan below)**

| File | Delta | What the uncommitted diff does |
|---|---|---|
| `src/main/browser/tab-devtools-host.ts` | **+131** | Adds `NATIVE_VIEWPORT_RASTER_BOUND_MS = 4_000`, `NO_SURFACE_CAPTURE_PROBE_BOUND_MS = 8_000`, a new private `captureNativeViewportRaster(wc, …)` using Electron `wc.capturePage()` with a bounded `Promise.race`, and a no-surface branch: `captureHasNoSurface = mode === 'viewport' && !isOffscreenTarget && !nativeRasterAnswered` → `cdpBoundMs = min(boundMs, 8_000)`. I.e. **a native-raster fallback for the missing-surface case.** |
| `src/main/browser/scripts/injected-script-store.ts` | +2/−2 | **Already broadened the freeze CSS**: committed HEAD had a filtered selector excluding `menu/nav/dropdown/dialog`; the working tree now uses `*, *::before, *::after { animation-play-state: paused !important; }` with the exclusions moved onto the `transition: none` rule only. |
| `src/main/tools/browser-control-port.ts` | +1 | **Already added** `if (animation.playState === 'paused' \|\| animation.playState === 'idle') continue;` inside `CAPTURE_TIMEOUT_PROBE_EXPRESSION`. |

⇒ **Two sub-parts of the plan's step 5 and step 6 are already partially present in the working tree.** Do not re-implement them; build on them. And note the consequence in section 7: **the report's anchors for `injected-script-store.ts:192` and `browser-control-port.ts:1146` describe the WORKING TREE, not committed HEAD.** Any anchor cited from this investigation is a working-tree anchor, because the live app runs the working tree.

**Workstream B — MCP dispatch accounting + provenance UI**

`src/renderer/toolbar.ts` (+11), `src/renderer/toolbar.html` (+6), `src/renderer/toolbar.css` (+16), `test/renderer/mcp-stats-hub.test.ts` (+76), and untracked `plans/260917-0341-mcp-dispatch-accounting/**`. Adds a static `#mcpDispatchProvenance` disclosure to the MCP Dispatch tab — deliberately static markup, never a payload field. Belongs to a different plan.

**Workstream C — site-clone / parity generator**

The bulk of the diff: `packages/site-clone/src/generators/independent-html-clone-generator.ts` (+407), its test (+190), `control-state-journeys.ts` (+96), `asset-localizer.ts` (+71), `asset-harvester.ts` (+21), `models.test.ts` (+26), `index.ts` (+1), plus untracked `scripts/verify-clone-parity.cjs`, `scripts/visual-parity.cjs`, `html-parse-fidelity.ts`, and ~15 untracked `plans/reports/clone-parity-*.json`.

**Also untracked and relevant:** `src/main/tools/adapters/tree-walker-sanitizer.ts` is *modified* (+38) while `scripts/materialize-surface.cjs` (+45) and `scripts/test-clone-features.cjs` (+65) are modified. Plus scratch debris at repo root: `.tmp-*.cjs` (8 files), `afftest.diff`, `bridge.diff`, `nth.diff`, `_verify/`.

**Untracked from the author session (safe to keep, do not delete):**
- `plans/reports/260918-0040-antifan-weakness-audit-and-remediation.md`
- `plans/reports/brainstorm-260917-2302-mcp-usage-counter-core-health.md` (pre-existing)

### Data and artifact locations

| Thing | Path | State |
|---|---|---|
| Data root | `E:\Work\.antifan-data` (via `ANTIFAN_DATA_ROOT`) | live |
| **Verification register (AT RISK)** | `E:\Work\.antifan-data\issues\verification-register.jsonl` | **1,831,100 B, 1,000 lines, 996 distinct ids, 0 unparseable**, mtime `2026-09-17T13:22:53.7156255+07:00` |
| **Protective backup (created by author)** | `E:\Work\.antifan-data\issues\verification-register.jsonl.bak-260918-guard-pending` | **1,831,100 B, 1,000 lines — byte-length identical to source**, created `2026-09-18 00:26` |
| Issue register | `E:\Work\.antifan-data\issues\issue-register.jsonl` | 81,348 B |
| Cookie jar (live) | `E:\Work\.antifan-data\Profile\Partitions\profile-profile-2\Network\Cookies` | 557,056 B, being written |
| Dead namespaces | `E:\Work\.antifan-data\Profile\Partitions\` | **84 dead**: 43 `capsule-capsule-*` + 41 `profile-capsule-*`, both families frozen `2026-09-05T19:37:17` |
| Migration marker (blocks re-run) | `…\Partitions\Config\antifan-migration-capsule-to-profile.done` | `"migrated": 12890, legacyPartitions: 41` |
| Invocation ledger | `E:\Work\.antifan-data\control-plane-v2\invocations` | 1,046 files |
| Hook evidence | `.canary/core-bridge/events.jsonl`, `.canary/hook-probe/**` | live rows, newest `2026-09-17T06:05:46.821Z` |

### Prior handoff artifacts (do not overwrite)

- `plans/handoffs/terminal-sidebar-sleep-cls-conpty-perf-20260915-1705.md` (34,581 B, mtime 2026-09-15 17:07) — a different, earlier handoff. **This artifact does not collide with it.**
- Legacy scan `plans/reports/handoff-*.md` → none found.

---

## 4. Decisions and rationale

### 4.1 Adjudicated verdict: the register guard ships first

Five independent candidates each nominated a different "one change". An independent verifier rejected all five as the *first* move and ordered **the verification-register fail-closed guard** first, on the criterion **irreversibility × precondition**.

Mechanism (verified in source by the verifier, independently of the author):

- `listVerifications` (`src/main/session/issue-register.ts:843`) reads only `this.verifications`, and with `options` undefined applies **no filter** — so the live `totalCount:0` is proof that the in-RAM array is **empty while disk holds 1,000 records**.
- `:737`, `:892`, `:928` all funnel into `rewriteVerificationsFile` (`:945-958`), which serializes **that empty array wholesale** via temp file + `renameSync`, with **no emptiness guard**.
- The array is populated exactly once, in the constructor (`:291`, `:295-305`, `:329-343`), and never reloaded.

⇒ **The next `record_claim` / `verify_claim` / `update_verdict` atomically replaces 1,000 verdicts / 1.83 MB with an empty file.** Probability ≈ 1. Every other fix is accepted through this same subsystem, which is why it is a precondition and not merely a cheap win.

### 4.2 The five rejected "one change" picks

| Pick | Content | Ruling |
|---|---|---|
| A | Add freeze to the full-page path + make `requireMediaFreeze` a live gate | **WRONG**, and actively harmful first. Causal premise false; it is a strict subset of E. |
| B | Type the drain throw at `tab-devtools-host.ts:683` | **RIGHT but mis-ordered.** Removes zero measured failures (it relabels). Its real value is restoring the failure taxonomy before the histogram is used as the instrument. Lowest risk of all five. |
| C | `tools.xdev: false` | **RIGHT but mis-ordered; load-bearing premise unproven.** Largest measured eliminable class (41) but the downside is unbounded. |
| D | Register disk-truth + fail-closed guard | **✅ THE FIRST MOVE.** |
| E | Capture cluster as a mechanism-complete pair/triple | **RIGHT but mis-ordered — and it is the correct CONTENT of the capture work.** Supersedes A. Only capture pick not blocked by the WAAPI unknown. |

**Omission all five shared, and the largest measured class:** `TARGET_MISMATCH` **91** + up to `TARGET_STALE` **21** = **112** — larger than C's 41 and B's 34. Traced exactly: `src/main/tools/browser-capabilities.ts:1953` passes `params?.all === false ? context.browserTarget : undefined`, so the default never reaches the only marker site, `src/main/tools/browser-control-port.ts:1528`, contradicting the tool's own description at `:1944`. Ordered at **step 2**. Note `:269`/`:1106` use the *inverted* default — **three list tools, two semantics.**

### 4.3 Two recommendations the author and two candidates made that the verifier REVERSED

Recorded here so the successor does not re-introduce them:

1. **"Make `requireMediaFreeze` a hard gate" can BREAK currently-working captures.** `StabilityPolicyEvaluator` appears **only in its own file** (`src/main/verification/stability-policy.ts`) — zero production consumers — and `:91-98` returns `ready:false, reason:'MEDIA_ACTIVE'` whenever media is not frozen. Wiring that as a hard gate onto a mechanism **proven incapable** of freezing WAAPI (see 4.4) means WAAPI spinner/pulse pages return `MEDIA_ACTIVE` **forever**. Enable that gate **only after** steps 5 and 6 work.
2. **"Adding freeze to full-page explains the settle failures" is false.** The sole `acquireMediaFreeze` call site is the **viewport** path (`browser-control-port.ts:2255`), where the freeze **already ran** — and the 16 settle failures were produced there anyway. A missing freeze cannot explain them.

### 4.4 Resolved from code structure, no live probe needed

**The media freeze cannot stop a WAAPI/JS animation.** `src/main/browser/scripts/injected-script-store.ts` freeze touches exactly three mechanisms — `el.pause()` (`:104`), SVG `pauseAnimations()` (`:109`/`:114`), and one CSS rule (`:192`) — and contains **no `getAnimations` call**. Therefore an infinite animation still `running` after `animation-play-state: paused` applied is definitionally WAAPI, and the app's own shipped remedy string — `CAPTURE_TIMEOUT … Remedy: anti.media.freeze(tabId) then retry` (`browser-control-port.ts:2211`) — is **provably capable of lying** for that class. Fix must do both halves: classify by `constructor.name`, then pause WAAPI.

Useful: the census **already** calls `document.getAnimations()` (`:1138`) and (in the working tree) already skips `paused`/`idle` (`:1146`). So step 5 is smaller than it looks — it is class naming plus branching `diagnosis.remedy` at `:2226`. A WAAPI-infinite classifier to copy already exists in-repo at `browser-control-port.ts:339-352`.

### 4.5 Split terminal: independent pane (user-confirmed)

The split is a **separate independent shell**, not a view of its base. Transport is fine: `terminal-manager.ts:1879` filters `!s.splitOf` and attaches the split as `splitSessionId` at `:1897`. The renderer looks up the raw split id in a wrap list keyed by base id (`src/renderer/standalone.js:3216-3217` against `:3285`), so the activity update silently returns.

### 4.6 Non-goals (explicitly decided against)

Any model/daemon inside AntiFan · a Haravan MCP surface · real CDN upload or a persisted CDN-link map · cookie-persistence rework (the symptom is cross-registrable-domain SSO, not jar loss) · CHIPS `partitioned` · per-tab audio mute · OSC 7/1337 as the cwd mechanism · unifying the two settle gates · auto-rebind · a corpus-wide uncertainty level · reviving S1–S5.

---

## 5. Work performed

**Method.** Read-only investigation only. Batch pre-flight reads, targeted greps, live MCP probes against the running app, and streaming Node miners over the session JSONL corpus (PowerShell `Select-String` over 36 MB of JSONL timed out at the 120 s cap and was replaced).

**Files created by the author session (all new; none overwrote an existing path):**

1. `plans/reports/260918-0040-antifan-weakness-audit-and-remediation.md` — the main report, edited ~20 times as each adversarial candidate landed.
2. `scratch/antifan-weakness-evidence-packet-260917.md` — frozen evidence packet.
3. `E:\Work\.antifan-data\issues\verification-register.jsonl.bak-260918-guard-pending` — **protective backup** of the at-risk register, created only because the source path did not already exist at the destination.
4. `plans/handoffs/antifan-weakness-remediation-20260918-0026.md` — this artifact.

**Representative commands executed (all read-only except the backup copy):**

- `git rev-parse --is-inside-work-tree|--show-toplevel|--abbrev-ref HEAD|HEAD`, `git status --short`, `git diff --stat`, `git diff -- <file>`, `git show HEAD:<file>`
- `Copy-Item` of the register to the `.bak-260918-guard-pending` path, then `Get-Item` + `Measure-Object -Line` on both to prove byte-length and line-count identity
- Recursive scan of `E:\Work\.antifan-data\control-plane-v2\invocations` (1,046 files) for error-code frequency
- Streaming Node miners (`scratch/omp-session-mine.cjs`, `omp-session-mine2.cjs`, `omp-user-msgs.cjs`, `session-mine-s5.cjs`) over 18,828 session records / 71.5 MB
- Live MCP calls: `anti.browser.tabs.list` (`all:true` and `all:false`), `anti.verification.list`, cookie/session probes on the bound tab

**Meaningful measured outputs:**

- Live register read returned **`{"totalCount":0,"verifications":[]}`** while the disk file held 1,000 records — reproduced twice. All path/key hypotheses excluded (single file; `ANTIFAN_DATA_ROOT` set; no fallback root; no drive-relative directory; the writer does set `id`). Mechanism: construction-time staleness, with **6 live `antifan-agent.cjs mcp` instances, 3 of them predating the 13:22:53 mtime**.
- `anti.browser.tabs.list` with `all:true` (the default) returned 3 tabs with **no** `isBoundTab`; `all:false` returned exactly 1 tab with `"isBoundTab":true,"isPrimaryTab":true`.
- Session corpus: 6,536 tool executions, **605 errors = 9.3%**. Error codes: EXECUTION_TIMEOUT 107, TARGET_MISMATCH 91, CAPTURE_TIMEOUT 91, NO_RENDER_SURFACE 85, CAPABILITY_ERROR 67, TARGET_BUSY_DRAINING 34, TARGET_STALE 21, INVALID_ARGUMENT 18, ANTIFAN_SINGLE_INSTANCE_LOCK 18, CAPTURE_NOT_READY 14, SURFACE_DEAD 13, ENOENT 11, LEASE_EXPIRED 9, RESOURCE_FAILURE 8, TARGET_OBSCURED 4. Per-tool: `anti.screenshot.viewport` 62/80 = **77.5%**, `anti.screenshot.full_page` 11/14 = **78.6%**, `theme.qa_validate` 32/70 = **45.7%**.
- `xd://mcp__antifan` occurs **2,257×** in one session; every AntiFan call is `toolName:"write"`.

**Redactions applied: 0.** No credential value was ever read, printed, or copied into any artifact. One on-disk exposure is documented by location only in section 7.

**Explicitly NOT done:** no code edit, no test run, no `npm run` invocation, no commit, no stash, no app restart, no evidence-store write, no migration, no partition deletion.

---

## 6. Verification

### Verified live (Tier 1)

| Claim | Method | Result |
|---|---|---|
| `tabs.list` default path omits `isBoundTab` | Two live MCP calls | `all:true` → 3 tabs, no marker; `all:false` → 1 tab, marked |
| Register exposes 0 while disk holds 1,000 | Live `anti.verification.list` ×2 | `{"totalCount":0,"verifications":[]}` |
| Register file integrity | `Get-Item` + line count on both files | 1,831,100 B / 1,000 lines, both identical |
| Backup is a true copy | Byte-length + line count comparison | identical |
| Cookie jar is alive and logged in | Live probe of bound admin tab | `hasPasswordField:false`, `hasLoginForm:false`, `redirectedToSso:false`, 14 visible cookies, dashboard body present |
| Hook actually runs | `.canary/core-bridge/events.jsonl` | real `BRIDGE_CONTEXT_SEEDED` rows with live `packId` + `claimCount:15` |
| Drain → mislabel path exists | Source read of both sides | confirmed (see caveat below) |

### Verified structurally (source read, not executed)

- The media freeze's three mechanisms, and the **absence** of `getAnimations` → cannot stop WAAPI.
- `toCaptureError` maps the drain message to a typed `CaptureError('TARGET_BUSY_DRAINING')` (`tab-devtools-host.ts:1131-1138`) and **is applied** on the CDP capture path at `:2140`.
- `StabilityPolicyEvaluator` has zero production consumers; `requireMediaFreeze: true` is consumed only by `test/unit/semantic-evidence-and-guardrails.test.ts`.
- `terminal.*` capabilities are registered unconditionally (`src/main/control-plane-runtime.ts:215`) but absent from the OMP proxy table `scripts/antifan-omp-mcp.cjs`; `scripts/check-mcp-budget-dominance.mjs:259-268` enforces completeness **only for `core.*`**, so this passes `npm run compile` silently.

### ⚠️ Not verified / corrections the successor MUST re-check before editing

1. **"The `.code` branch at `browser-control-port.ts:1933-1934` is dead code" is IMPRECISE and must not be relied on.** The working-tree code is `const code = err instanceof Error && 'code' in err ? String((err as { code?: unknown }).code) : undefined; if (code === 'TARGET_BUSY_DRAINING') throw err;`. That branch **works for any typed error**, and `toCaptureError` already produces one on the CDP path. The mislabel therefore survives only where a drain error escapes **untyped** — the suspicion is `tab-devtools-host.ts:1214-1221` `probeRenderSurface`, which calls `sendCdpCommand` directly and bypasses `toCaptureError`. **Re-verify that specific bypass before changing `:683`;** the minimal consistent fix may be to route `probeRenderSurface` throws through `toCaptureError` (mirroring `:2140`) rather than to attach a code at the throw site.
2. **Every line anchor from this investigation is a WORKING-TREE anchor.** `injected-script-store.ts:192` and `browser-control-port.ts:1146` describe uncommitted WIP. Committed HEAD differs. Re-anchor after reading `git diff`.
3. **The `NO_RENDER_SURFACE` split (85 occurrences) is unclassified.** Do not close the item on those 85 until step 3 lands and they can be sorted into genuine 0×0 surface vs absorbed drain.
4. **WAAPI vs CSS keyframes for the live page is unresolved.** It is settled only for the *message's* validity (4.4), not for any specific page. One live `evaluate` returning `getAnimations().map(a => a.constructor.name)` decides it.
5. **Whether `terminal.*` is advertised in the live profile is unresolved.** Assume unadvertised and drive the terminal work through the preload diagnostics handler (`native-tab-host.ts:1629-1634`), which does not depend on MCP advertisement.

### Checks NOT run and why

- `npm run test:fast`, `npm run compile`, `npm run accounting:mcp-dispatch` — **not run**: this session made no code change, so there was nothing to verify, and running the compile/budget gates against a dirty working tree containing three other workstreams would produce misleading attribution.
- No app restart (see section 7 for the ordering reason).
- No evidence-store write (approval held deliberately).

### Known flaky / misleading behaviour

- `ANTIFAN_SINGLE_INSTANCE_LOCK` (18) and `SURFACE_DEAD` (13) appear in the corpus but are **not** AntiFan production tokens — do not chase them as AntiFan defects.
- The 34 INCONCLUSIVE verification records are a `completeness=EMPTY` STALE-barrier class, not hidden theme failures. `actor:'user'` records: 0 of 1,000.

---

## 7. Open risks and blockers

**R1 — 🔴 ARMED DATA-LOSS PATH (P0, live now).** As section 4.1. One ordinary tool call destroys 1,000 verdicts. Mitigated only by the backup at `verification-register.jsonl.bak-260918-guard-pending`. **Do not let anything write to the register before step 1.** In particular, **the tempting discriminator — "call `record_claim` then `list` in the same turn" — IS the trigger.** The author did not run it; do not run it.

**R2 — 🔴 Dirty working tree with three unrelated workstreams.** Any blanket VCS command destroys other sessions' work. Pre-flight: read `git diff -- src/main/browser/tab-devtools-host.ts`, `git diff -- src/main/browser/scripts/injected-script-store.ts`, `git diff -- src/main/tools/browser-control-port.ts` **before** touching those files, and keep your change attributable.

**R3 — 🟠 `tools.xdev: false` can sever the entire control plane.** The assumption that turning xdev off restores an equivalent native `mcp__antifan` route is **unproven**. If false, 2,257 calls/session become dead — bounded benefit (41 retries) against unbounded downside. Mandatory: routing precheck on a **scratch profile**; **revert immediately** if one native call fails. Also unresolved: whether OMP reads `~/.omp/agent/settings.json` at that path, and whether it needs a restart. Note the fix is outside the AntiFan repo and its effect is **not witnessable in-product** — it can only be accepted from session logs.

**R4 — 🟠 `requireMediaFreeze` gate can break working captures.** See 4.3.1. Enable only after steps 5 and 6.

**R5 — 🟠 `hrv` sync barrier attests text, not transport.** `src/main/qa/haravan-sync-barrier.ts:102` acknowledges success by matching a regex over terminal output. That is an attestation of text, not a receipt that a dev server is up. `WATCHER_SLEEPING` must stay fail-closed.

**R6 — 🟠 `terminal.*` advertisement gap blocks observability of the terminal work.** Registered in code, absent from the OMP proxy table, and the completeness gate enforces only `core.*`. Consequence: **fixing the split-pane projection alone changes nothing the agent can observe**, because the agent cannot call any terminal tool. Advertising is a hard prerequisite for the terminal and hrv-barrier steps.

**R7 — 🟡 Credential exposure on disk, user declined rotation.** The session transcript `C:\Users\Admin\.omp\agent\sessions\--E--Work-apps-F1GENZ_Review--\2026-09-17T03-29-59-591Z_01a0ad69-fd27-74f1-9490-753534569350.jsonl` contains live Haravan `access_token`/`refresh_token` in plaintext at **line 2555** for orgid `200001195350`, with `client_secret`-class material near lines 1442/1454. **Values were never read or copied by this session.** The file was **not** modified (destructive; requires approval). The user declined rotation. This is a structural risk of logging all tool output, not a one-off. Do not re-litigate; do surface it if a future session logs the same class of secret.

**R8 — 🟡 Restart ordering.** The user approved an app refresh. **Do it only after step 1.** A fresh process loads 1,000 records from disk at construction, which defuses the gun for the answering process — and then the restart doubles as the decisive confirmation that the diagnosis is construction-time staleness. Restarting first leaves the old empty-array process able to overwrite.

**R9 — 🟡 Approval held, not spent.** Evidence-store writes are approved but must not run before step 1, because `:737/:892/:928` all funnel to the wholesale rewrite. A user directive cannot waive a Level-0 safety invariant.

**R10 — 🟡 Nine live process instances.** 6 `antifan-agent.cjs mcp` instances were observed (PIDs 27828, 15076, 3288, 26428, 34192, 8908), plus later ones. Each is a construction-time snapshot and a potential writer. Prefer one instance; do not start more without reason.

**R11 — Circuit breaker.** Per `AGENTS.md`, if 3 consecutive tool calls fail to advance state, STOP and flip to `BLOCKED` rather than retrying variations.

---

## 8. Exact next actions

Order is adjudicated and mandatory. Each step has one binary acceptance probe. Steps 1–4 are independent of the capture cluster; step 1 MUST be first.

**Mandatory pre-flight for every step:** `read` the target file's fresh working-tree content, and run `git diff -- <file>` first. Never guess a line number from this document — every anchor here is a working-tree anchor that may have moved.

### ✅ **First safe step** — Step 1: register disk-truth + fail-closed guard

- Files: `src/main/session/issue-register.ts` — `listVerifications` (`:836-861`) must read disk truth; `rewriteVerificationsFile` (`:945-958`) must **refuse** when the in-RAM array is empty AND the on-disk file is non-empty, throwing the **already-built typed** `DURABILITY_FAILED` (constructed at `:955-957`). Skip an unparseable trailing line. Report a true `registerTotal`.
- Constraint: **prove the guard on a COPIED FIXTURE IN A TEMP DIR — never against the live register.**
- Probe: unfiltered `anti.verification.list` returns `>0` **equal to the on-disk JSONL record count**, and the register file's **byte length is identical before and after** the call. Guard fixture: typed refusal raised, fixture byte length unchanged.

### Step 2: `tabs.list` marks the bound tab on the DEFAULT path

- Files: `src/main/tools/browser-capabilities.ts` (~`:1953`) — thread the bound tabId into `listTabs`; `src/main/tools/browser-control-port.ts` (`listTabs`, ~`:1514-1530`) — mark it in the whole-window branch. Also reconcile `:269`/`:1106`, which use the inverted default.
- Probe: **one no-argument** `anti.browser.tabs.list` returns N tabs with **exactly one** `isBoundTab:true`, equal to the id returned by `all:false`.

### Step 3: truthful drain failure code

- Files: `src/main/browser/tab-devtools-host.ts` (`probeRenderSurface` `:1214-1221`, and/or the throw at `:683`); `src/main/tools/browser-control-port.ts` (`:1933-1934`).
- **Re-verify first** per section 6 caveat 1 — `toCaptureError` already exists and is already applied at `:2140`, so the minimal consistent fix is likely to route the bypassing path through it.
- Probe: an induced drain surfaces **code** `TARGET_BUSY_DRAINING`, and no `TARGET_BUSY_DRAINING` message is ever paired with code `NO_RENDER_SURFACE`. **Assert the code, not the message.**

### Step 4: `tools.xdev: false` behind a routing precheck

- Outside the repo (`~/.omp/agent/settings.json`, which does not currently exist).
- Probe: with xdev off, **one native `mcp__antifan` call succeeds** AND the session error log contains **zero** `expects a JSON args object as content`. **Revert immediately if the native call fails.**

### Step 5: census class naming + remedy branching

- `browser-control-port.ts` — `CAPTURE_TIMEOUT_PROBE_EXPRESSION` (`:1124-1151`) and `diagnosis.remedy` (`:2226`). The paused/idle skip is already in the working tree. Copy the WAAPI-infinite classifier from `browser-control-port.ts:339-352`.
- Probe: on a WAAPI-infinite fixture the settle diagnosis reports class `Animation` (not `CSSAnimation`) and its remedy string does **not** contain `media.freeze`.

### Step 6: pause WAAPI inside the freeze

- `src/main/browser/scripts/injected-script-store.ts` — the CSS rule is already broadened in the working tree; add an `Animation.pause()` path scoped to the capture window, released by the existing guaranteed `finally` (`browser-control-port.ts:2277-2283`). No `force` bypass. Bump the capture receipt policy identity — **freeze changes pixels**, so never compare baselines across it.
- Probe: post-freeze census `infiniteAnimations: 0` while the animation object still exists as paused, and it is running again after release.

### Step 7: full-page freeze, and only now consume `requireMediaFreeze`

- `screenshotFullPage` (`:2315`) → `captureFullPageEnvelope` (`:2342`). `acquireMediaFreeze` currently has exactly one call site (`:2255`) — the viewport path. Only now is `MEDIA_ACTIVE` reachable by a correct mechanism.
- Probe: one `anti.screenshot.full_page` on the WAAPI fixture succeeds with a non-empty artifact AND capture telemetry records `isMediaFrozen:true` at raster time.

### Step 8: terminal + hooks

- Split: renderer wrap lookup (`src/renderer/standalone.js:3216-3217`, wraps keyed by base id at `:3285`) → `SessionSummary` split fields (`terminal-manager.ts:399-421`; `splitOf` already exists in `TerminalSessionDiagnostics:435`) → make the split claimable (today every resolver refuses it: `:2240`, `native-tab-host.ts:5870-5871`, `:6642`, `:6661-6662`, `:6688-6692`). Then the `hrv theme dev` recognizer feeding the **existing** `haravan-sync-barrier` (do not build a second binding).
- Hooks: bind `agent_end` / `turn_end` / `session_shutdown` in the **existing, running** `.omp/hooks/pre/antifan-core-bridge.ts`. Do **not** build a new bridge — it already does task-hash dedupe and spawns the core CLI. Only those three events are unbound.
- Probe: while `hrv theme dev` runs in the split, the main tab's indicator is lit and the `split-N` diagnostics row shows `splitOf` set with a `lastSeq` that grows across two reads 5 s apart. Hook probe: after one completed turn, `.canary/core-bridge/events.jsonl` gains exactly **one** row per newly bound event and **zero** duplicates on re-entry.

### Deferred — requires explicit human approval, not orderable yet

- Cookie SSO + the 84 dead namespaces. Its only acceptance probe (a third-party OAuth install completing without the `accounts.haravan.com` card) needs a **live remote write**; namespace reaping is a **destructive store write**. Separately, the silent-loss path is real and code-level: `profileId: 'capsule-<uuid>'` → `getSharedProfilePartition` sanitises then prefixes `profile-` → resolves to `persist:profile-capsule-*`, hydrates "successfully", and no tab reads it. Guard both the validator and the resolver.
- H1/H2/H3 (adjudicate the 108 pending candidates, replay the regression, seed the two zero-claim platforms). Approved but held behind step 1. `core.candidates` (needed before H1) is a **new MCP surface** and requires `npm run accounting:mcp-dispatch` — that gate, not approval, is what blocks it.
- The bridge master-token direct-RPC bypass (`src/main/browser/bridge-server.ts:1896-1909`, P0, present in six sections of a prior architecture review) is **still open** and out of scope for this order.

---

## 9. Source pointers

**Primary artifacts**

- Full report: `plans/reports/260918-0040-antifan-weakness-audit-and-remediation.md`
- Frozen evidence packet: `scratch/antifan-weakness-evidence-packet-260917.md`
- Protective register backup: `E:\Work\.antifan-data\issues\verification-register.jsonl.bak-260918-guard-pending`
- Prior unrelated handoff: `plans/handoffs/terminal-sidebar-sleep-cls-conpty-perf-20260915-1705.md`
- Related in-flight plans: `plans/260917-0341-mcp-dispatch-accounting/**`, `plans/reports/brainstorm-260917-2302-mcp-usage-counter-core-health.md`
- Bottleneck ledger: `plans/bottlenecks.json` (open: B19, B20, B21, B23, B29, B33)

**Product source anchors (working-tree line numbers — re-anchor after `git diff`)**

- `src/main/session/issue-register.ts` — `:288` class, `:296-302` path, `:329-343` `loadInitialVerifications`, `:800-822` `recordVerification`, `:836-861` `listVerifications`, `:945-958` `rewriteVerificationsFile`
- `src/main/tools/browser-control-port.ts` — `:584`/`:670-672` lease, `:885-891` capture deadline, `:1124-1151` census, `:1928-1948` render-surface read, `:2198`/`:2211`/`:2226` settle diagnosis, `:2255` sole `acquireMediaFreeze`, `:2272-2284` finally discipline, `:2315`/`:2342` full-page, `:2987-3017` openTab quota, `:6891-6942` target validation
- `src/main/browser/tab-devtools-host.ts` — `:683` drain throw, `:736` 60 s cap, `:1131-1141` `toCaptureError`, `:1214-1221` `probeRenderSurface` (bypass suspicion), `:2140` typed rethrow
- `src/main/browser/scripts/injected-script-store.ts` — `:104`, `:109`/`:114`, `:192`
- `src/main/tools/browser-capabilities.ts` — `:435-454` `browser.wait`, `:1944` `isBoundTab` promise, `:1953` inverted default; `src/main/tools/capability-catalogue.ts:581-650`; `src/main/tools/capability-transport.ts:1085-1086`
- `src/main/browser/terminal-manager.ts` — `:399-421` `SessionSummary`, `:435` `splitOf`, `:1879-1899` base-only + split attach, `:2240` split refusal
- `src/renderer/standalone.js` — `:1558-1561` reset+replay, `:1820-1831` main terminal, `:3215-3217`/`:3285`/`:3871`/`:4050` split projection
- `src/main/diagnostics/core-health.ts` — `:181-186` `worstOf`, `:194` `ALL_GATES_PASSED`, `:448-462` uncertainty
- `packages/super-core/src/index.ts` — `:942-953` audit INSERT, `:1047-1051` gate INSERT, `:1079-1081` first-failing-gate only + `ALL_GATES_PASS`, `:1089-1092` hardcoded UNKNOWN
- `src/main/browser/native-tab-host.ts` — `:1282-1288` vault, `:3208` list hides offscreen/ephemeral, `:3352-3370` partition validator, `:3430-3432` migration marker, `:3479-3500` flush, `:3685` flush on every `did-finish-load`, `:5870-5871` split not claimable, `:6093-6124` managed ids
- `src/main/browser/bridge-server.ts` — `:1896-1909` master-token bypass (open P0)
- `.omp/hooks/pre/antifan-core-bridge.ts` — running bridge; `session_start` `:656`, `before_agent_start` `:669`, `context` `:751`, `session.compacting` `:779`, `tool_call` `:800`
- `C:\Users\Admin\.omp\agent\hooks\post\theme-qa-gate.ts` — the only user-scope hook

**Evidence logs**

- `.canary/core-bridge/events.jsonl`, `.canary/hook-probe/**`
- `E:\Work\.antifan-data\control-plane-v2\invocations` (1,046 files)
- Session transcripts (mined, never modified): `C:\Users\Admin\.omp\agent\sessions\--E--Work-apps-F1GENZ_Review--\2026-09-17T03-29-59-591Z_01a0ad69-fd27-74f1-9490-753534569350.jsonl` (**credential exposure at line 2555 — see R7**), `...--E--Work-customizes-Bagamuioto--\2026-09-17T06-20-24-218Z_01a0ae06-011a-7174-8e3e-586905f2a149.jsonl`, `...--E--Work-customizes-Comnieusiba--\2026-09-16T11-17-02-525Z_01a0a9ef-39bd-75d6-9297-9e811b2063de.jsonl`

**Gates and commands**

- `npm run compile`, `npm run test:fast`, `npm run smoke:omp-closed-loop`, `npm run soak:omp`, `npm run accounting:mcp-dispatch`, `npm run audit`

**Governing contracts**

- `AGENTS.md` (Level 0 Root Contract v1.2.0), `CLAUDE.md`, `docs/haravan/cli-operations-and-guards.md`, `CLAUDE-PARITY.md:11` (spawn-per-event hook removed after 30 s timeouts — do not reintroduce)

---

### Continuation instruction

```
Read E:\Work\apps\AntiFan\plans\handoffs\antifan-weakness-remediation-20260918-0026.md and verify the
Current state section against the repo (git HEAD, git diff, and the dirty-tree workstreams) before acting.
Step 1 is mandatory first: the verification-register fail-closed guard. Do not run any write to the
verification register — including the record_claim-then-list discriminator — before that guard lands.
```

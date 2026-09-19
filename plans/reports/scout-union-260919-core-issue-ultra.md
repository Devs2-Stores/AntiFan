# Scout Report — AntiFan Core Issue audit (`--ultra`)

Date: 2026-09-19 · Repo: `E:\Work\apps\AntiFan` · HEAD: `ea6cecb9` (2026-09-19 23:10 +0700)
Method: `ak:scout --ultra` — one immutable evidence packet, five independent read-only scout
candidates in a single wave, one strongest-model verifier, union finalizer (the verifier
adjudicates each item and drops citations it cannot reproduce; it never picks one candidate
wholesale).

Request: "Đọc toàn bộ Core Issue hiện tại xem có gì cần Fix ko".

## 0. What "Core Issue" resolved to

No file in the tree is literally named "Core Issue". Three live surfaces carry the repo's current
core issues, and all three were audited:

| surface | what it is | writer |
|---|---|---|
| `plans/bottlenecks.json` + `scripts/check-bottlenecks.mjs` | machine-checkable closure ledger, 37 rows B1–B33/R1–R4 | hand-maintained; predicates machine-evaluated |
| `.canary/CORE-BOTTLENECKS.md` (415 lines) | measured findings F1–F10 for the core browser/MCP path | probes, committed at `e1314c3` |
| `E:\Work\.antifan-data\issues\issue-register.jsonl` (279 records) | the running app's own issue register | `src/main/diagnostics/crash-report-intake.ts`, `src/main/session/issue-register.ts` |

Ledger state at HEAD, as printed by the checker: `37 row(s): CLOSED=25 REFUTED_OK=4 MANUAL=6
OPEN=2` → `OK — every declared status matches HEAD`, with `warn STALE` on B19, B20, B21, B29.

## 1. Verdict — what actually needs fixing

**One live code defect.** `B33` is the only item at HEAD where a machine predicate fires *and* the
behaviour is wrong.

**Five ledger/hygiene corrections** (the registry is the thing that is stale, not the code):
B19 and B20 describe defects that no longer exist and should be closed; B21's evidence is stale and
its predicate must be re-scoped; B29 is verified behaviour-preserving and can be closed; B23 is
code-complete and blocked only on external prerequisites.

**Two register-contract defects** in the running app's issue pipeline (found in the union, not in
the original packet; reproduced by the controller — see §5).

**One unmitigated native crash** (GPU process) among four recorded P0 deaths.

## 2. Group A — ledger rows the machine checker cannot settle

| item | verdict | evidence | needs fix? | minimal fix + owner file |
|---|---|---|---|---|
| B19 | `FIXED` | `.canary/tools/canary-settle.mjs:18-21, 592-598`; `scripts/lib/settle-contract.mjs:29-37` — the gate is `composeSettleVerdict` = mediaFrozen ∧ fontsSettled ∧ imagesSettled ∧ visualStable ∧ renderStateStable, called with `{freezeOk, images, visual, state}`; the childList churn expression (`:108-117`) is recorded as evidence only ("Raw churn stays evidence: it is recorded, never a gate input") | No (code) · **Yes (ledger)** | Set the row to `closed` in `plans/bottlenecks.json`; replace the `manual` predicate with a `file-regex` on `composeSettleVerdict({ freezeOk, images, visual, state })` so it cannot go stale silently |
| B20 | `NOT-A-DEFECT` | `src/main/verification/visual-capture.ts:703` (`CAPTURE_MAX_DIMENSION = 16384`); `src/main/browser/tab-devtools-host.ts:2044-2049, 2131-2135` throw a typed over-ceiling error. No tiled composite or main-thread composition helper exists anywhere in the capture path (grepped) | No (code) · **Yes (ledger)** | Close the row; if the 16 384 px capability limit is to be tracked, open a feature row instead — the "degrades to a tiled composite" description is false at HEAD |
| B21 | `MANUAL-STALE` | controller count at HEAD: **1** `*.png` (`screenshot20260913150514.png`), **14** `*.md`, **92** `.tmp-*` entries, **3** `*.diff`, **0** `*.log` (root = 121 entries) | Yes (hygiene) | Re-scope the row from "57 .png, 14 .md" to the `.tmp-*` pile; purge `.tmp-*`/`*.diff` and move the 12 historical reports to `reports/`. Owner: root of `plans/bottlenecks.json` + a clean script |
| B23 | `BLOCKED-ON-EXTERNAL` | `scripts/run-theme-harness.mjs` implements the L0/L1/L2 gate and reports `BLOCKED` naming prerequisites rather than simulating a pass; `scripts/check-bottlenecks.mjs` flags `.canary/15-pages/_verdicts.json` (`finishedAt: null`, `exit null`, 24 unbound adjudicated cases) | Yes (operational only) | No code change. Requires `.hrv-sync-state.json` (bound hrv theme dev watcher) and `THEME_PUSH_APPROVED=1`, then `npm run harness:theme -- --layer live-published` / `--layer gated` |
| B29 | `FIXED` | `node scripts/check-mcp-budget-dominance.mjs` → 20 shadowing rows; `node --test test/unit/mcp-core-parity.test.mjs` → 0 divergent rows (the 20th row, `anti.agent.cursor.move` binding `agentHover`, was the one real divergence and is fixed) | No (code) · **Yes (ledger)** | Close the row, or leave it open only as the "retire the 20 redundant aliases" backlog item it now is |
| R2 | `REFUTED` (holds) | baseline `.canary/15-pages/page-02-brands/evidence/1440.json` passed with `structuralMutations: 0`; the B19 decoupling means churn can no longer invalidate the gate | No | None; refresh `lastVerifiedAt` |
| R3 | `REFUTED` (holds) | `src/main/security/security-policy.ts:133` keeps `webSecurity: true` in `getSecureWebPreferences`; applied across tab views (`native-tab-host.ts:4260, 4421, 5256`) | No | None; refresh `lastVerifiedAt` |
| B33 | **`LIVE`** | see §3 | **Yes** | `src/shared/control-plane-contracts.ts:508-511` |

## 3. B33 — the one live defect, mechanism corrected

The ledger row says a frame "persisted with `null` inside an array never re-hashes to its recorded
checksum". **That half is wrong** and the record should be corrected: `canonicalJsonStringify(null)`
returns `"null"`, which matches `JSON.stringify`, so a literal `null` array element re-hashes
correctly (the codebase already measured this — 5 live frames with literal `null` pass strict and
fail only the diagnostic variant, documented at `src/main/session/invocation-frame-checksum.ts:64-86`).

The real divergence is `undefined`:

```
in-memory frame:  [a, undefined, b]
writer hash:      canonicalJsonStringify -> "[a,,b]"     (join renders undefined as an empty slot)
persisted line:   JSON.stringify          -> "[a,null,b]"   (invocation-ledger.ts:799-804)
replay re-hash:   JSON.parse -> null ->   "[a,null,b]"   != recorded  (invocation-ledger.ts:197-203)
```

Consequence is not merely a bad checksum: `replayPartition` quarantines the **whole partition** on
the first mismatch (`invocation-ledger.ts:203-205` → `:260-271`, rename to `.quarantine-<ts>` and
`return`), so every intact frame in that file is stranded and never re-read. Measured: **8**
`.quarantine-*` partitions exist under `E:\Work\.antifan-data\control-plane-v2\invocations\`.

Minimal fix — make the canonicalizer agree with the serializer for array slots:

```ts
// src/shared/control-plane-contracts.ts:511
return `[${val.map((item) => (item === undefined ? 'null' : canonicalJsonStringify(item))).join(',')}]`;
```

Owner: `src/shared/control-plane-contracts.ts`. Behavioural half belongs in a unit test (a frame
carrying an `undefined` array slot must round-trip through persist → replay), per the row's own
`reVerifyWith`.

**Apply-time warning** (measured while annotating this row). This redefines the hash of the
persisted format, so it is a format decision rather than a local refactor, and two things follow:

- `test/unit/invocation-frame-checksum.test.mjs:110` asserts the *opposite* of the fix — that strict
  cannot reproduce an `undefined`-slot frame and only `computeFrameChecksumNullArrayVariant` can — and
  must be re-scoped to the corrected contract (strict agrees; the variant then explains only legacy
  rows already on disk). The test at `:124` must stay exactly as it is: it pins the counterexample in
  the other direction (literal `null` slots pass strict), and the fix does not map nulls to
  `undefined`.
- The 8 existing `.quarantine-*` partitions stay stranded either way. Repairing them — re-hash with
  the variant, or keep them as evidence — is a separate decision the canonicalizer change does not
  imply.

Direction of the change is safe: it only affects values `JSON.stringify` renders as `undefined`
(`undefined`, functions, symbols in array slots), whose recorded checksum could never match any
persisted line, so no currently-admitted frame flips to rejected.

## 4. Group B — `.canary/CORE-BOTTLENECKS.md` F1–F10 re-checked at HEAD

`7d0850b` (D1–D5 + bridge pin) and `e1314c3` (docs + probe scripts) are both ancestors of HEAD.

| finding | verdict | evidence | fix? |
|---|---|---|---|
| F1 bootstrap tabId unusable | `FIXED` | `src/main/bridge/bridge-server.ts:2137-2147` provisions a dedicated ephemeral tab and verifies `hostTabExists` before returning; authorization via `native-tab-host.ts:6422-6445` (`isTabAllowedForPrimary`) and `index.ts:360-362` | No |
| F2 `tabs.list` returns `[]` | `FIXED` | `src/main/tools/browser-capabilities.ts:2064-2074` — `anti.browser.tabs.list` registered with `all` default `true`, handler `scope: params?.all === false ? 'session' : 'all'`; the proxy's shadowing routing row (B28) is deleted | No |
| F3 / F3b no canonical set-viewport; success with `0x0` | `FIXED` | `browser-capabilities.ts:1080-1087` registers `anti.browser.set_viewport`; `src/main/tools/browser-control-port.ts:3847-3860` throws `VIEWPORT_NOT_APPLIED` when the observed geometry does not match; `tab-devtools-host.ts:2001` fails fast with `NO_RENDER_SURFACE` | No |
| F4 first `full_page` capture fails | `FIXED` | `browser-control-port.ts:2559` preflights `assertRenderSurface`; `tab-devtools-host.ts:2043-2075` staircase prewarm + quiescence check | No |
| F5 failed capture mutates viewport | `FIXED` | `browser-control-port.ts:2572-2615, 2693-2703`; `tab-devtools-host.ts:2365-2380` — baseline geometry recorded pre-capture and reapplied through `reapplyTabGeometry` on the failure path | No |
| F6 reference producer never materializes lazy images | `FIXED` | `src/main/verification/visual-capture.ts:780-843` + `browser-capabilities.ts:2151` — the reference capture now owns a scroll/materialization walk with `REFERENCE_MATERIALIZATION_BOUND_MS` | No |
| F7 MCP surface hangs / tab leaks | `FIXED` | `scripts/antifan-omp-mcp.cjs` one client ceiling (`DEFAULT_CLIENT_TIMEOUT_MS = 240000`) gated by `scripts/check-mcp-budget-dominance.mjs` inside `compile`; unadopted tabs are closed rather than leaked | No |
| F8 budget-abandoned capture wedged the target | `FIXED` | `browser-control-port.ts:2623-2645` — the outer gate recovers on `EXECUTION_TIMEOUT` (quarantine → drain → `reapplyTabGeometry` → typed `TARGET_BUSY_DRAINING`) | No |
| F9 15 s in-page guard vs declared 30 s | `FIXED` | `tab-devtools-host.ts:2594-2615` — `evalJs` takes the caller's `timeoutMs`; the materialization failure now reports `cause: 'eval-failed'` instead of a bound it never reached | No |
| F10 cross-instance replay | `NOT-A-DEFECT` | deliberate failover; `FOREIGN_INSTANCE_ATTACH` is emitted when a pin exists (`scripts/antifan-omp-mcp.cjs:2066`, `scripts/antifan-agent.cjs:539, 558`), and the doc records silent self-heal as accepted design | No (accepted; pin `ANTIFAN_BRIDGE_PID` when a mutating call must not be replayed) |

So Group B is settled: the prose findings F1–F9 are fixed at HEAD; only the F6 ownership map row
("reference capture capability — does not exist") is stale, and the doc's `Recommended core work`
list (items 1–6) is fully landed.

## 5. Group C — the live register `E:\Work\.antifan-data\issues\issue-register.jsonl`

279 records: OPEN 91, RESOLVED 125, BYPASSED 63. No record carries `issueClass`.

1. **The 4 P0 `runtime.process` crash rows** — written by `crash-report-intake.ts:104-160` from real
   Crashpad dumps. Rows at `electron.exe+0x684d7a8` (2026-09-16, 2026-09-17) and `+0x27340e3`
   (2026-09-16) are browser-process `STATUS_ACCESS_VIOLATION`, `read of 0x0`; the documented cause is
   native device emulation on a view that is not a child of the window, which kills the process and
   which `try`/`catch` cannot intercept (`src/main/browser/native-tab-host.ts:709-736` —
   `safeEnableDeviceEmulation` now returns early when `!this.isTabViewAttached(view)`). Those three
   are **mitigated at HEAD by inspection**. The 2026-09-18 row is a **`gpu-process`** fault at
   `+0x897d241` and is **not** addressed by that guard → still open.
2. **The other 87 OPEN rows are test-seeded fixtures, not defects.** `63×` each of
   "Trusted Type violation on docs.google.com", "Temporary network glitch", "Element obscured by
   modal overlay", plus `51×` "Layout parity discrepancy in hero section" and `16×` each of the
   drawer/cart strings; timestamps cluster in 2026-09-03…09-05. The strings are literals in
   `test/unit/semantic-aliasing-and-issue-register.test.ts:95-115` (which calls
   `IssueRegister.getInstance().record(...)`).
3. **Two register-contract defects (new, not in the packet):**
   - **No test isolation.** `IssueRegister`'s constructor resolves
     `StorageLocations.getDataRoot()/issues/issue-register.jsonl` with no override, unlike the
     verification register which honours `ANTIFAN_VERIFICATION_REGISTER_DIR`
     (`src/main/session/issue-register.ts:342-355`). Any suite that touches the singleton writes into
     the live data root — which is exactly the residue counted above. Fix: a data-root override for
     the issue register (one env var, same shape as the verification register's) plus a test default.
   - **Lifecycle invariants bypassed.** `LEGAL_ISSUE_TRANSITIONS.OPEN` admits only
     `TRIAGED | WONT_FIX | DUPLICATE | BYPASSED` (`issue-register.ts:69-72`), yet `markResolved`
     (`:704`) and `reconcile` (`:751`) assign `item.status = 'RESOLVED'` directly instead of going
     through `transitionIssue`, so `OPEN → RESOLVED` — an illegal edge — produced most of the 125
     RESOLVED rows. Fix: route both through `transitionIssue`, or state the bypass as intended in the
     contract. `BYPASSED` rows are clean (all 63 carry `workaroundApplied`).

Note: dumps are pruned to 3 (`pruneOldCrashDumps(dir, 3)` at `index.ts:121, 141`), so a P0 row can
outlive the only evidence for it — the 4 rows above now reference dumps of which 2 remain
(`5aee893c-….dmp`, `c2bbb433-….dmp` under `runtime/crashDumps/reports/`).

## 6. Ordered work list

Landed after this audit (2026-09-19): 1, 2 (recorded as a row, not repaired), 4. Still open: 3, 5, 6.

1. **Fix B33** — LANDED, but not where the row pointed. `src/shared/control-plane-contracts.ts:511`
   is the *rendering* rule, and it is load-bearing for the diagnostic variant; changing it would also
   break the attribution of the rows already on disk. The defect was the order of operations instead:
   the ledger hashed the in-memory record and then persisted a different value. Both write sites
   (`appendFrameUnlocked`, `compactPartitionUnlocked`) now hash `JSON.parse(JSON.stringify(frame))`
   through the new `computePersistedFrameChecksum` — the shape the reader reconstructs — so writer and
   reader cannot drift. Regression tests: `test/main/invocation-ledger.test.ts` tests 16 (append →
   replay admission) and 17 (compaction), each proven to fail when its own write site is reverted;
   `test/unit/invocation-frame-checksum.test.mjs` is unchanged and green. Full-suite proof:
   `npm run test:main` → `tests 1374, pass 1372, fail 0` (exit 0), where the same suite failed 16
   tests under full-suite concurrency before the fix.
2. **Corrupt-ledger recovery** — RECORDED as registry row **B34** (`open`, manual): 8
   `.quarantine-*` partitions beside 4 live ones in `E:\Work\.antifan-data\control-plane-v2\invocations`,
   newest quarantined 2026-09-19. Repair vs keep-as-evidence is a data-ownership call, so it was not
   taken unilaterally.
3. **Issue-register fixes** — RECORDED, not fixed: the live-register residue is row **B36**, the
   lifecycle bypass is row **B35**. Both are data-ownership calls (purge vs classify; document vs
   enforce), so they were not taken unilaterally.
4. **Ledger truth-up** — LANDED, machine-verified: B19, B20, B29 closed with predicates that fire if
   the defect returns; B21 re-scoped to the measured `.tmp-*` pile (purge needs an owner decision, so
   the row stays open); R2/R3 `lastVerifiedAt` refreshed; B33's `null` wording corrected to
   `undefined`; B33's predicate re-pointed at the writer. `node scripts/check-bottlenecks.mjs` →
   `42 row(s): CLOSED=29 REFUTED_OK=4 MANUAL=8 OPEN=1` → `OK — every declared status matches HEAD`,
   with no STALE warnings (counts as of the four rows recorded below, §6.3/§6.5/§9).
5. **GPU crash row** — RECORDED as row **B37**: the 2026-09-18 `gpu-process` fault still needs
   re-symbolization or an explicit accepted-with-fallback disposition.
6. **B23** — operational only: bind `.hrv-sync-state.json` + `THEME_PUSH_APPROVED=1` and run the
   live harness layers.

## 7. Unresolved

- B23 live-storefront verdict — needs a live Haravan watcher and push approval; not reachable
  read-only.
- The 4 recorded P0 dumps cannot be re-symbolized here (no Chromium PDB symbol server), so
  "mitigated" for the three browser-process rows is a source-level attribution, not a reproduction.
- Whether a *successful* `anti.screenshot.full_page` has any lazy-load side effect remains unproven —
  it needs a live run, and it is the one thing standing between the clone campaign and an
  adjudicable fidelity number.

## Appendix — ultra ranking

Five candidates, same tier; anonymized before judging. Rubric: coverage, evidence quality, verdict
correctness, signal density, honesty about gaps, fix-actionability (1-20 each).

| rank | candidate | total | rationale |
|---|---|---|---|
| 1= | B (`CandA`) | 118 | exact root counts, correct B33 mechanism, all crash signatures attributed |
| 1= | C (`CandE`) | 118 | most precise F1 seam; only blemish: timid B29 verdict despite proving 0 divergences |
| 1= | D (`CandB`) | 118 | strongest B33 quarantine chain; correct on every Group A row |
| 4 | E (`CandD`) | 110 | miscounted root `.md` (15 vs 14); classified F10 as PARTIAL against the recorded design |
| 5 | A (`CandC`) | 84 | false root inventory (claimed 11 `.md`, `vp_section.png` at root — it is under `.tmp-inspect/`), invented scope by proposing a tiled-capture implementation for B20, non-standard status vocabulary |

Rejected by the verifier and dropped from the union: candidate A's tiled-capture proposal
(scope-widening on a NOT-A-DEFECT row) and its root-inventory numbers; candidate E's F10 PARTIAL
verdict. Disagreement on B21's counts was settled by the controller's own measurement
(1 `.png` / 14 `.md` / 92 `.tmp-*` / 3 `.diff`). Verifier confidence: high.

## 8. Addendum — live render defect found while verifying (fixed)

Reported by the user first (Tier 0): a storefront section that Chrome paints black renders white in
this browser — `roahtrip.com`, the email-signup section and the whole footer group.

**Defect.** `src/main/browser/native-tab-host.ts:239-248` (`DEFAULT_CANVAS_CSS`, injected for every
pane and preset at `:3916` on `did-finish-load`) backgrounded the **root element**:

```css
:where(html) { background-color: #ffffff; }
```

An author background on `html` stops the canvas from adopting `body`'s background (CSS Backgrounds
§2.11.2 / CSS 2.1 App. E propagation). `body`'s background then paints in the in-flow block pass of
the painting order — *above* every negative `z-index` descendant, which paints in the earlier
negative-stacking pass. Shopify OS 2.0 "Horizon"-family themes put each section's color scheme on
exactly such a box (`… .section-background { position: absolute; z-index: -2 }`), so those sections
and all text colored against them render as the body background. `:where()` zeroes specificity but
says nothing about paint order, which is where this went wrong.

**Evidence** (A/B on one live document, no reload, `tabId 761961b3…`):

| state | `.section-background` | capture |
|---|---|---|
| as shipped | `z-index: -2`, `background rgb(0,0,0)` | white |
| inline `z-index: auto` | `background rgb(0,0,0)` | black |
| inline removed (back to `-2`) | `z-index: -2` | white |
| `html` background neutralized | `z-index: -2` | black — matches the Chrome reference |

Supporting probes: the only painted element over that point is `.section-background` itself (nothing
overlays it); no `contain`, `content-visibility`, `will-change`, `filter` or `mix-blend-mode` in its
ancestor chain; a forced repaint (z-toggle + body-opacity nudge) did not change the result — so this
is paint order, not a stale raster and not an overlay.

**Fix.** Fill the canvas from a zero-specificity pseudo-element of the root, pinned below all
content, so propagation stays intact:

```css
:where(html)::before {
  content: ''; position: fixed; inset: 0;
  z-index: -2147483647; background-color: #ffffff; pointer-events: none;
}
```

The docblock now records the invariant (never background the root element, and why) so the old shape
cannot be reintroduced as an "equivalent" simplification.

**Verification.** `npm run typecheck` clean; `npm run compile` chain green (emit integrity, budget
dominance, dispatch payload). Live with the new rule: `html` computes `rgba(0,0,0,0)` (propagation
intact), the fill layer is generated (`content: ""`, `rgb(255,255,255)`, `z-index: -2147483647`,
`position: fixed`), and the email section *and* the entire footer group paint black — pixel-matching
the Chrome reference. On a page with every element background stripped (`* { background-color:
transparent !important }`) the fill still yields an opaque white canvas capture, preserving the
rule's original purpose (no app chrome through unpainted regions, no transparent capture bands).

**Not verified.** The running instance keeps the old injected sheet in memory; the fix lives in
`.compiled/src/main/browser/native-tab-host.js` (loaded by `main.cjs`) and takes effect on the next
launch. Also unproven: whether the CDP capture path actually returns transparent bands for an
unpainted canvas — the negative control (fill removed, all backgrounds stripped) still captured
white, so the UA canvas is white in this engine and the rule's stated capture rationale could not be
reproduced.

## 9. Addendum — capture-timeout diagnosis mis-attributes (reported, not fixed)

`CAPTURE_TIMEOUT_PROBE_EXPRESSION` (`src/main/tools/browser-control-port.ts:1198-1204`) counts a
**paused** element that merely has `readyState > 2` as playing:

```js
const ready = typeof el.readyState === 'number' && el.readyState > 2;
if (el.paused === false || ready) { playing++; … }
```

which surfaces as `N playing media element(s)` (`:2388`) with `Remedy: anti.media.freeze(tabId)`.
Observed live on the stalled tab: the two videos were `{readyState: 4, paused: true}` while the
error claimed "2 playing media element(s) (video x2)", and the offered remedy cannot clear its own
predicate — `anti.media.freeze` pauses media; it never drops `readyState`. With the media removed
from the DOM the same capture still timed out, this time with no diagnosis clause at all, while the
real condition was a tab whose view had no compositor surface (`attached: false` while the toolbar
showed it as the active tab; frames and lazy images resumed only after the tab was re-presented).

Proposed: separate `playing` (`paused === false`) from a distinct `buffered` count, attach the
freeze remedy only to the former, and when the census is clean name the other known cause — a view
with no compositor surface — instead of returning no lead.

Related but distinct, and self-healing: on that un-presented tab 22 images sat at `naturalWidth 0`
(Chromium defers lazy loads in a non-rendered frame) and all 56 loaded after the tab was presented.
It is not the cause of the white section, which reproduces on a fresh load with the tab presented
throughout.

Recorded as registry row **B38** (`open`, manual) with those re-verification steps; the fix is
proposed, not landed.

## 10. Addendum — line drift caused by the §8 fix

The §8 edit inserted 24 lines into `src/main/browser/native-tab-host.ts` (the invariant docblock and
the new fill layer). Citations into that file gathered at HEAD `ea6cecb9` that sit *below* the
insertion point therefore shifted:

| cited in | at `ea6cecb9` | now |
|---|---|---|
| §8 injection call site | `:3910` | `:3916` |
| §2/§4 R3 tab-view creation | `:4260`, `:4421`, `:5256` | `:4284`, `:4445`, `:5280` |
| §3, §4, §5, §9 citations into the checksum, ledger, capture, canary and contract files | — | unchanged (those files were untouched) |

`DEFAULT_CANVAS_CSS` stays at `native-tab-host.ts:239-248` — above the insertion — so §8's first
citation is still exact. §3's B33 citations (`control-plane-contracts.ts:508-511`) are likewise
unchanged, because the ledger fix landed in `invocation-ledger.ts` and
`invocation-frame-checksum.ts` and `canonicalJsonStringify` was deliberately left alone (see §6.1).

Registry state after §6's landed items and the four rows recorded from this report (`B35` register
lifecycle bypass, `B36` live-register residue, `B37` unattributed `gpu-process` fault, `B38`
capture-timeout census): `node scripts/check-bottlenecks.mjs` reports
`42 row(s): CLOSED=29 REFUTED_OK=4 MANUAL=8 OPEN=1` → `OK — every declared status matches HEAD`,
with no STALE warnings. The one machine-evaluable open row is B23, blocked on external
prerequisites; the eight manual rows (B21, B34, B35–B38, R2, R3) each carry a named re-verification
step instead of a predicate the checker can evaluate.

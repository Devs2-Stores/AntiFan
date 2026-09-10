# AntiFan core bottlenecks — measured findings

Instance: `antifan-probe` (fresh, `hub start`, port 20132, data root `E:\Work\.antifan-probe`,
project/workspace id `…-000000000002`, `--allow-eval`), Electron v43.4.0, Windows 11.
Target page for the capture probes: `https://hoplong.com/gioi-thieu-ve-hop-long/` (page-12 of the
15-page demo campaign).

Demo context only: the 15-page campaign is the *probe*; nothing in this file is a demo fix.

---

## F1. Agent bootstrap hands out a tabId the browser host does not know

```
$ node .canary/tools/canary-session.mjs 20132 .canary/state/probe-session.json
ANTIFAN_MCP_BOOTSTRAP={… "tabId":"7bbee728-bf5f-4595-a798-8f40707be428"}
[canary-session] port=20132 attachment=attachment-77923d9f… primaryTab=7bbee728…

$ anti.browser.evaluate {tabId: "7bbee728…", expression: "{innerWidth,innerHeight,url}"}
ERR TARGET_MISMATCH: Unknown browser target: 7bbee728-bf5f-4595-a798-8f40707be428
```

The attachment bootstrap returns a primary tab that `anti.browser.evaluate` rejects as an unknown
target, while `anti.browser.tabs.create` returns ids that resolve. Reproduced on a brand-new instance
with an empty profile. This is the same failure class as the observed MCP symptom (`tabs_create`
minted an id, then `evaluate`/`activate` → `TARGET_MISMATCH`), i.e. it is not MCP-specific.

Impact: an agent that trusts the bootstrap tabId cannot address any target. All capability calls on
that id fail with `TARGET_MISMATCH`, which is indistinguishable from "user closed the tab".

## F2. `anti.browser.tabs.list` returns an empty list while tabs exist

```
$ anti.browser.tabs.create {url:"https://hoplong.com/gioi-thieu-ve-hop-long/", activate:false}
{"tabId":"16813c1b-e969-486a-b4bb-8c7cbbc06f17"}

$ anti.browser.tabs.list {}
[]
```

Called with `{}` on a brand-new instance after creating a tab. The tab loads the page
(`readyState: "complete"` on the next call), so the tab exists in the host; `list` reports nothing.
With F1 this leaves agents with no working discovery path: bootstrap id unusable, list empty.

## F3. A tab created in the background has no viewport, and the canonical namespace cannot fix it

```
$ anti.browser.tabs.create {url:"https://hoplong.com/gioi-thieu-ve-hop-long/", activate:false}
{"tabId":"16813c1b-…"}

$ anti.browser.evaluate {tabId:"16813c1b-…", expression:"{w:innerWidth,h:innerHeight,url,ready}"}
{"w":0,"h":0,"url":"https://hoplong.com/gioi-thieu-ve-hop-long/","ready":"complete"}

$ browser.set-viewport {tabId:"16813c1b-…", width:1440, height:900, mobile:false, deviceScaleFactor:1, reload:false}
{"success":true,"width":1440,"height":900,"presetId":"custom-1440x900","observedWidth":1440,"observedHeight":900}

$ anti.browser.evaluate {…, expression:"{w:innerWidth,h:innerHeight,docH:…}"}
{"w":1440,"h":900,"docH":5715,…}
```

A tab can be fully loaded and still report a 0x0 viewport; `browser.set-viewport` made it usable in
that observation (it is not reliable — see F3b). On the earlier instance, calls against the
attachment's tab consumed their full bound
(`anti.browser.evaluate` → `RPC timeout 25000ms`) rather than returning a diagnostic, and no
capability reports `NO_RENDER_SURFACE`/`ZERO_VIEWPORT`. Capability namespace check
(`src/main/tools/browser-capabilities.ts`, 52 registered names):

```
capture/size related canonical names: anti.screenshot.viewport, anti.screenshot.full_page,
anti.browser.tabs.{list,create,activate,close}
no canonical set-viewport: the only registration is the legacy alias `antifan_set_viewport`
```

So on the canonical `anti.*` surface there is no way to give a tab a viewport.

### F3b. `browser.set-viewport` reports success with `observedWidth/Height: 0`

```
$ browser.set-viewport {tabId:"2d422d2f-…", width:1440, height:900, reload:false}
{"success":true,"width":1440,"height":900,"presetId":"custom-1440x900","observedWidth":0,"observedHeight":0}

$ anti.browser.evaluate {…, expression:"{w,h,ready,docH}"}   # last sample, after ~60 s of polling at 1.5 s
{"w":0,"h":0,"ready":"complete","docH":16011}
```

The call reported `success: true` while echoing observed geometry of `0x0`, and the endpoint of that
observation window was still `0x0`. Later, after a different operation (the failed capture in F4), the
same tab read `1440x900`:

```
{"w":1440,"h":900,"ready":"complete","docH":5719,"placeholder":41}
```

Cause of that change is unknown: this data does not establish why the geometry changed, and it says
nothing about the document's styling state. What it does show is
that `success` plus an `observedWidth/Height` of `0` is the only signal available, and that a caller
must verify geometry itself before trusting a tab as sized. Runs measured while a tab read `0x0` were
discarded (see F4).

## F4. `anti.screenshot.full_page` fails on the *first* capture and leaves the tab draining for the next attempt

```
attempt 1 (fresh tab, sized 1440x900, docH 5715):
$ anti.screenshot.full_page {tabId}
ERR TARGET_BUSY_DRAINING: Page.captureScreenshot did not settle within its bound
    on full-page tab '16813c1b-…'                                  (~60 s, full bound)

$ anti.media.freeze {tabId, freeze:true, normalizeSliders:false}
{"frozen":true,"mediaCount":0,"tabId":"16813c1b-…"}

attempt 2 (same tab, immediately after):
$ anti.screenshot.full_page {tabId}
ERR TARGET_BUSY_DRAINING: …                                      (~10 s, not ~60 s)
```

Correction to the earlier working belief that the capture budget trips on the third capture: on a
fresh instance the **first** `full_page` capture on this page fails. The second attempt fails an
order of magnitude faster, i.e. the tab is left in a draining state by attempt 1 rather than being
recovered.

Whether `anti.media.freeze` before a first capture changes this is **unresolved**: the attempt made
for it ran on a tab whose viewport was never established (`browser.set-viewport` echoed
`observedWidth: 0`, the pre-capture reading was `h: 0` while the document was still loading), so that
run is discarded rather than counted either way.

Impact: no authoritative full-page evidence exists for this page, so pixel verification of any
product surface that uses this page as a reference is impossible. `TARGET_BUSY_DRAINING` is a
timeout-shaped error: it reports that the capture did not settle, not why.

## F5. A failed full-page capture mutates the tab viewport

```
before attempt 2: {"w":1440,"h":900,   "docH":5719}
after  attempt 2: {"w":1440,"h":5715,  "docH":5719}
```

`innerHeight` changed from 900 to the full document height (5715) and stayed there. The
reversible-normalization guarantee covers the compare transaction; the failed-capture cleanup path
does not restore the viewport. Subsequent measurements taken on that tab are not comparable with
measurements taken before it.

## F6. The reference producer never materializes lazy images; a real scroll pass does

Reference page-12 state, measured on the live tab (`imgs` = `document.images.length`):

| step | placeholder `img[src^="data:image"]` | `img[data-src]` | `imgs` |
|---|---|---|---|
| after load + settle (viewport 1440x900) | 42 | 42 | 49 |
| after a scroll attempt (see note) | 42 | 42 | 49 |
| after `innerHeight` became 5715 (whole document in viewport) | 42 | 42 | 49 |
| after failed `full_page` attempt 1 and 2 | 42 | 42 | 49 |

Note on the scroll attempt: it was **clamped and therefore did not test scrolling**. By the time it
ran, the failed capture had already expanded the viewport (`innerHeight` 5715 vs `docH` 5719), so
`window.scrollTo` had roughly 4 px of range and no displacement occurred. What the row shows is that
"whole document inside the viewport" is not by itself sufficient — not that scrolling is ineffective.

Measured separately in a plain Chromium window (Electron offscreen, real 1440x900 viewport, no
AntiFan host and none of the app's command-line switches), same page:

```
after load + 9 s : {"placeholder":41,"dataSrc":42,"imgs":49,"docH":5715}
after real scroll: {"placeholder":5, "dataSrc":42,"imgs":49,"docH":5462}   # 0→docH in 800 px steps, 80 ms/step
```

A real 1440x900 scroll pass materializes 37 of the 42 placeholders in plain Electron, so scrolling is
a viable materialization mechanism on this page. This was measured **outside** the AntiFan path: it
justifies adding a scroll pass to AntiFan's reference capture and testing it there, and it does not
show that AntiFan's existing compare-path scroll would behave identically. What is directly verified
on the AntiFan path: its reference producer never scrolls, and its captured output retained all 42
placeholders.

Per-image inspection on the AntiFan tab:

```
{"before":{"attr":"https://hoplong.com/wp-content/uploads/2025/08/1.jpg",
           "loaded":"1",                       // data-lazyloaded="1" is already set
           "srcHead":"data:image/svg+xml;base64,PHN2"},
 "globals":{"lazySizes":"undefined","Flatsome":"object","jQuery":"function",
            "IntersectionObserver":"function"},
 "manual":{"ok":true,"w":1920,"h":500}}          // target URL loads fine
```

The swap target URL is reachable and decodes (`manual: {ok:true, w:1920, h:500}`); `data-lazyloaded="1"`
is already set, yet `src` still holds the base64 placeholder. Measured state of that tab:

```
{"visibility":"visible","hidden":false,"focus":false,
 "raf":{"fired":true,"ms":17},"io":{"fired":false,"ms":3028}}
```

rAF fires normally in this tab. (The single IntersectionObserver probe is inconclusive: the element
was not verified to be within the root at probe time, so `io.fired:false` proves nothing on its own.)

Impact: for every page whose images use this placeholder pattern (page-12: 42 of 49 `<img>`; the
same pattern appears on pages 12–15 of the campaign), the captured reference is a pre-hydration
state. Everything downstream — CloneIR, asset localization, the bundle, and the fidelity verdict —
is derived from that state.

## Ownership map (from code)

| step | owner | materializes lazy? | reachable by an agent? |
|---|---|---|---|
| reference DOM | `.canary/tools/dump-ref.mjs` — `document.documentElement.cloneNode(true).outerHTML` via generic `anti.browser.evaluate` | no (no scroll, no wait, no promotion) | yes |
| full-page pixels | core `anti.screenshot.full_page` (`browser-control-port.ts:1425` → `1470`) | no (pure CDP capture) | yes, but F4/F5 |
| cascade scroll for lazy hydration | core `browser-control-port.ts:1056`, inside `buildReversibleNormalizationApplyScript` | yes | **no** — invoked only from `applyReversibleNormalization` (`:3874`, visual-compare) |
| reference capture capability | — | — | **does not exist** (52 registered capabilities, none returns a reference DOM) |

## Recommended core work (ordered)

1. **Fail fast on an unusable surface.** Every render-dependent capability must verify a non-zero
   viewport and return `NO_RENDER_SURFACE` (with tabId, observed size, and cause) immediately instead
   of consuming its bound. Today F3/F4 cost 10–60 s per call and report a timeout.
2. **Expose viewport control on the canonical `anti.*` namespace** (`anti.browser.set_viewport`), so
   the only working way to obtain a usable surface is not an out-of-namespace legacy alias.
3. **Fix attachment bootstrap + `tabs.list`** (F1, F2): the id handed to an agent must resolve, and
   `list` must report the tabs that exist.
4. **Make failed captures state-restoring** (F5): a failed `full_page` must restore viewport and
   drain state, or mark the tab unusable explicitly rather than leaving it silently mutated.
5. **Add a first-class reference-capture capability** that owns materialization, settlement, and a
   receipt (url, viewport, docHeight, image counts, sha256). F6 shows what that step must do: run a
   scroll pass with a verified non-zero scroll range (in plain Electron this promoted 41 → 5
   placeholders; the equivalent behaviour on the AntiFan path is untested), re-check the placeholder
   count afterwards, and record the residual in the receipt instead of assuming the page materialized
   itself. Promotion of `data-src`/`data-srcset` in the generator (currently added as a mitigation in
   `independent-html-clone-generator.ts`) becomes a fallback layer rather than the primary fix — it
   corrects the symptom for bundles built from an unmaterialized reference.
6. Only then can the demo campaign's numbers be read as statements about the core: today the
   reference producer is a harness script (row 1) and the harness has no materialization step, so a
   clone defect can be a harness artifact, and a core defect can be hidden by a harness workaround.

## Verified / still open

Verified on the AntiFan path: the reference producer does not scroll, and its captured output
retained all 42 placeholders; a source document can be rendered with the whole document inside the
viewport and still keep those placeholders. Verified outside the AntiFan path: a real 1440x900 scroll
pass in plain Electron promotes 37 of the 42 placeholders, so scrolling is a viable mechanism and the
scope of what remains unmeasured is whether it behaves the same through the AntiFan path.

Still open: whether a *successful* `anti.screenshot.full_page` has any lazy-load side effect. It
cannot be tested here because `full_page` has not succeeded on this page in this instance (F4), so
the original before/after A/B remains INCONCLUSIVE — `42 → 42` only shows that a timed-out attempt
materializes nothing.

---

## F7. MCP surface: what works, what hangs, and the session isolation

Measured through the mounted `antifan-browser` MCP against the desktop app
(project/workspace `…-000000000001`, runtime `binding-82b1101a…`):

| MCP tool | result |
|---|---|
| `anti.browser.navigate` | works; with no `tabId` it auto-creates and returns a target |
| `anti.browser.tabs.create` / `tabs.close` | work for tabs the session manages |
| `anti.browser.evaluate` | works |
| `browser.set-viewport` | works, and is required: a freshly created tab measured `w:0,h:0` until it was called |
| `anti.inspect.page_inventory` | works; full 0→scrollHeight inventory with per-section y/height |
| `anti.screenshot.viewport` | **times out at the MCP 30 s bound** on a freshly sized tab (`docH 5715`, DOM measured 1440x900), and leaves that target draining — the next capture on it returned `TARGET_BUSY_DRAINING` |
| `anti.browser.tabs.list` | returns `[]` both before and after the session created and closed its own tabs |

Session isolation is explicit in the failure text: after the session bound to one tab, closing another
tab it had created earlier returned
`TARGET_MISMATCH: Cannot close tab "4497ff1f…". This session is isolated to tab "c79aea3d…" and its
managed tabs.` The first navigation's tab is therefore left open and unmanageable by the agent that
created it — a tab leak with no `list` surface to find it.

Practical consequence: MCP is usable for structural and layout evidence (`inspect.*`, `evaluate`) but
not for pixels right now; and `screenshot.viewport` is the third independent surface where a capture
call consumes its bound instead of failing fast (with F3/F3b and F4).

## Measurement surface (affects every future verification)

Offscreen renders were **not authoritative** for page heights during this work. Same bundle, same
viewport:

```
page-14 clone, offscreen 1440x900 window : docH 2665
page-14 clone, app tab sized 1440x900    : docH 2919   == live page-14 at 1440x900
```

The offscreen number disagreed with both the sized app tab and the live page, so an earlier conclusion
of a −254 px clone defect on page-14 is withdrawn: it was produced by the offscreen surface, and the
offscreen surface was the outlier. What caused the discrepancy was not established here — the counts
observed on the two surfaces were not even consistent in direction (the offscreen render reported
`broken: 0`, while an unsized 0x0 app tab reported `broken: 22` for the same clone), so no mechanism is
claimed. The rule that follows from the data: **verify heights and image loading on a sized tab in the
app**, and treat offscreen renders as a smoke check for CSS/asset presence only.

## Rebuilt last four pages — live vs clone parity (app tab, 1440x900)

All four bundles rebuilt after compiling `packages/site-clone` (`tsc`, so `dist` carries the head-style
and lazy-promotion fixes), each `EXIT=0` with `remoteSubresources: 0`:

| page | live `docH` / imgs / sheets / rules | clone `docH` / imgs / sheets / rules |
|---|---|---|
| 12 `gioi-thieu` | 5715 / 49 / 125 / 4852 | 5715 / 49 / 126 / 4855 |
| 13 `lich-su` | 8897 / 31 / — / — | 8897 / 31 / 139 / 4888 |
| 14 `tuyen-dung` | 2919 / 17 / 78 / 4846 | 2919 / 17 / 79 / 4849 |
| 15 `tuyendung-detail` | 4474 / 29 / 65 / 4816 | 4474 / 29 / 66 / 4819 |

Heights and image counts match exactly; the clone carries one extra `<style>` block and 3 extra rules
(the generator's own). Lazy placeholders on the clone went from 41 to 0 on page-12 (`data-src`
attributes remain as inert leftovers), and all four render with `broken: 0` in a sized tab. Live
page-13's hero is a flat background with no `<img>` and `.bg-fill` at `opacity: 0`
(`background-image: none`), so the clone's "empty hero" there is faithful, not a defect.

---

## F8. A full-page capture abandoned by its execution budget left the target wedged — and unclassified

Measured live inside a real Electron main process with the real `NativeTabHost` and
`BrowserControlPort` (throwaway harness `.canary/state/live-evidence-smoke.cjs`, real CDP, throwaway
`userData` at `.canary/state/smoke-userdata`, page served over `127.0.0.1`):

```
before the fix
  D4.fullPage-capture-proven  EXECUTION_TIMEOUT :: Visual compare full-page capture exceeded its 29999ms bound
  D4.geometry-restored        FAIL  CDP command Runtime.evaluate timed out after 3000ms
after the fix
  D4.fullPage-capture-proven  TARGET_BUSY_DRAINING :: ... did not settle inside its execution budget and was abandoned
  D4.geometry-restored        PASS  target closed while handling command  (transport reset, nothing left holding the command)
```

Root cause: `CompareBudget.run` clamps every bound to `remainingMs`, so the *outer* timeout of
`screenshotFullPage` always fires before the inner `Page.captureScreenshot` bound and rejects while
that command is still in flight. The inner `catch` — the only place that quarantines, drains the
transport and restores the capture geometry — never ran, so the caller got a bare budget error and the
tab kept a renderer that could not answer the next probe. Fix: the outer gate now recovers on
`EXECUTION_TIMEOUT` exactly as a settled drain failure does (quarantine → `drainTarget` →
`reapplyTabGeometry` → typed `TARGET_BUSY_DRAINING`), and `quarantined` is reported on both paths so a
caller can tell whether the target was released again.

Re-verified on the final tree (`e1314c3`, fresh Electron main process, throwaway `userData`,
`.canary/state/live-evidence-smoke.json` timestamp `2026-09-10T12:29:42.971Z`): **8/8**, same typed
refusal, same transport reset. The remaining suites on that tree: `test:main` 1076 pass / 0 fail,
`test:fast` 435 / 0, `test:integration` exit 0, `baseline-authority-integration` 9/9,
`render-surface-and-viewport-gates` 20/20, `mcp-persistent-transport` 3/3.

## F9. The in-page eval guard killed a script at 15 s while its caller had declared 30 s

`TabDevToolsHost.evalJs` hard-codes a 15 000 ms in-page guard (background tabs pause rAF, so the guard
is required), while the reference materialization walk declares
`REFERENCE_MATERIALIZATION_BOUND_MS = 30_000`; the port then swallowed the rejection with
`.catch(() => null)` and reported the walk as a timeout against a bound the script never reached. The
app's port literal in `index.ts` also narrowed the seam back to three arguments, undoing whatever the
caller passed.

Measured live, after threading the budget through (`host.evalJs(script, tab, pane, false, budget)`):

```
16 s script with a 25 s budget : resolved  value="late"      elapsed 16 005 ms
16 s script with no budget     : rejected  "Evaluation timed out after 15000ms"  elapsed 15 004 ms
```

The guard ceiling is now a caller parameter with the old value as its default, and the materialization
failure reports `cause: 'eval-failed'` plus the underlying message instead of a misleading bound.

## F10. A dropped dispatch socket can be replayed onto a different instance, and the caller cannot tell

Measured with a throwaway probe (`.canary/state/transport-probe.cjs`): a fake bridge answers one
`anti.browser.tabs.list` dispatch on its own port; five milliseconds into the call the socket is
terminated. The proxy classifies that as a transport fault, prints
`Connection or auth issue detected (CONNECTION_CLOSED ...). Autohealing...`, and finds a candidate on
this machine that is **not** the pinned endpoint — the developer's live AntiFan bridge — gets a session
from it and re-dispatches the same call there, under the original identity:

```
PROBE_FRAMES  [{ socket: 1, outerId: '10526548-…', requestId: 'req-mcp-999', idempotencyKey: 'idem-mcp-999', name: 'browser.list-tabs' }]
PROBE_FINAL   {"result":{"content":[{"type":"text","text":"[{\"id\":\"52b0fab0-…\",\"capsuleId\":\"capsule-6b117618-…\",\"terminalSessionId\":\"terminal-3\",\"isBoundTab\":true,…}]"}]}}
```

The replay is by design — failover exists so a killed instance does not strand the agent, and the
`idempotencyKey` is minted once per logical call and reused so the retry joins the original invocation
instead of minting a second one. What is *not* symmetric is the ledger: the join key only has meaning
inside the instance that received the first attempt, so a cross-instance retry of a mutating capability
is two executions with one caller-visible result. The proxy says so (`FOREIGN_INSTANCE_ATTACH`) only
when `ANTIFAN_BRIDGE_PID` is set, so a session launched without the pin heals silently.

Consequences recorded, not re-architected (the retry is the deliberate transport contract):
- Discovery is gated on terminal context or a bridge pin (`hasTerminalInstanceContext`,
  `scripts/antifan-omp-mcp.cjs:123`); failover is off for a hand-invoked proxy, which keeps it
  fail-closed outside an agent session.
- A test harness that spawns the proxy with `...process.env` inherits that gate. The persistent
  transport suite now scrubs the terminal/pin/attachment variables, because otherwise its dropped
  socket healed onto the live instance and the call came back **successful** — the flake was the
  suite measuring the developer's machine instead of its own fake bridge (`fail 1` → `pass 3`,
  `test/main/mcp-persistent-transport.test.ts`).
- Read-only capabilities are unaffected in outcome; the residual risk is a mutating capability retried
  across instances. Pin the session (`ANTIFAN_BRIDGE_PID`) or run one instance when that matters.

## Scout inventory — claim vs the check that settled it

The parallel scout pass produced a prioritized list; each item was re-checked against the current tree
rather than trusted, because the codebase moved while the scout read it:

| claim | status | evidence |
|---|---|---|
| `getFailoverTargetTab` omitted from the `BrowserControlPort` literal | stale | `src/main/index.ts:303` wires it |
| `openTab` discards `adoptChildTab`'s result, leaking a tab | fixed (D3) | gate test *closes and fails a tab the session cannot adopt instead of leaking it* |
| proxy advertises `fullPage` on `anti.screenshot.viewport` and omits `anti.screenshot.full_page` | fixed | `scripts/antifan-omp-mcp.cjs` definitions + `CAPABILITY_MAP` |
| proxy client budget (30 s) below the server policy (60 s) | regression found, now structural | the per-capability `CLIENT_TIMEOUT_MS` table had no `theme.debug_bundle` entry, so the 30 s default still fired against a 60 s policy. The table is deleted: the proxy now owns one ceiling (`DEFAULT_CLIENT_TIMEOUT_MS = 240000`) and `scripts/check-mcp-budget-dominance.mjs` fails the compile when that ceiling stops dominating the largest catalogue policy (180 s, `browser.visual_compare`) |
| offscreen agent tabs are never reaped on session end | not reproducible | `endSession` → `attachments.revokeForAttempt` → dispose listener → `closeTab` (`src/main/index.ts:285-294`) |
| every ephemeral tab leaks a partition directory | unsupported | three smoke runs that created ephemeral tabs left exactly one directory: `Partitions/profile-default` |
| a custom `WxH` preset persists without its geometry | unsupported | `setViewportSize` stores `tab.customViewport` + `devicePresetId` (`native-tab-host.ts:6241-6247`) |
| a deferred viewport restore is never performed | dismissed | the throw quarantines with the pre-capture baseline, and `runTargetRecovery` drains then calls `reapplyTabGeometry` (`browser-control-port.ts:1658-1700`, `:4040-4070`) |
| a `redacted` artifact can be promoted as an authoritative baseline | unreachable | `stage()` redacts only text-like mimes (`artifact-store.ts:319`, `:555-566`), while `promote` requires a PNG (`readPngDimensions`, `baseline-authority.ts:170`), so a promotable source can never carry `redacted: true` |
| `overflowMode` defaults to `truncate`, so a staged artifact can be silently short | truthful, not silent | the default is historical and documented on the seam, every evidence-staging call site passes `'reject'` (`browser-control-port.ts:1609`, `:1851`, `:4460`), and the ref always reports `truncated`/`redacted` so a consumer can refuse it |
| `redactSecrets` rewrites `token: "…"`-shaped text inside staged HTML | deliberate, detectable | secret hygiene on text mimes; the mutation is visible to the caller as `ref.redacted`, so no consumer can mistake the stored bytes for byte-faithful page content |

The five core defects D1–D5 (render-surface fail-fast, verified viewport writes, truthful session tab
listing, capture geometry as a transaction, reference capture with materialization) are committed in
`7d0850b`; F8/F9 are the follow-ups found by reviewing that work against live behaviour. The redundant
`(sourceRef as any)` in that promote gate is gone: `ArtifactRef` already declares `truncated`, so the
cast only hid the field's real type from the compiler.

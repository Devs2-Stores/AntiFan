# Phase 4 Report: Held-out corpus, live probe, pipeline lane, docs

**Status: Phase exit met with two documented known gaps (supervisor verdict `CLOSE_WITH_GAPS`).**
The first blind corpus failed (4/8, see "Holdout #1"); the user chose to fix h05 and re-judge on a
fresh blind corpus, which passed (6/8 defects, 0/4 controls).

## Task 4.1 - Harness `--corpus` + entry contract

- `test/e2e/visual-qa-fixtures-probe.cjs`: `--corpus=<path>` (resolved against `process.cwd()`,
  default `test/fixtures/visual-qa/fixtures.cjs`); each entry is checked before any window opens.
- Default lane at the time: `npm run test:visual-qa` → exit 0, `SUMMARY pass=40 fail=0`.
- Malformed corpus (`[{ id: 'x', html: '<p>x</p>', expect: {} }]`): exit 2,
  `Error: Corpus entries break the contract: x`.
- Disconfirmation: a control fed a truncated/failed-detector payload
  (`--only=12 --scan-file=<gap.js>`) → exit 1, rows FAIL with `scan truncated: elements 20000 > 15000`
  and `detectors failed: overlap`.

## Holdout #1 (spent) - Tasks 4.2 and 4.3, FAILED

- Freeze hashes recorded before the author started and re-checked after the corpus landed (identical):
  - `4cf090df335fede49a6988a14fb6d95b437a3fd1e08cac5972b23b699c7f324b  src/main/qa/scanners/layout-integrity-engine.ts`
  - `9ec7c03674c4ab54b56c1b4dd422c4419723a4ccbc3cf286253ee571ad9d7d6c  test/e2e/visual-qa-fixtures-probe.cjs`
  - `0ac1e04bf1d5c155e6cfa801360e4ca3c35eade68238899e190e70b195379e7d  src/main/qa/scanners/layout-overflow-engine.ts`
- Author agent `HoldoutAuthor` read only `scripts/run-electron.cjs`; transcript shows no forbidden path.
- `test/fixtures/visual-qa/holdout.cjs`: 12 entries, 4 controls; shape check printed `12 4 OK`.

`npm run test:visual-qa -- --corpus=test/fixtures/visual-qa/holdout.cjs --out=<tmp>` → exit 1

```text
mobile h01-title-price-overlap PASS crit=1
mobile h02-nested-copy-clipped FAIL crit=0   expected one of clipping at mobile
mobile h03-nested-cta-covered PASS crit=2
mobile h04-sticky-buy-bar-covers-copy FAIL crit=0   expected one of occlusion|sticky-obstruction at mobile
mobile h05-buy-button-offscreen FAIL crit=0   expected one of offscreen at mobile
mobile h07-deep-controls-overlap FAIL crit=1   (critical is occlusion, expected overlap)
SUMMARY pass=20 fail=4 failed=mobile:h02-nested-copy-clipped,mobile:h04-sticky-buy-bar-covers-copy,mobile:h05-buy-button-offscreen,mobile:h07-deep-controls-overlap
```

Step 2: `controlsFailed=0 defectsMissed=4 otherFailed=0` → **FAIL** (budget `defectsMissed` ≤ 2).

Defect text of every miss (verbatim from `holdout.cjs`):

- `h02-nested-copy-clipped`: Phần mô tả sản phẩm bị cắt cụt trong khung nội dung nên khách không đọc hết hướng dẫn chọn size.
- `h04-sticky-buy-bar-covers-copy`: Thanh mua hàng cố định che mất dòng thông tin giao hàng khi khách cuộn xuống cuối trang.
- `h05-buy-button-offscreen`: Nút mua ngay bị đẩy hẳn ra ngoài mép phải màn hình điện thoại.
- `h07-deep-controls-overlap`: Hai nút chọn kích cỡ ở phần chi tiết phía dưới chồng lên nhau, khách khó bấm đúng lựa chọn.

Diagnosis (read-only; engine untouched). Geometry measured by a throwaway Electron probe at
375×667 DSF 2, same emulation as the harness; line refs are the engine as frozen for holdout #1.

| id | Measured geometry | Engine cause | Class |
|---|---|---|---|
| h02 | `.description` 42px tall, `overflow:hidden` on itself, line-height 22, scrollHeight 110; lines 1-2 fully visible, lines 3-5 wholly hidden; no ellipsis, no read-more | Whole hidden lines are skipped; `run.below` needs `a !== p` (`:433`), so a box clipping its own trailing lines reads as intended truncation | Design ambiguity: same geometry as a height-based clamp (control 12) |
| h04 | maxScroll 512; bar 602-667; last delivery line 592-609 → bottom 7/17px (41%) covered; both line centers above the bar | Occlusion sweep samples line-center y (`:695`), needs 2 of 3 x points covered | Threshold; marginal defect at this geometry |
| h05 | `body{overflow-x:hidden}` → computed `overflowY:auto`; button 545-675 with vw 375, inside `.card{overflow:hidden}` | Offscreen detector parks a control when any clipping ancestor has a scroll axis (`:343-347`); body's computed `auto` qualifies. The clipping detector guards this case (`pageAxisY`, `:425-429`); offscreen does not | **Engine bug**, likely broad blast radius [INFERENCE: `body{overflow-x:hidden}` is a common theme pattern] |
| h07 | both `.size` buttons `position:absolute`, overlap 38×44 = 41% of the smaller | Stacked-controls skips absolute pairs (`:553-559`, `:579`) and needs ≥ 50% (`:593`) | Exemption + threshold; page verdict is FAIL (occlusion), kind is wrong |

Supervisor counsel (`kongming`, Failure Protocol): `STOP_AND_ASK_USER`. Recorded as-is; `holdout.cjs`
left untouched.

## User decision (2026-10-10)

Fix h05 only, then measure on a new blind corpus by the same rule (recorded in `plan.md`
"Decision log"). h02, h04 and h07 stay known gaps with no engine change.

## h05 fix

- `src/main/qa/scanners/layout-integrity-engine.ts` offscreen branch: a control outside on X is
  reachable only if a clipping ancestor scrolls on X, outside on Y only if one scrolls on Y
  (`parked = reachX && reachY`). A lone `overflow-x:hidden` computes `overflow-y:auto` and no longer
  parks a control past the side edge.
- Fixtures added to `test/fixtures/visual-qa/fixtures.cjs` (now 24: 16 kind defects, 2 overflow
  defects, 6 controls): `20-offscreen-cta-clipped-card` and `21-offscreen-cta-html-body-overflow-x`
  (expect `offscreen`), `22-scrollers-under-body-overflow-x` (control), `23-overflow-body-only-hidden`
  (expect `documentOverflow`).
- Red before the fix (reference scan carrying the old parking rule,
  `--only=2 --scan-file=…/scan-v2.js`): `SUMMARY pass=6 fail=2
  failed=mobile:20-offscreen-cta-clipped-card,mobile:21-offscreen-cta-html-body-overflow-x`.
  Green after: same rows on the engine, `SUMMARY pass=8 fail=0`.
- Checks after the fix:

| Command | Exit | Result |
|---|---|---|
| `npm run test:visual-qa` | 0 | `SUMMARY pass=48 fail=0`; slowest `stats.durationMs` 780 (`desktop:13b-footer-overlap-large-dom`); 0 truncated, 0 failed detectors |
| `npx tsx --test test/unit/theme-qa-fail-closed-adjudication.test.ts` | 0 | 31/31 pass |
| `node --test --test-force-exit test/unit/layout-integrity-engine.test.mjs` | 0 | 6/6 pass |
| `npm run typecheck` | 0 | — |

- Observed flake: one full fixture run before the green one above died with an Electron `loadFile`
  rejection (`rejectAndCleanup … WebContents.stopLoadingListener`) while loading page 46/48
  (`desktop-21-offscreen-cta-html-body-overflow-x`); the harness exits 2 on an unhandled rejection.
  The error message line was not captured. The immediate re-run of the same tree passed 48/48. Not
  reproduced; no harness change.

## Holdout #2 - Tasks 4.2 and 4.3, PASS

- Freeze hashes recorded before `HoldoutAuthor2` started and re-checked after measurement (identical):
  - `c25bcc33cbcd456acc0edfe62375bf5aa4841737b604666bd3d83cc657cf69a6  src/main/qa/scanners/layout-integrity-engine.ts`
  - `0ac1e04bf1d5c155e6cfa801360e4ca3c35eade68238899e190e70b195379e7d  src/main/qa/scanners/layout-overflow-engine.ts`
  - `9ec7c03674c4ab54b56c1b4dd422c4419723a4ccbc3cf286253ee571ad9d7d6c  test/e2e/visual-qa-fixtures-probe.cjs`
  - `4fdbd6b90b48739f3c7495167892c5d05abd00760d121c99e5535b4c1cecdbc9  test/fixtures/visual-qa/fixtures.cjs`
- `HoldoutAuthor2` tool calls: read `scripts/run-electron.cjs` (twice), wrote `holdout-2.cjs`, shape
  check, wrote and ran a render script under `os.tmpdir()`, read its 12 PNGs, `git status -s`,
  `git status -s test/fixtures/visual-qa/`, `git status -u test/fixtures/visual-qa/`, shape check.
  No read or search of a forbidden path. The three `git status` calls list file names under
  `test/fixtures/visual-qa/` (`fixtures.cjs`, `holdout.cjs`), not contents; supervisor judged the
  isolation valid.
- `test/fixtures/visual-qa/holdout-2.cjs`: shape check printed `12 4 OK`.

`npm run test:visual-qa -- --corpus=test/fixtures/visual-qa/holdout-2.cjs --out=<tmp>` → exit 1

```text
mobile h01-overlap-price PASS crit=1
mobile h02-clipping-btn-cart PASS crit=1
mobile h03-sticky-obstruction-footer FAIL crit=0   expected one of sticky-obstruction|occlusion at mobile
mobile h04-document-overflow-banner PASS crit=0
mobile h05-occlusion-floating-widget PASS crit=3
mobile h06-offscreen-action-btn FAIL crit=0   expected one of offscreen at mobile
mobile h07-clipping-deep-description PASS crit=1
mobile h08-overlap-nested-review PASS crit=1
mobile h09-control-sale-badge PASS crit=0
mobile h10-control-multiline-clamp PASS crit=0
mobile h11-control-horizontal-chips PASS crit=0
mobile h12-control-collapsed-accordion PASS crit=0
SUMMARY pass=22 fail=2 failed=mobile:h03-sticky-obstruction-footer,mobile:h06-offscreen-action-btn
```

Step 2: `controlsFailed=0 defectsMissed=2 otherFailed=0` → **PASS** (6/8 defects caught, 0/4
controls with a critical). Slowest `stats.durationMs` 15.

Defect text of every miss (verbatim from `holdout-2.cjs`):

- `h03-sticky-obstruction-footer`: Thanh đặt hàng dính ở đáy màn hình che khuất nút xem đánh giá và mã giảm giá ở cuối trang.
- `h06-offscreen-action-btn`: Nút hoàn tất đơn hàng bị đẩy lệch ra ngoài mép phải màn hình điện thoại do toạ độ đặt sai không thể bấm được.

Diagnosis (throwaway Electron probe at 375×667 DSF 2; engine untouched; lines are the frozen engine):

| id | Measured geometry | Engine cause |
|---|---|---|
| h03 | pageHeight 683, maxScroll 16; fixed bottom bar 595-667. `.reviews-trigger-btn` at scroll 16 is 609-651, fully in view, center hit = the bar: covered at every reachable offset. `.voucher-btn` center hit is itself at both offsets (not covered) | A foreign fixed layer counts as `covered` only at scroll 0 and only for a top bar (`topLayer`: top < 25% of vh, `:663-671`, `:722`); otherwise the sample is `deferred` (`:723`, `:733`), and a target still deferred after the last sweep step is dropped. A bottom bar over the end of the page is never reported |
| h06 | button `position:absolute; left:395px` inside a 343px `overflow:hidden` box; rect x 412-692, vw 375; `documentElement.scrollWidth` 375 | The control is outside on X with no X scroll axis, so the axis rule does not park it; the absolute-parked loop (`:358-363`, meant for off-canvas drawers parked outside the viewport) starts at the control itself, and the control is absolute with its own rect outside, so it is parked |

Supervisor counsel (`kongming`): `CLOSE_WITH_GAPS`. Record h03 and h06 as known gaps; changing the
engine now spends `holdout-2.cjs`.

## Task 4.4 - Live probe - PASS

- Before the h05 fix: `npm run probe:visual-qa-live -- --out=<tmp>` → exit 0,
  `SUMMARY pages=24/24 unmeasured= withCritical= unrestored=0 maxMs=763`.
- After the h05 fix: exit 0, `SUMMARY pages=24/24 unmeasured= withCritical= unrestored=0 maxMs=649`.

## Task 4.5 - Pipeline lane - PASS

- `node scripts/run-test-pipeline.mjs test:visual-qa` (20 fixtures, before the h05 fix) → exit 0;
  output contains `===== test:visual-qa =====`, no `===== compile =====`;
  `SUMMARY pass=40 fail=0`, `test:visual-qa  passed   78.3s`, `all lanes passed`.
- Final lane run (24 fixtures, after the h05 fix): same command → exit 0;
  `SUMMARY pass=48 fail=0`, `test:visual-qa  passed   64.6s`, `all lanes passed`.

## Task 4.6 - Docs and changelog

- `docs/operations.md`: Verification Commands (`test:visual-qa` against 24 known pages, 25 after
  the final review; `probe:visual-qa-live`), "twenty lanes" + `test:visual-qa` in the lane list,
  and the `theme.qa_validate` layout-integrity bullet (offscreen axis rule, `layout` check gating,
  known gaps).
- `CHANGELOG.md`: `### Sửa - Theme QA: …` under `## [v1.3.6] - Unreleased`.

## Final review (supervisor verdict `SHIP_WITH_FIXES`)

Four findings, each checked against source before acting:

| # | Finding | Disposition |
|---|---|---|
| 1 | `integrityResult.measured === false` is only read inside `Array.isArray(rec.findings)` (`theme-qa-workflow.ts:858-864`) | Not changed. The structure predates this plan (`git show HEAD:` has the same nesting), the comment at `:874-876` declares absent/malformed payloads unmeasured-without-gap by design, and the engine's own `measured:false` payload always carries `findings: []` (`layout-integrity-engine.ts:44-48`). |
| 2 | Integrity criticals fail the verdict even with `enabledChecks.layout: false` | Fixed: `checkParticipates('layout') && integrityCriticals.length > 0` (`theme-qa-workflow.ts:1270-1273`). |
| 3 | Active width outside 320/375/768/1024/1440 (e.g. 393) leaves every integrity count `null` | Not changed: per contract ("null for widths the scan did not measure"); findings stay in `findings.layoutIntegrity` (`:1340`) and still decide the verdict. Documented in `docs/operations.md`. |
| 4 | Scan zeroes `body.scrollLeft` when body is the page scroller | Fixed: `bodyStartLeft` saved next to `bodyStartTop` and restored in the `finally` (`layout-integrity-engine.ts:291-292`, `:754`). |

- Finding 2, red first: new test `10e` in `test/unit/theme-qa-fail-closed-adjudication.test.ts` →
  `'FAIL' !== 'PASS'` (exit 1). After the fix: 32/32 pass.
- Finding 4, repro (throwaway Electron script, body scroller at 40/300): before
  `"before":[40,300,0,0],"after":[0,300,0,0],"restored":false`; after `"restored":true`.
  Regression control `24-body-scroller-offset` added to `fixtures.cjs`; the harness restore check
  now compares window and body offsets. Pre-fix scan (`--only=24 --scan-file=<engine without
  bodyStartLeft>`): `SUMMARY pass=0 fail=2`, `scroll not restored (0,0,40,300 -> 0,0,0,300)`.
  Engine: `SUMMARY pass=2 fail=0`.
- Re-measurement on the final engine
  (`d6b21757…6aabd  src/main/qa/scanners/layout-integrity-engine.ts`):

| Command | Exit | Result |
|---|---|---|
| `node scripts/run-test-pipeline.mjs test:visual-qa` (25 fixtures) | 0 | `SUMMARY pass=50 fail=0`, `test:visual-qa  passed   73.7s`, `all lanes passed` |
| `npm run test:visual-qa -- --corpus=test/fixtures/visual-qa/holdout-2.cjs` | 1 (expected) | `SUMMARY pass=22 fail=2`, `controlsFailed=0 defectsMissed=2 otherFailed=0` - identical to the frozen-engine run |
| `npm run probe:visual-qa-live` | 0 | `SUMMARY pages=24/24 unmeasured= withCritical= unrestored=0 maxMs=642` |
| `npx tsx --test test/unit/theme-qa-fail-closed-adjudication.test.ts` | 0 | 32/32 pass |
| `node --test --test-force-exit test/unit/layout-integrity-engine.test.mjs` | 0 | 6/6 pass |
| `npm run typecheck` | 0 | - |

- Holdout #2 was judged on the frozen engine `c25bcc33…`. The finding-4 change touches only the
  scroll restore, not a detector; the re-run above is a regression check, not a second judgement.

## Speed (acceptance criterion 4)

Slowest `stats.durationMs`: fixtures 880 ms (Phase 3) and 780 ms (after the h05 fix), live 763 ms,
649 ms and 642 ms (final engine), holdout #2 15 ms → ≤ 1200 ms holds.

## Known gaps (not detected by this engine)

From the two blind corpora: a text box that clips its own trailing lines with no ellipsis or
read-more (holdout #1 h02); a fixed bar covering less than half of a line (#1 h04); two
absolutely positioned controls stacked (#1 h07, reported as `occlusion`, not `overlap`); a fixed
bottom bar covering the last control at every scroll offset (#2 h03); an absolutely positioned
control placed outside the viewport (#2 h06). The integrity scan runs on the active viewport only.

No step ran `npm run compile`, `npm test`, `npm run verify`, or restarted the running AntiFan
instance; every Electron run was a separate instance through `node scripts/run-electron.cjs`.

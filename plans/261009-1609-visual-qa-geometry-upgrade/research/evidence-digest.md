# AntiFan Visual QA — evidence digest (2026-10-09)

User claim: "AntiFan Visual QA rất yếu: không QA được overflow, overlap, element chồng nhau, text đè nhau; chỉ biết chụp hình mà không biết layout có lỗi hay không."

## Architecture (source-verified)
- `src/main/qa/theme-qa-workflow.ts` (1600 LOC) orchestrates: platform, liquid, LayoutOverflowEngine (doc scrollWidth vs clientWidth + culprits), LayoutIntegrityEngine (step 6.5), broken assets, HS rules, server crash, diagnostics. Verdict PASS/FAIL/INCONCLUSIVE.
- Integrity critical findings join verdict; integrity *warnings* only go to `findings.visualAmbiguities` (non-blocking).
- Screenshot: `diagnosticScreenshot.certifying=false` ("cannot certify visual parity"). No image analysis. `anti.visual.compare` = pixel diff vs baseline (detects change, not defects).
- Multi-width: `runResponsiveCheck` (native-tab-host.ts:15033) sweeps 320/375/768/1024/1440 but ONLY measures document horizontal overflow. Integrity detectors run once, active viewport only.

## Integrity engine gates (src/main/qa/scanners/layout-integrity-engine.ts)
- L174 `querySelectorAll('*').slice(0, 2000)` — document-order cap, no truncation flag in result.
- overlap L285-323: skip `getDepth(el) > 6`; max 200 candidates; element-box rects; flagged only if intersection > 60% of smaller box; critical only if one side is actionable, else warning.
- clipping L240-257: only elements with a direct text node; own scrollWidth/scrollHeight > client +2; critical if actionable. No ancestor-clip detection; no ellipsis/line-clamp exemption.
- occlusion L357-372: CTA selector, first 100, center point only, skipped unless center inside current viewport (no scroll sweep), elementFromPoint.
- layout-shift L522-532: `observer.observe({buffered:true}); observer.disconnect();` synchronously — callback is async, never delivered → clsScore always 0.

## Probe 1: 17 fixtures in real Electron 43 Chromium (scratch/visual-qa-probe, current src bundled with esbuild, 375x667 mobile emulation)
15 real defects + 2 intended-design controls. "Verdict" = workflow verdict impact computed from engine output.

| fixture | DOM | AntiFan | oracle prototype |
|---|---|---|---|
| 01 overflow plain | 13 | FAIL (overflow) | - (oracle has no doc-overflow check) |
| 02 overflow masked by body overflow-x:hidden | 13 | FAIL | clippedText |
| 03 overflow masked by wrapper overflow-x:hidden | 13 | PASS (miss) | clippedText |
| 04 text-on-text, depth ~9 | 16 | PASS (miss) | textCollision |
| 05 text-on-text, shallow | 8 | PASS + 1 warning | textCollision |
| 06 partial box overlap 30% | 8 | PASS (miss) | flowOverlap |
| 07 text spills out of fixed-height box onto next block | 14 | PASS + 1 warning | textCollision |
| 08 text cut by ancestor overflow:hidden | 16 | PASS (miss) | clippedText |
| 09 CTA covered, in viewport | 15 | FAIL (occlusion) | coveredText |
| 10 CTA covered, below fold | 16 | PASS (miss) | coveredText |
| 11 fixed header covers hero text | 21 | PASS (miss) | textCollision(5), coveredText(2) |
| 12 CONTROL intended line-clamp/ellipsis | 52 | FAIL, 7 false criticals | 0 |
| 13a footer links overlap, 110 nodes | 110 | FAIL (overlap+occlusion) | caught |
| 13b same defect, 2510 nodes | 2510 | PASS (miss: beyond 2000 cap) | caught |
| 14 CLS 0.207 | 19 | PASS (miss) | n/a |
| 15 absolute image over description, deep | 16 | PASS (miss) | coveredText |
| 16 CONTROL horizontal slider overflow-x:auto | 25 | PASS (correct) | 0 |

Totals on 15 real defects: AntiFan hard FAIL 4 (01,02,09,13a); warning-only 2 (05,07); silent miss 9. Controls: 1 false FAIL (12), 1 correct.
Oracle prototype (text-run Range.getClientRects + clip-aware visible rects + scroll-swept elementFromPoint on text runs + clip-ancestor check, ~140 LOC): 13/15, 0 false positives on controls; misses 01 (no doc overflow — existing engine covers) and 14 (CLS). Oracle FP risk on real themes untested (only 17 synthetic fixtures; fixed-layer handling during scroll is naive).

## Probe 2: CLS witness (cls-probe.cjs)
groundTruthCls 0.2075 (independent observer); `performance.getEntriesByType('layout-shift')` = 0 (not exposed to timeline); sync observe→disconnect delivered 0; engine layout-shift findings [].

## Probe 3: responsive map wiring (responsive-map.ts, real ThemeQaWorkflow, mock ports with the exact host return shape)
Host returns breakpoints keyed by preset id (`mobile-small`, `mobile-standard`, ...) — native-tab-host.ts:15054, 15142 `results[bp.id]`. Workflow reads `responsiveBreakpoints?.[String(w)]` (theme-qa-workflow.ts:894) → never matches.
Input: overflow at 320 and 375. Output: verdict FAIL, findings.overflow width 320 (correct), but `findings.responsive` = documentOverflow:false / criticalOverflow:0 for all 5 widths. Report contradicts itself. Also non-active widths report overlap/clipping/occlusion = 0 (not null) → reads as measured-clean. `isActive` uses overflowResult.viewport.width which the sweep overwrites with the first overflowing width → integrity counts can be attributed to the wrong width [INFERENCE from code L826-838 + L896].
No test asserts `findings.responsive` (grep: 0 hits).

## Prior plans
- plans/260831-1800-antifan-mcp-industrial-overhaul/plan.md: "visual QA blindness" listed as root cause; work focused on image pipeline/artifact transport.
- plans/261006-resilient-qa/plan.md: added integrity engine; "P2: visual-ambiguity escalation list (surface for AI/human review; never fake vision call)"; capture-ladder deferred.
- test/unit/layout-integrity-engine.test.mjs: asserts script text contains 'elementFromPoint', 'scrollWidth > clientWidth', etc. + vm sandbox for measured flag — no real-layout fixture tests.

## Probe 4: 4 public production Haravan homepages, 375x667 mobile, current engines + oracle (real-probe.cjs, verify-real.cjs)
| site | nodes | maxDepth | text elements deeper than 6 | footer doc index | AntiFan integrity findings | oracle hits |
|---|---|---|---|---|---|---|
| phukienmaymoc.com | 2067 | 19 | 96% | 1799 | 0 | textCollision 2, coveredText 3, clippedText 26, flowOverlap 15 (svg path x path) |
| gixjewel.com | 2576 | 22 | 92% | 2377 (> 2000 cap) | 41 (criticals: zero-size 0x0 control; clipping on product-title `<a>` scrollHeight 49-81 > clientHeight 32) | textCollision 8, coveredText 10, clippedText 11 |
| hapas.vn | 4170 | 19 | 91% | 2627 (> 2000 cap) | 20 (criticals: zero-size 0x20 `swiper-slide > ... > a` x10, offscreen) | clippedText 6 (marquee/swiper), flowOverlap 1 |
| unitedvision.com.vn | 1129 | 14 | 91% | 339 | 50 (criticals: offscreen x50, all inside `div#uvMobileDrawer`, closed fixed mobile drawer) | coveredText 4 (under fixed a.f-action-btn / div.badge-project) |

Verified TP/FP:
- AntiFan criticals inspected = FP: unitedvision offscreen = closed off-canvas drawer `div.uv-mobile-drawer` (position:fixed, laid out right of viewport); hapas offscreen = swiper slides with `visibility:hidden` owner + transform scale; hapas zero-size = swiper slide anchors; gixjewel product-title clipping = intended 2-line clamp with ellipsis (screenshot confirms "khắc tê..."), same class as fixture 12. => current engine would mark 3/4 healthy production homepages FAIL on noise, while being structurally blind to the 91-96% of text deeper than depth 6.
- Oracle hits inspected = FP: phukienmaymoc "Copyright © 2026" x "Trang chủ"/"Thông báo" 2px = fixed bottom navigation at viewport bottom during scroll sweep; gixjewel price x product title 66x9px = the line-clamp-hidden 3rd line of the title (Range.getClientRects returns rects for clamped lines; screenshot shows no visual collision). Other visible FP classes: 3D flip-clock countdown (`soon-flip-front/back`, intended stacked text), svg `path x path`, marquee/swiper text "cut by viewport"/"cut by div.swiper" (intended), content under fixed action buttons at some scroll offsets.
- No genuine layout defect confirmed on these 4 sites by either detector (none hand-verified as real).
Conclusion: oracle shows the right *signal family* (text-run geometry, paint-order hit tests, clip ancestors, scroll sweep) but in prototype form it is NOT FP-safe on real themes; needs exemptions for fixed/sticky layers, line-clamp/ellipsis, backface-hidden/3D, scroll containers/carousels, SVG, and closed drawers/visibility:hidden owners.

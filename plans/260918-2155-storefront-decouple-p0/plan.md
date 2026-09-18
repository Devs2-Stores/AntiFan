---
title: "storefront-decouple-p0"
description: "P0 of the MCP architecture refactor: storefront-edit prompts stop receiving the Core clone-lane pack (intent gating in the bridge pre-hook), and trivial pure-CSS edits close the theme QA gate through a validated micro lane instead of the heavy browser pipeline."
status: completed
priority: P0
effort: "1d"
tags: [storefront-decoupling, core-bridge, theme-qa-gate, micro-lane, contract-3.5.0]
created: 2026-09-18
completed: 2026-09-18
blockedBy: []
blocks: []
---

# storefront-decouple-p0

## Overview

First approved slice of the AntiFan MCP architecture-refactor direction (report
"AntiFan MCP — Architecture Refactor Report", reviewed 2026-09-18). The user's
recorded decisions bound this plan:

- **AntiFan Desktop stays the only browser layer** (recorded Core claims
  c-7f9ca8b115ef, c-d4bfab01cd60, c-776e33a24443, c-3956b8d79799). Playwright MCP
  remains an isolated fallback (c-d01073ec7cbf). No browser-primitive delegation,
  no Browser Adapter, no headless-Playwright QA migration is executed here.
- **P0 approved by the user** ("Làm luôn P0"): stop storefront tasks from routing
  through the clone/Core lane, and give trivial theme edits a fast lane.

Root cause of the routing problem: `.omp/hooks/pre/antifan-core-bridge.ts` spawned
`antifan-core pack` for **every** user prompt (dedupe by task hash only, no intent
gating). The pack's PRACTICE_PARITY claims carry clone/dogfood framing ("utilizing
AntiFan's MCP ecosystem and Core engine (packages/site-clone/) to clone…"), which
conditioned trivial storefront edits into the clone lane. Second friction: the
theme-qa-gate hook forced the full browser QA pipeline even for a one-line CSS
change, and that pipeline fails ~45.7% of the time on capture errors.

## Changes

| # | File | Change |
|---|------|--------|
| 1 | `.omp/hooks/pre/antifan-core-bridge.ts` | `classifyTaskIntent(task)` → `clone` \| `storefront-edit` \| `general` (Unicode-boundary regexes, VI + EN). CLONE outranks STOREFRONT_EDIT (mixed tasks keep the reference pack). On `storefront-edit`: no pack is seeded, any earlier pack in the session is dropped (the `context` handler then strips its messages), one `BRIDGE_CONTEXT_SKIPPED` event per distinct prompt. Kill switch: `ANTIFAN_CORE_BRIDGE_GATE=off`. Unclassifiable prompts keep the old always-seed behaviour (fail-open). |
| 2 | `~/.omp/agent/hooks/post/theme-qa-gate.ts` (user scope) | Micro lane: `MICRO_TOKENS` (`qaStatus: QA_MICRO_STATIC` / no-space variant; scans assistant text content only, never tool call arguments or results), `MICRO_MAX_CHANGED_LINES=10` (budget covers total added + deleted/replaced line spans), `MICRO_PATH_RE` = single plain CSS leaf under `assets/` (`*.css`, `*.scss` only; `.liquid` variants strictly excluded), `LIQUID_TAG_RE` = `{{` or `{%`. The hook records what it OBSERVED (`recordMicroEdit`; `write` counts `input.content` lines, `edit` counts added `+` lines plus deleted/replaced range lines; multi-path single call or unobservable shapes fail closed as Infinity + hasLiquid), accumulates across edits per root, and only clears roots whose observed record qualifies. Rejections are logged to `bypassLog`. `clearPending()` drains pending + micro records everywhere (receipt reconcile, TTL prune, global bypass). The reminder names the lane without spelling any token. |
| 3 | `src/shared/annotation-prompt.ts` | Contract bump `3.4.0-lean` → `3.5.0-lean`; `SELF_QA_DIRECTIVE` step 9 defines the micro lane (conditions + declaration payload + "violation ⇒ steps 1-8"); terminal token list gains `QA_MICRO_STATIC (lane 9)`. |
| 4 | `E:\Work\customizes\README.md` | Micro-lane subsection under Cổng 3 (same conditions + Gate-3-sensitive areas never use the lane). |
| 5 | Tests + docs | `test/unit/theme-qa-gate-hook.test.mjs` (+5), `test/unit/context-bridge.test.mjs` (+4, `ENV_KEYS` gains `ANTIFAN_CORE_BRIDGE_GATE`), `test/main/annotation-prompt.test.ts` (+1 test, version pins), `test/main/element-picker-resolution.test.ts` (version pin). `CHANGELOG.md` entry at the top of the file. |

Skill-boundary check (approved item ③): `antifan-dogfood-clone` and
`haravan-stitch-full-run` were verified **already scope-correct** (both trigger on
clone/stitch intents only; neither claims storefront edits). No change made.

## Non-goals

- No browser-layer work: no Playwright delegation, no Browser Adapter, no
  dedicated Chrome profile, no headless screenshot QA (P1/P2 of the report remain
  proposals until separately approved).
- No replacement of `theme.qa_validate` receipts or Gate-3 dual-proof areas
  (Navigation, Slider, Schema SEO, Filter, Cart stay on the full pipeline, even
  CSS-only).
- No Core/Site-Clone removal or refactor (c-eb0424815965 tension surfaced to the
  user; not executed).
- No automatic push/sync of any theme.

## Acceptance criteria

| # | Criterion | Status |
|---|-----------|--------|
| 1 | A storefront-edit prompt returns zero bridge messages and records one `BRIDGE_CONTEXT_SKIPPED` (intent `storefront-edit`); identical re-prompt adds no second event; JSONL evidence matches. | ✅ test |
| 2 | Clone intent still seeds exactly one `core-context-pack`. | ✅ test |
| 3 | `ANTIFAN_CORE_BRIDGE_GATE=off` restores seeding for storefront-edit prompts. | ✅ test |
| 4 | A storefront-edit prompt after a seeded prompt clears the live pack identity; the `context` handler strips earlier pack messages (both the stale one and the first-turn one). | ✅ test |
| 5 | Micro token in assistant text content + qualifying observed edit (single plain `assets/*.css` or `*.scss`, ≤10 total changed lines counting additions + deletions, no Liquid) clears the gate. | ✅ test |
| 6 | Micro token cannot clear: Liquid/structural path (`.liquid` variants never qualify), >10 changed lines (additions or deletions), two files or multi-path single call (fails closed), unobservable shape (ast_edit). | ✅ test |
| 7 | Content-only scan: token in tool call arguments, tool results, or non-assistant messages does not clear; reminder text still contains no token spelling. | ✅ test (existing + new) |
| 8 | Contract 3.5.0-lean propagated to source + both pinned tests; no `3.4.0-lean` outside CHANGELOG history and `plans/` evidence. | ✅ grep |
| 9 | Repo-wide typecheck, compile chain, and `smoke:theme-qa` pass. | ✅ commands |
| 10 | Post-review hardening: multi-file single call, tool-argument token echo, bulk `CUT` deletion, `.css.liquid`, and session leak all fail closed (5 new gate tests). | ✅ test |
| 11 | Bridge verbs/reference coverage: `xóa`/`delete`/`optimize` prompts skip the pack; `giống mẫu tham khảo` keeps it (3 new tests). | ✅ test |
| 12 | Second review round: block-op (`CUT N*`/`PUT N*:`) and `REM` edits fail closed; `theo web đối thủ` routes to the clone lane (2 new tests). | ✅ test |

## Evidence

Fresh runs on 2026-09-18 by the controller (not subagent reports):

| Command | Result |
|---|---|
| `node --test test/unit/theme-qa-gate-hook.test.mjs` | **16 pass / 0 fail** (11 existing + 5 micro-lane) — after the review fixes: **21 pass / 0 fail** |
| `node --test test/unit/context-bridge.test.mjs` | **22 pass / 0 fail** (18 existing + 4 gating) — after the review fixes: **25 pass / 0 fail** |
| `npm run test:file .compiled/test/main/annotation-prompt.test.js` | **13 pass / 0 fail** |
| `npm run test:file .compiled/test/main/element-picker-resolution.test.js` | **12 pass / 0 fail** |
| `npm run typecheck` (`tsc -p ./ --noEmit`) | exit 0 |
| `npm run compile` (native-host shim, emit-integrity, tsc, MCP budget dominance, prune, static, extension, dispatch payload) | exit 0, `.compiled` carries 3.5.0-lean |
| `npm run smoke:theme-qa` | ALL THEME QA VERIFICATION CHECKS PASSED |
| strict `tsc --noEmit` on both edited hooks | exit 0 |
| **Live probe (this session, real user-scope hook)** | Wrote `scratch/qa-probe/assets/probe.css` (2 lines) inside a workspace with `.antifan/`; the 8-result throttle fired the gate reminder on schedule (5th of 8 consecutive tool results) — proof the gate observes controller tool calls in production. The reminder text was the **pre-change** wording: the running host cached the hook module at session start, so the micro lane activates on the next OMP session start (same for the project-scope bridge hook). Probe files are disposable scratch. |

Note: the live probe intentionally does not declare a terminal token (no real QA
pipeline applies to a scratch probe); the armed entry expires by the 10-minute TTL.

## Adversarial review & hardening (2026-09-18)

Independent review by the strongest available model (Kongming, read-only) returned
**REJECT** with 6 findings. All were confirmed against source and fixed in a second
pass (3 parallel workers), each with a defending test:

| Finding | Severity | Fix | Test |
|---|---|---|---|
| Multi-file edit call hid structural files (only the first `[file#TAG]` header was parsed) | BLOCKER | `extractTargetPaths()` collects every header; any call with >1 distinct target records fail-closed (`added = null`), so no token can clear it | `multi-file single call cannot be cleared by micro token` |
| Token visible through assistant tool-call arguments (`JSON.stringify(message)` serialized `tool_calls`), e.g. grepping the token string cleared the gate | BLOCKER | Token scan reads `assistantText(message)` only (content string / `type:'text'` parts); tool arguments are invisible. Applies to the pre-existing bypass tokens too | `token hidden in assistant tool arguments does not clear the gate` |
| Bulk deletion counted as 1 changed line (`CUT 1.=500:` has no `+` lines) | HIGH | `editChangedLines()` counts `+`/`-` lines plus `a.=b:` range spans and single-line forms; `PUT >N:` inserts count 0 (content is `+`-counted) | `bulk deletion cannot be cleared by micro token` |
| Missing edit verbs (`xóa`, `delete`, `optimize`, …) and reference phrasing (`theo website/mẫu`, `tham khảo`) | HIGH | `EDIT_VERB_RE` + `CLONE_INTENT_VI_RE` extended (reference phrasing outranks the edit verb — over-matching clone is the safe direction) | 3 bridge tests, 25/25 total |
| `assets/*.css.liquid` allowed Liquid-logic removal through a static lane | MEDIUM | `MICRO_PATH_RE` accepts plain `*.css`/`*.scss` only; directive step 9, README, CHANGELOG updated in lockstep | `.css.liquid file cannot be cleared by micro token` |
| No `session_start` reset — stale pending state could leak across sessions in a long-lived host | LOW | `session_start` clears pending, micro records, churn sets | `session_start resets state and clears pending gate reminders` |

Re-verification by the same reviewer returned **ACCEPT_WITH_FIXES**: both blockers and
all four original findings confirmed closed, plus two new findings, both landed here:

| Finding | Severity | Fix | Test |
|---|---|---|---|
| AST block ops (`CUT N*`, `PUT N*:`) and whole-file `REM` carry spans the hook cannot observe; the plain `N` prefix counted them as one line | MEDIUM | `editChangedLines()` returns `Infinity` on block-op / `REM` syntax (fail-closed) | `micro lane fail-closed: block-syntax and REM edits cannot be cleared by micro token` |
| `theo web/trang/site đối thủ` phrasing missed the clone-relevance test | LOW | `theo\s*(website\|trang\|web\|site\|mẫu\|tham\s*chiếu\|đối\s*thủ)` | `'chỉnh header theo web đối thủ' seeds core-context-pack` |

Final tallies after both rounds: gate **22/22**, bridge **26/26**, annotation-prompt
13/13, element-picker 12/12, repo typecheck exit 0, compile exit 0, both hooks clean
under strict tsc. The reviewer's final verdict on the patched tree is **ACCEPT**.

## Risks

| Risk | Mitigation / status |
|---|---|
| `classifyTaskIntent` false positives skip a pack a prompt actually needed. | Fail-open for unclassifiable text; skip affects context only, never enforcement (`tool_call` receipt-required policy is untouched); kill switch `ANTIFAN_CORE_BRIDGE_GATE=off`. |
| Micro lane abused to dodge QA for structural change. | Validation is against the hook's own observation, not the declaration; totals accumulate per root; `write`/`edit` only (ast_edit/patch fail closed); Gate-3-sensitive areas stay excluded by rule (README) and the diagnostic value of `bypassLog`. |
| A stylesheet under assets/ could carry Liquid logic. | Disqualified by design: only plain *.css and *.scss qualify; all .liquid variants fail closed (file that can carry Liquid is never static-lane safe). |
| User-scope hook and repo tests drift apart. | The unit suite is the contract test for the user-scope hook (`THEME_QA_GATE_HOOK` env override); test run included here. |
| Pack skipping hides a Core outage in storefront sessions. | Intended: storefront edits do not consume Core. Bridge failure labels still emitted for general/clone prompts. |

## Follow-ups (not in this plan)

- Measure the fast lane on a real run (display:none edit: ≤3 calls / ≤6k tokens /
  ≤15s / 0 `qa_validate` / 0 reminders) — the brainstorm contract's acceptance
  probe.
- P1/P2 of the refactor report (browser consolidation etc.) remain gated on a new
  user decision; the recorded "AntiFan Desktop = sole browser" rulings stand.

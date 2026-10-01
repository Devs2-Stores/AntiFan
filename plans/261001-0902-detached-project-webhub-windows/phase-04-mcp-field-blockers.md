---
phase: 4
title: "MCP field blockers from Levents pixel-gate report (diagnose-first)"
status: done
priority: P1
effort: "1.5d"
dependencies: [1, 2, 3]
---

_(needs the full detached topology: marker, reattach lifecycle, and boot-restored
shells — the symptoms it classifies are exercised under live multi-window state)_

# Phase 4: Field-reported blockers (diagnose → classify → fix only proven bugs)

Field evidence (`E:/Work/customizes/Levents/plans/260920-1833-levents-storefront-rebuild/reports/antifan-pixel-gate-blocked.md`, session jsonl `2026-10-01T08-45-09`):
the pixel-compare workflow — the exact theme-dev QA loop detach exists to serve —
was BLOCKED by three symptoms plus one ambiguous-authority observation.
**Honesty boundary:** the report labels D1's Electron cause `[INFERENCE]`, D2
`[CHƯA XÁC MINH]`, D3's cause unverified; no AntiFan source was changed or proven
at fault. This phase is **diagnose-first**: source probes classify each item as
confirmed-bug / design-constraint / tool-gap. Only confirmed bugs get fixes —
classified gaps get documented verdicts delivered to the user, not code changes.
Detach multiplies window count, so each item worsens under multi-window topology;
probe legs must exercise both topologies.

| # | Symptom (field-observed) | Report section | Verification status | Plan impact |
|---|---------|----------------|---------------------|-------------|
| D1 | `CAPTURE_FRAME_STARVATION` / `TARGET_BUSY_DRAINING` on background/offscreen tab capture | §5.A | `[INFERENCE]` — Electron background rasterization suspected, not proven | If real: unfocused detached window (monitor 2) captures starve → broken QA loop under detach. |
| D2 | `anti.visual.compare` rejects baseline: `"baseline capture state is unverified pending Phase 6 baseline authority certification"` — no discoverable certification producer found in read surface | §5.B | `[CHƯA XÁC MINH]` — producer may exist in unread surfaces | If no producer exists, compare oracle is dead by design → documented gap, user decision. |
| D3 | `TARGET_STALE` on navigate while tab actually loaded (favicon/readyState/DOM observed post-error) | §5.C | cause unverified | If real: flaky probes/e2e; `EXECUTION_TIMEOUT_PENDING_CLEANUP` cascades. |
| D4 | Session authority behaves as single bound tab; `rebind_target` rejects other-project tabs | §6 | `[INFERENCE]` — likely intended fail-closed | Verify + pin as probe invariant; flag if detach weakens it. |

## Requirements

- Functional: reproduce each symptom deterministically; source-trace producers in
  `src/main/mcp/` + bridge + native-tab-host; **classify each** (confirmed-bug /
  design-constraint / tool-gap) with evidence; fix ONLY confirmed bugs;
  pin D4 as tested invariant.
- Non-functional: no behavior change for focused/hub captures; fail-closed
  contract preserved; a classified gap is a valid phase outcome, not a failure.

## Diagnosis paths

- D1: `Page.captureScreenshot` pipeline — grep `captureScreenshot`,
  `CAPTURE_FRAME_STARVATION`, `TARGET_BUSY_DRAINING`, `drain` in `src/main/mcp/`
  and `src/main/browser/`; check offscreen/background `webContents` paint
  behavior; Electron `webContents.setFrameRate`/`paint` gating; occlusion/
  backgrounded-window raster suppression. Multi-window: does an unfocused but
  VISIBLE window (monitor 2) still produce frames? Test unfocused-visible vs
  minimized/occluded separately — remedies differ.
- D2: grep `baseline authority`, `certification`, `leaseToken` producer sites,
  `visual.compare` baseline verification gate — is there a certifying tool
  (`artifact.*`, `verification.*`, `theme_*`, `spec.validate_gate`) or is the
  gate unreachable? If unreachable → file as tool gap + report to user; gate
  itself must not be weakened silently.
- D3: stale-target detection — `TARGET_STALE` producer; `[INFERENCE]` (hypothesis
  only, not diagnosed): webContents-id churn detection may not re-check after
  navigation completes. Reproduce: navigate, observe error while `tabs.list`
  shows loaded URL.
- D4: session/binding model — `rebind_target`, `set_automation_target`,
  `tabs.create`/`tabs.activate` bound-tab flip: intended (fail-closed) or bug?
  Confirm against spec; pin probe row either way.

## Related Code Files

- Read/diagnose: `src/main/mcp/` (visual.compare, capture, navigate, binding
  surfaces), `src/main/browser/native-tab-host.ts` (frame/capture seams,
  `Page.captureScreenshot` call site), `src/main/bridge/bridge-server.ts`
  (dispatch binding, TARGET_STALE producer).
- Modify: per diagnosis only — e.g. D1 frame-production gating IF confirmed;
  D3 stale-check logic IF confirmed; D2 docs-only if gap confirmed.

## Test scenario matrix

| Scenario | Input | Expected |
|----------|-------|----------|
| D1 focused | capture on focused visible tab | passes (baseline pin) |
| D1 unfocused-visible | capture on detached window, unfocused but on-screen | classify: if confirmed bug → fix + must pass; if OS-level → documented typed-refuse |
| D1 occluded/minimized | capture on minimized window | typed refuse acceptable; documented |
| D2 | compare with fresh baseline artifact | either certification path found+documented, or gap reported |
| D3 | navigate then `tabs.list` | classify: confirmed bug → no TARGET_STALE on committed navigation; design → documented |
| D4 | MCP session bound to hub tab, command at detached tab | typed refusal, journaled (invariant preserved) |

## Implementation Steps

1. Reproduce D1/D3 via probe on current build (single window suffices for D3;
   D1 unfocused case needs the detached shell from phase-01).
2. Locate producers; classify each symptom: confirmed-bug / design-constraint /
   tool-gap, with file:line evidence for the verdict.
3. Fix ONLY confirmed bugs (e.g. D1 frame production for visible-unfocused
   windows; D3 stale re-check post-navigation). Design constraints and gaps get
   documented verdicts, not code changes.
4. D2: discovery result → either use producer or report gap to user verbatim.
5. Pin D4 as probe invariant row.

## Success Criteria

- [x] D1 classified + resolved: either capture succeeds on unfocused-but-visible
      detached window, OR OS-level constraint is documented with typed-refuse
      behavior verified. — design-constraint; unfocused-visible proven (probe + leg5b); occluded → typed refuse (R1 residual)
- [x] D3 classified + resolved: either no TARGET_STALE on committed navigations,
      or documented design rationale. — confirmed-bug ×2 fixed; commit-recheck waiter 6/6; probe nav-miss reports typed cause
- [x] Baseline certification: producer found+used, or written gap report
      delivered (no silent dead-end). — producer `anti.visual.promote_baseline` → `baselineRef`; refuse text rewritten
- [x] Bound-tab authority invariant holds under detached topology (probe row). — D4 pins in `target-stale-rebind-contract` 6/6; probe leg5 cross-drive refused `TARGET_MISMATCH`

## Risk Assessment

- D1 may be Electron-level (background throttling of occluded windows is
  OS-driven): if unfocused-VISIBLE still starves, mitigation may need
  `webContents` paint enforcement — risk of renderer churn; fall back to
  documented refuse-with-reason instead of hacks.
- D2 may block the theme QA loop entirely regardless of detach — worst case it
  becomes a standalone fix request; plan records it, doesn't hide it.

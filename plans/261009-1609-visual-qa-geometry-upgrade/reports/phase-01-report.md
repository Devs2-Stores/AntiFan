# Phase 1 Report: Report wiring — width map, checklist

## Task 1.1 — Responsive-width assertions (expected red)

Command: `npx tsx --test test/unit/theme-qa-fail-closed-adjudication.test.ts`  
Exit code: 1

Verbatim key output:
```text
✖ 10. Responsive overflow without culprits fails summary and checklist.responsive (no false PASS, tablet attributed) (164.3204ms)
ℹ tests 28
ℹ pass 27
ℹ fail 1
  AssertionError [ERR_ASSERTION]: Width 768 overflow must reach the per-width map
  false !== true
```

## Task 1.2 — Width-keyed responsive map and nullable measurements

Implemented the responsive map lookup using numeric `width` values from the host breakpoint records. The map now uses nullable counts, reports unmeasured widths as `null`, and uses the integrity scan's measured viewport width to attribute integrity counts.

## Task 1.3 — Integrity criticals clear `checklist.layout`

Expected-red command: `npx tsx --test test/unit/theme-qa-fail-closed-adjudication.test.ts`  
Exit code: 1

Verbatim key output:
```text
✖ 10b. Integrity criticals clear checklist.layout (195.7733ms)
ℹ tests 29
ℹ pass 28
ℹ fail 1
  AssertionError [ERR_ASSERTION]: Integrity critical must clear checklist.layout
  true !== false
```

Updated `checklist.layout` to require both no overflow and zero integrity criticals.

## Phase exit — verification

Command: `npx tsx --test test/unit/theme-qa-fail-closed-adjudication.test.ts`  
Exit code: 0

Verbatim key output:
```text
✔ 10b. Integrity criticals clear checklist.layout (172.3012ms)
ℹ tests 29
ℹ pass 29
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9019.9948
```

Command: `npm run typecheck`  
Exit code: 0

Verbatim output:
```text
> antifan-browser-desktop@1.3.6 typecheck
> tsc -p ./ --noEmit --tsBuildInfoFile .compiled/.tsbuildinfo.typecheck
```

---
phase: 2
title: "Workflow Contracts & Privilege Boundary"
status: pending
priority: P1
effort: "1d"
dependencies: [1]
---

# Phase 2: Workflow Contracts & Privilege Boundary

## Overview

Eliminate contract drift between workflow schemas and execution: typed step params, correct built-in definitions, sender-trust IPC gates, missing artifact handler, and live capability-catalogue reflection.

## Requirements

- Functional: DEF-01 (forbiddenPatterns), DEF-03 (get-artifact handler), DEF-04 (sender trust), DEF-05 (device preset id), DEF-16 (dynamic catalogue), DEF-17 (typed params), DEF-18 (dead param removal).
- Non-functional: persisted legacy workflow defs must still load — no silent drops in `loadFromDisk`.

## Architecture

**Metaphor: compiler AST lowering — with a compat front-end.** `z.discriminatedUnion('type', …)` cannot carry a legacy fallback member (duplicate discriminator values are rejected). Correct design: keep `WorkflowStepSchema` as the discriminated union for NEW steps; in `workflow-registry.ts` `loadFromDisk`/`saveCustom`, run `unionSchema.safeParse` first, and on failure fall back to the legacy `z.record` schema + emit a `WORKFLOW_LEGACY_PARAMS` warning — never silently drop. A lowering pass in the engine normalizes legacy params before capability dispatch.

## Related Code Files

- Modify: `src/main/workflow/workflow-schema.ts` (~31-38: `params: z.record(z.unknown())` → discriminated union + separate `LegacyWorkflowStepSchema`)
- Modify: `src/main/workflow/workflow-registry.ts` (~101 preset id; ~178 forbiddenPatterns; ~227 `loadFromDisk` fallback path)
- Modify: `src/main/workflow/workflow-engine.ts` (~307 remove `attachmentContext`; ~577-584 `file.assert_not_contains` forwarding — NOT ~552-555 which is `file.read`; lowering call site)
- Modify: `src/main/browser/native-tab-host.ts` (~2037-2054 replace 12-stub tool array; ~2070 sender trust on `workflow:run`; add `antifan:workflow:get-artifact` handler)
- Modify: `src/renderer/toolbar.ts` (~1072 `.catch(() => null)` on artifact fetch)
- Verify: `src/main/browser/device-presets.ts` (~47: `phone-iphone14pro` exists)

## Implementation Steps

1. Define per-step Zod schemas (`FileAssertNotContainsStepSchema`, `DevicePresetStepSchema`, `BrowserWaitForSelectorStepSchema`, …) → `z.discriminatedUnion('type', [...])`. Keep `LegacyWorkflowStepSchema` (`params: z.record(z.unknown())`) as a SEPARATE schema — not a union member.
2. `loadFromDisk`/`saveCustom`: `unionSchema.safeParse(def)` → on fail, `legacySchema.safeParse` → on success, load with `legacy: true` flag + warn; on double-fail, quarantine the file (rename `.invalid`) instead of dropping silently.
3. Engine lowering pass `normalizeStepParams(step)`: `forbiddenPatterns[]` → `(p1|p2|…)` regex `pattern`; **alias map first** — `'mobile-iphone-14-pro'` → `'phone-iphone14pro'` (and other legacy aliases) BEFORE validation so existing custom workflows on disk keep working; then validate `presetId` against `device-presets.ts` → throw `INVALID_ARGUMENT` only on genuinely unknown ids (no silent desktop fallback).
4. Fix `workflow-registry.ts`: preset id → `phone-iphone14pro`; `forbiddenPatterns` per new schema.
5. Remove `attachmentContext` from `executeStepWithTimeout` (DEF-18).
6. `native-tab-host.ts`: add `isTrustedSessionVaultSender(event)` gate on `antifan:workflow:run` (DEF-04); renderer-supplied `workflowDef` → read grant unless pre-registered.
7. Add `ipcMain.handle('antifan:workflow:get-artifact', …)` → `controlPlane.artifacts.resolve(id)`, return `null` on failure (DEF-03); `.catch(() => null)` in `toolbar.ts`.
8. Replace the 12-stub array with `this.controlPlane.capabilities.listAll()` — the real accessor is `CapabilityCatalogue.listAll()` (`capability-catalogue.ts:342`), NOT `AntiFanMcpServer.getInstance()` which does not exist (DEF-16). Map `{name, description, risk, inputSchema}` → Hub tool shape `{id: name, name, description, category: risk, permissions: [risk]}`.

## Success Criteria

- [ ] `node .tmp-af-hub-audit/run-builtins.js` → `wf-theme-security-scan` passes step 2; `wf-mobile-pdp-stress-test` applies 390×844 + iPhone UA
- [ ] `node --test --test-force-exit .compiled/test/main/workflow-schema.test.js` (new) — unknown preset rejects; forbiddenPatterns lowers; legacy def loads with warning
- [ ] Hub MCP tab lists live catalogue count (~99), not 12
- [ ] `npm run typecheck` clean

## Risk Assessment

- **Legacy workflow with a `type` value colliding with a new union member but wrong params**: lowering pass normalizes known legacy shapes; unknown shapes stay legacy-flagged and run under old semantics.
- **Sender-trust gate blocks legitimate callers**: whitelist toolbar preload origin + control-plane runtime; covered by existing control-plane IPC tests.
- **`listAll()` exposes grant-gated tools in the Hub list**: display-only reflection — execution still flows through `catalogue.dispatch` which enforces grants; no privilege escalation.

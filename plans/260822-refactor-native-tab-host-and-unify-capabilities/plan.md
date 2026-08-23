# Plan: Refactor NativeTabHost & Unify CapabilityCatalogue

## Overview
Surgically modularize `NativeTabHost` without breaking IPC / public contracts, and unify browser tool capabilities under `CapabilityCatalogue` as the Single Source of Truth for both MCP Stdio and WebSocket Bridge.

## Scope
- **Included (Items 1 & 2)**:
  1. Extract modular helpers from `src/main/browser/native-tab-host.ts`:
     - `src/main/browser/tab-diagnostics.ts` (console/network failures tracking)
     - `src/main/browser/tab-zoom-controller.ts` (zoom math, bounds scaling, shortcuts)
     - `src/main/browser/tab-context-menu.ts` (context menu building)
     - `src/main/browser/tab-bookmarks-manager.ts` (bookmark storage, persistence, CRUD)
  2. Extend `CapabilityCatalogue` and `BrowserControlPort` to cover the complete tool surface (`open-tab`, `close-tab`, `switch-tab`, `diagnostics`, `agent-click`, `agent-type`, `agent-scroll`, `agent-hover`, `agent-move`, `agent-snapshot`, etc.) with proper risk levels and schemas.
  3. Route MCP tools and WebSocket Bridge methods through `CapabilityTransportAdapter.dispatch()` / `CapabilityCatalogue`.
- **Non-Goals (Items 3 & 4)**:
  - DO NOT alter Inspector polling to avoid triggering anti-bot (Google BotGuard / Cloudflare).
  - DO NOT attach CDP debugger to avoid runtime overhead.

## Phases
- [Phase 1: Extract helper modules from NativeTabHost](phase-01-extract-tabhost-helpers.md)
- [Phase 2: Unify CapabilityCatalogue browser toolset](phase-02-unify-capability-catalogue.md)
- [Phase 3: Validate contracts, test suite & regression checks](phase-03-validate-contracts-and-regressions.md)

## Acceptance Criteria
1. All 59 unit/contract tests across 22 suites pass (`npm test`).
2. Integration vertical slice passes (`node --test .compiled/test/integration/*.test.js`).
3. TypeScript compiler emits 0 errors (`npm run typecheck`).
4. `NativeTabHost` line count reduced by 30-40% while keeping all public methods, events, and IPC contracts 100% backward compatible.
5. `CapabilityCatalogue` registers all standard browser capabilities with verified leases, exact targets, and consistent error envelopes.

---
phase: 1
title: "Shop Identity & Settings Data Guard"
status: pending
priority: P1
effort: "4h"
dependencies: []
---

# Phase 1: Shop Identity & Settings Data Guard

## Goal
Establish a deterministic `(org_id, theme_id)` shop identity tuple for Haravan theme workspaces, enforce shop match in `theme.transaction.write_cas`, and block native OMP tool calls (`write`, `edit`) from mutating `config/settings_data.json` directly outside explicit Direct-Edit / Super-Fast modes.

## Enforcement Surface Notice
`theme-qa-gate.ts` is installed as a `post/` hook and its `tool_call` handler returns `void`. It cannot cancel or block native file mutations. Therefore, the active write veto against direct `config/settings_data.json` edits MUST be implemented in `src/omp-hooks/edit-guard.ts` and `src/omp-hooks/edit-guard-policy.ts` (which is installed in `pre/` and returns `{ block: true, reason }` to the OMP hook runner).

---

## Tasks & Steps

### Task 1.1 — Implement Workspace Shop Identity Tuple Resolver
- **Goal:** Resolve `(org_id, theme_id)` from `.haravan-cli_local.json` (primary) or `.workspace-context.json` (fallback).
- **Target files and symbols:**
  - Create: `src/main/qa/shop-identity.ts` (`export interface ShopIdentity`, `export function resolveWorkspaceShop(workspaceRoot: string): ShopIdentity | null`)
  - Modify: `src/omp-hooks/theme-paths.ts` (export `resolveShopIdentity(workspaceRoot: string): { orgId: string; themeId: string } | null`)
- **Steps:**
  1. Define `ShopIdentity`: `{ orgId: string; themeId: string; themeName?: string; source: 'cli_local' | 'workspace_context' }`.
  2. Implement `resolveWorkspaceShop(workspaceRoot)`:
     - Check `path.join(workspaceRoot, '.haravan-cli_local.json')`. If present and valid JSON, read `org_id` and `theme_id` as non-empty strings.
     - Fallback: check `path.join(workspaceRoot, '.workspace-context.json')` or `workspace-context.json`. Read `haravan.org_id` and `haravan.theme_id`.
     - Return `null` if neither provides both IDs.
  3. Mirror this parser into `src/omp-hooks/theme-paths.ts` for zero-dependency hook consumption.
- **Success criteria:** Both functions return `{ orgId: "200001202565", themeId: "1001507718" }` for `E:/Work/customizes/Levents` and distinguish `TestVyan` (`themeId: "1001510621"`) from `Vyantechnology` (`themeId: "1001509080"`).
- **Verify:** Run Node snippet probing both workspaces:
  `node -e "const { resolveWorkspaceShop } = require('./.compiled/src/main/qa/shop-identity.js'); const s = resolveWorkspaceShop('E:/Work/customizes/Levents'); console.log(JSON.stringify(s));" `
  Pass condition: Exits 0 and prints `{"orgId":"200001202565","themeId":"1001507718"`.

---

### Task 1.2 — Implement Tab Storefront Shop Identity Probe
- **Goal:** Extract `(org_id, theme_id)` from a live storefront browser tab to prevent cross-shop contamination. Fail-closed: if either ID cannot be proven from the tab, return `null` (never fabricate).
- **Target files and symbols:**
  - Modify: `src/main/tools/theme-transaction-capabilities.ts` or `src/main/browser/browser-control-port.ts` (`export async function probeTabShopIdentity(browser: BrowserControlPort, targetTabId: string): Promise<ShopIdentity | null>`)
- **Steps:**
  1. In `src/main/tools/theme-transaction-capabilities.ts`, implement `probeTabShopIdentity(browser, tabId)`:
     - Execute script in tab:
       `() => ({ shop: window.Haravan?.shop || null, theme: window.Haravan?.theme || null, href: location.href, hstaticLinks: [...document.querySelectorAll('link[href*="hstatic.net"],script[src*="hstatic.net"],img[src*="hstatic.net"]')].map(e => e.href || e.src).slice(0, 50), headSnippet: document.head.innerHTML.slice(0, 20000) })`
     - Extract `themeId` from `window.Haravan.theme.id` if present.
     - Extract `orgId`/`themeId` from hstatic URLs via regex `/hstatic\.net\/(\d+)\/(\d+)\//` — collect all matches and record which fields were actually observed.
     - **Evidence rule:** the live Mulgati probe (brainstorm audit evidence) observed `Haravan.theme.id` but NO `org_id` source on the storefront. If the live probe finds no `org_id`, return `null` — a tab that proves only `theme_id` is INSUFFICIENT for `settings_data.json` writes (fail-closed per Task 1.3).
     - Return `{ orgId, themeId, observedFields: string[] }` when both IDs are proven, else `null`.
  2. Record probe telemetry: log which sources yielded each ID (`haravan_theme`, `hstatic_url`, `none`) for Phase 6 certification.
- **Success criteria:** Probing a tab returns `{ orgId, themeId }` only when BOTH are proven from live page state; returns `null` for blank/external tabs AND for tabs where `org_id` has no authoritative source. All `settings_data.json` writes remain refused until a real tab demonstrates both IDs.
- **Verify:** Run compile check then live probe evidence:
  `npm run compile`
  Pass condition: Exits 0 with zero diagnostic errors.
  Additionally record the observed fields from one real Haravan storefront tab (via `anti.evaluate` or equivalent) showing whether `org_id` is obtainable; this evidence decides whether Task 1.3's write path can ever pass in production.

---

### Task 1.3 — Enforce Fail-Closed Shop Identity Matching in `theme.transaction.write_cas`
- **Goal:** Require a positively verified `(org_id, theme_id)` match before permitting any mutation to `config/settings_data.json`. Missing workspace identity, missing tab, or blank/external tabs MUST refuse.
- **Target files and symbols:**
  - Modify: `src/main/tools/theme-transaction-capabilities.ts` (`write_cas` execution handler).
- **Steps:**
  1. In `write_cas` handler, check if `relativePath` normalizes to `config/settings_data.json`.
  2. If targeting `config/settings_data.json` in a Haravan workspace:
     - Resolve `workspaceShop = resolveWorkspaceShop(canonicalRoot)`. If `workspaceShop === null`:
       Throw `new CapabilityError('WORKSPACE_SHOP_UNBOUND', 'Cannot mutate config/settings_data.json: workspace lacks valid (org_id, theme_id) in .haravan-cli_local.json.')`.
     - Check `targetTabId` (passed in input or active in session context). If absent:
       Throw `new CapabilityError('TARGET_TAB_REQUIRED', 'Mutating config/settings_data.json requires targetTabId affiliated with the matching storefront shop.')`.
     - Probe `tabShop = await probeTabShopIdentity(this.browserPort, targetTabId)`.
     - If `tabShop === null` (blank tab, about:blank, external domain):
       Throw `new CapabilityError('TAB_SHOP_UNVERIFIED', `Target tab ${targetTabId} does not expose a verifiable Haravan storefront identity. Write refused.`)`.
     - If `(tabShop.orgId !== workspaceShop.orgId || tabShop.themeId !== workspaceShop.themeId)`:
       Throw `new CapabilityError('SHOP_IDENTITY_MISMATCH', `Target tab belongs to shop org=${tabShop.orgId} theme=${tabShop.themeId}, but workspace is org=${workspaceShop.orgId} theme=${workspaceShop.themeId}. Write refused.`)`.
  3. For all other theme files (templates, snippets, assets): standard workspace permissions apply. Allow cross-shop tabs for read-only tools (`anti.inspect.dom`, `anti.screenshot.viewport`).
- **Success criteria:** Attempting `write_cas` on `settings_data.json` with a blank tab, absent tab, or mismatched shop tab throws a specific refusal error. Only a positively verified matching shop tab succeeds.
- **Verify:** Run theme transaction capability unit tests (including blank tab and mismatch tests):
  `node --test --test-force-exit ".compiled/test/main/**/theme-transaction*.test.js"`
  Pass condition: Exits 0 and all tests pass.

---

### Task 1.4 — Implement Pre-Hook Native Write Veto in `edit-guard`
- **Goal:** In `src/omp-hooks/edit-guard.ts`, evaluate `config/settings_data.json` writes BEFORE the `!SCOPED_MODES` early exit, blocking in standard mode (`mode === 'unset'`) and permitting with warning in `[⚡Direct-Edit]` and `[🚀Super-Fast]`.
- **Target files and symbols:**
  - Modify: `src/omp-hooks/edit-guard-policy.ts` (`REFUSAL_CODES`, `planToolCall`).
  - Modify: `src/omp-hooks/edit-guard.ts` (`pi.on('tool_call')`).
  - Modify: `test/unit/edit-guard.test.mjs`
- **Steps:**
  1. In `src/omp-hooks/edit-guard.ts`, inside `pi.on("tool_call")` — BEFORE the existing `if (!(SCOPED_MODES as readonly string[]).includes(session.mode)) return undefined;` early exit and BEFORE any `planToolCall` policy path (the policy's `MODE_UNSET` early return must never skip this check):
     - Extract target paths from `event.input` via `extractTargetPaths(record.input)`.
     - Detect if any path targets `config/settings_data.json` in a Haravan theme workspace:
       `const isSettingsDataWrite = WRITE_TOOLS[tool.trim().toLowerCase()] === true && targets.some(t => /(^|[/\\])config[/\\]settings_data\.json$/i.test(t));`
     - If `isSettingsDataWrite`:
       * Case 1 (`session.mode === "unset"` — standard OMP session):
         Return `{ block: true, reason: "REFUSED_SETTINGS_DATA_DIRECT_WRITE: Direct write/edit to config/settings_data.json is prohibited in standard mode. Use theme.transaction.write_cas with targetTabId to enforce shop isolation, or activate explicit [⚡Direct-Edit]." }`.
       * Case 2 (`session.mode === "direct"` or `session.mode === "fast"`):
         Call `warnSafely(pi, `[edit-guard] Modifying settings_data.json directly for shop org=${shop?.orgId} theme=${shop?.themeId}`)`.
         Allow write to proceed.
     - Only after this check, continue to the existing `SCOPED_MODES` guard.
  2. In `test/unit/edit-guard.test.mjs`, implement 4 explicit tests exercising the ACTUAL `pi.on('tool_call')` hook handler (not only `planToolCall`):
     - Test 1: `mode === 'unset'` targeting `config/settings_data.json` → handler returns `{ block: true }`.
     - Test 2: `mode === 'direct'` targeting `config/settings_data.json` → returns `undefined` (allowed) and emits warning.
     - Test 3: `mode === 'fast'` targeting `config/settings_data.json` → returns `undefined` (allowed) and emits warning.
     - Test 4: `mode === 'unset'` targeting `snippets/header.liquid` → returns `undefined` (allowed, normal edits unblocked).
- **Success criteria:** All 4 mode test cases pass without regressions to existing edit-guard suites.
- **Verify:** Run edit guard unit tests:
  `node --test --test-force-exit test/unit/edit-guard.test.mjs`
  Pass condition: Exits 0 with all test cases passing.

---

### Task 1.5 — Bundle and Verify Pre-Hook Installation
- **Goal:** Verify that `scripts/install-omp-hooks.mjs` bundles `edit-guard` without syntax errors and that the installed hook reflects the new policy.
- **Target files and symbols:**
  - Run: `node scripts/install-omp-hooks.mjs --check`
  - Re-bundle if needed: `node scripts/install-omp-hooks.mjs --install`
- **Steps:**
  1. Run `node scripts/install-omp-hooks.mjs --check` to check for esbuild bundling errors.
  2. If bundle is valid, run `node scripts/install-omp-hooks.mjs --install` to update the active hook in `~/.omp/agent/hooks/pre/antifan-edit-guard.js`.
- **Success criteria:** Hook installer reports `edit-guard: OK` with clean SHA-256 hash match.
- **Verify:** Run check command:
  `node scripts/install-omp-hooks.mjs --check`
  Pass condition: Exits 0 and prints `antifan-edit-guard.js: OK` (or clean status).

---

## Failure Protocol
If any Verify step does not meet its stated pass condition, STOP this phase.
Do not improvise a fix, retry blindly, or reason around the failure.
Spawn the `kongming` subagent for next-step counsel and pass:
- the phase and task id,
- what you attempted (the steps you ran),
- the exact command and its full output,
- the pass condition it failed to meet.
Apply kongming's guidance, then re-run the Verify step.
If `kongming` cannot be spawned in this environment, STOP and report the same
failure evidence to the user. Never continue by self-reasoning.

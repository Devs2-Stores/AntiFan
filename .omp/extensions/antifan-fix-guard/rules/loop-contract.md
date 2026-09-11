# AntiFan B-Lite v2 Fix-Loop Contract

<!-- Inherits Root Agent Invariants (CLAUDE.md / AGENTS.md) as Level 0 Authority. Monotonic Strictness: adds constraints, never relaxes. -->

## 1. Scope & Inheritance Authority
- This contract defines the execution boundaries, safety guarantees, and audit rules for the AntiFan B-Lite v2 fix loop.
- **Level 0 Inheritance:** All agents operating under this loop inherit the global Root Agent Contract (`CLAUDE.md` / `AGENTS.md`).
- **Monotonic Strictness:** Loop-specific rules add domain constraints; under no circumstance may any rule here relax, weaken, or waive Root Level 0 invariants.
- **No Synthetic Snapshots:** The fixer operates directly against the live staged workspace copy. No frozen HTML/CSS DOM snapshot is carried or permitted as an input artifact.

## 2. Enforcement Precedence
1. **Primary Enforcement: Merge Gate (`.canary/tools/fix-loop/merge-gate.mjs`)**
   - Authoritative and physical boundary.
   - The fixer executes exclusively inside an isolated staged workspace copy (`.canary/staging/<runId>/`).
   - Every file modification is diffed against the staged base manifest (`baseManifestHash`).
   - Audit functions (`audits.mjs`) independently verify:
     - `touchedPaths ⊆ allowedFiles`
     - `diffBudget` (|T| and changed bytes)
     - `maxScopeExpansion` (|T \ R|)
     - Base manifest drift
   - Only audited files passing all gates are merged into the actual workspace.
2. **Secondary Enforcement: Pre-Tool Hook (`hooks/pre/tool-guard.ts` / `tool_call`) [CONFIRMED LIVE: SECOND LEVER]**
   - Active in-flight guard verified empirically in Phase 4 probe matrix (2026-09-11).
   - **Observability Scope:** Intercepts tool calls for **BOTH parent session and child subagents** spawned via `task`.
   - When an attempt touches out-of-scope paths or invokes unpermitted tools, the hook immediately returns `{ block: true, reason }` with typed refusal codes (`REFUSED_TOUCHED_PATH`, `REFUSED_TOOL_SURFACE`), naming offending paths and stopping execution before files or tools execute.
   - **Single Audit Source:** Shares identical pure audit functions directly from `.canary/tools/fix-loop/audits.mjs` (`auditTouchedPaths`, `auditToolSurface`) so in-flight hook enforcement and merge-gate post-flight audits cannot disagree.
   - **Physical Authority:** The merge gate remains the authoritative physical boundary and final arbiter regardless of hook execution status.

## 3. Forbidden Moves (Inviolable Negative Invariants)
- **NO Repo-Wide Rollback:** `git checkout -- .`, `git clean -fd/x`, `git reset --hard`, and `git stash` are strictly forbidden. The loop never resets unrelated working-tree files.
- **NO Tolerance Loosening:** Under no circumstances may an agent or runner modify pixel diff thresholds, geometry margins (`tolerancePx`, `tolerancePct`), or image settlement rules to force a pass.
- **NO Self-Verification:** The fixer worker must NEVER verify its own changes, run visual compares, or invoke test runners. Adjudication is the sole prerogative of the AntiFan verification engine. Any return with `selfVerificationClaimed: true` is immediately rejected.
- **NO Scope Self-Expansion:** The fixer cannot widen `allowedFiles[]`, exceed `maxScopeExpansion`, or touch out-of-budget files. When stuck, it MUST report `SCOPE_DISCOVERY`.
- **NO DOM/Style Overrides:** `anti.theme.style_override`, `theme.qa_repair.begin/verify`, `browser.dump_dom`, `anti.agent.cursor.*`, and `anti.browser.evaluate` are prohibited during repair runs.

## 4. Typed Outcomes & Enums

### 4.1 Typed Decision Enum (Exact Strings)
- `OK`: All touched files are within `allowedFiles`, within `diffBudget`, within `maxScopeExpansion`, base manifest has not drifted, permitted tool surface used, no self-verification claimed.
- `REFUSED_TOUCHED_PATH`: One or more paths in `touchedPaths` are outside `allowedFiles` or match `forbiddenPaths`.
- `REFUSED_DIFF_BUDGET`: Touched files count `|T| > diffBudget.maxFiles` OR changed bytes `> diffBudget.maxBytes`.
- `REFUSED_SCOPE_EXPANSION`: Expanded files count `|T \ R| > maxScopeExpansion` (where `R = requestedTargets`, `T = touchedPaths`).
- `REFUSED_DRIFT`: The base manifest hash at merge time does not match `baseManifestHash` recorded at staging time.
- `REFUSED_TOOL_SURFACE`: A tool outside `file.read` / `file.write` or matching forbidden patterns was invoked.
- `REFUSED_SELF_VERIFICATION`: The fixer claimed self-verification or attempted self-adjudication.

### 4.2 Route-Refusal Codes (Exact Strings)
- `URL_HOST_MISMATCH`: Target route host does not match configured store host.
- `URL_THEME_MISMATCH`: Route theme ID does not match active target theme.
- `URL_PATH_MISMATCH`: Resolved pathname does not match expected surface route.
- `URL_EXPECTATION_MISSING`: Route expectation or assertion metadata missing.

### 4.3 Lifecycle States (Exact Strings)
- `FIXED_VERIFIED`: Fix successfully merged by Main and verified by the AntiFan engine against the pinned reference.
- `REFUSED_SCOPE`: Fix requires changes outside `allowedFiles` or exceeded expansion limits; cannot proceed without supervisor scope change.
- `STALEMATE`: Terminal state reached when identical refusal signatures repeat or retry budget is exhausted without progress.
- `SCOPE_DISCOVERY`: Fixer identified missing dependencies or required out-of-scope modifications. Returns cleanly to Main with `missingPaths[]` to request a new FixRequest v2.

## 5. Evidence & Workspace Ownership Split
- **Main Agent (Harness Supervisor):**
  - Owns real workspace source integrity and revision checkpoints.
  - Owns stage materialization (`.canary/staging/<runId>/`) and base manifest hashing.
  - Owns pre-merge content storage (capturing pre-merge bytes of files about to be overwritten).
  - Owns merge gate execution and path-scoped restore (restoring only loop-written files from pre-merge bytes).
  - Owns child agent invocation and prompt briefing.
- **AntiFan Verification Engine:**
  - Owns visual capture, CDP instrumentation, and browser evidence artifacts.
  - Owns metric calculations, layout shift probes, and verdict cause codes.
  - Owns lifecycle state progression (`FIXED_VERIFIED`, `STALEMATE`).
  - **Zero Source Rollback:** The engine has NO code path or permission to mutate, checkout, or restore source files in the workspace.

## 6. Effective Workspace Resolution
- Pinned explicitly via environment variables `THEME_WORKSPACE_ROOT` or `ANTIFAN_WORKSPACE_ROOT` to the staged root directory.
- The path resolver strictly rejects any candidate path containing `.antifan-data` (the internal data directory is never a theme root).

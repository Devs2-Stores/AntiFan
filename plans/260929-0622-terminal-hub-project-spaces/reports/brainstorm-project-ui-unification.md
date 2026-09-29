# Brainstorm: unified Project UI (Terminal Manager + Project Picker)

Status: contract agreed, not planned/implemented. Unresolved questions last.

## Decisions (user, 2026-09-29)
- Surface: one unified flow for both the Terminal sidebar and the Project Picker (Ctrl+Shift+O).
- Category: "Project" replaces "Category" in the Terminal Manager (user-created groups included).

## Contract
- **Outcome:** one Project model (name, colour, pin/star, live run/wait counts, path) shown identically in the sidebar and the picker; every project action (open, new terminal, rename, colour, pin, remove) reachable from one place. Terminal Manager groups terminals by Project, not free-text Category.
- **Constraints:** existing rename/remove IPC (`PROJECT_RENAME`, `PROJECT_REMOVE`) and close-coordinator vetoes stay the authority; remove never deletes files; no loss of existing user groups (migration required); sidebar column is ~220px wide; follow `docs/ui-architecture.md`.
- **Non-goals:** new terminal daemon behaviour, hard spawn caps, auto-sleep (kongming: unsafe for watchers), multi-window redesign.
- **Acceptance:** (1) sidebar headers = projects, with colour/star/rename via the same code path as the picker; (2) existing categories survive restart as projects (or an explicit, tested migration outcome); (3) picker and sidebar show the same name/colour/star for a project; (4) unit + renderer tests for grouping, migration, prefs persistence; (5) live smoke on an isolated instance.

## Evidence (read from source)
- Category prefs are name-keyed and persisted in `saved-tabs.json`: `terminalCategories`, `terminalCategoryColors`, `terminalStarredCategories`, `terminalCollapsedCategories` (`native-tab-host.ts` ~12673-12678, load at ~1725 applies only layout/width/collapsed; normalizers at ~567/591; renderer `standalone.js` ~579-605, 7322-7325).
- Grouping key today: folder key -> capsule key -> `session.category` (`rowGroupKeyOf`, `standalone.js` ~1101).
- Project identity lives elsewhere: `projectId`, `name`, `workspacePath` in ProjectRegistry; picker in `standalone.js` ~4227-4470 (rename/remove inline).
- Contract type `TerminalTabPrefs` (`contracts.ts` 901-929) is the shape to migrate.

## Approaches
1. **Projects as group source (recommended):** key group prefs by `projectId` instead of category name; sessions resolve project via capsule/folder; keep `category` only as read-only migration input. Risk: sessions with no project ("Chua phan nhom") need a defined home.
2. **Category stays, projects link to it:** cheap, but keeps two concepts; contradicts the decision.
3. **Drop groups entirely:** smallest, but loses user data.

## Unresolved
- Where do unassigned terminals live (implicit "Unassigned" project vs. folder group)?
- Migration of existing user categories: convert each to a named project without a path, or drop?
- Whether a project without a path is allowed.

## Addendum 2026-09-29: user's "Project / Terminal / Chrome Management" report
The report supersedes the Category-only framing: Project is the root; Terminal, Chrome tabs and OMP context hang off it; focus is never ownership; ambiguity fails closed. Done-when: choose a Project and AntiFan knows exactly which Terminal, Chrome and OMP context belong to it, including after restart.

### What already exists (read from source)
- Ownership: every terminal row carries `ownerKey` = `project:<id>` / `unassigned` / `agent:*`; `windowSessionScope` decides visibility by that key, not focus (`native-tab-host.ts` ~6387, 6669).
- Explicit transfer: `ASSIGN_PROJECT` validates ids, target window presence, visibility, then `transferSessionOwner` (~4542-4590). Matches report section 6.
- Cross-project guard: `PROJECT_MISMATCH` / `WORKSPACE_MISMATCH` / `POLICY_DENIED` when a terminal-origin session binds a tab in another project (`control-plane-runtime.ts` 635-663; `attachment-registry.ts` 688, 727). Matches sections 15/16 for the agent path.
- Tabs: no `projectId` field on a tab. Ownership is implicit, one project window = one tab host, stamped at listing time (`listSearchInventory`, ~6869). Semantic tab roles exist but are heuristic and URL-derived (`inferTabSemanticRole`: admin/storefront/...), not stored per project.
- Terminal `role`/`idlePolicy`/`spaceTerminalId` exist via Space manifests.
- The toolbar `projectChip` is a read-only identity label fed by Main (`renderProjectWindowIdentity`, `toolbar.ts` 5380); it has no click actions and is not the manager. Tests pin its display only (`project-tab-search.test.ts`).

### Gaps against the report (not yet verified by running anything)
1. No single `resolveProjectContext()`: resolution is spread over window scope, capsule affiliation (`capsuleAffiliation`, ~1359) and control-plane scope. [INFERENCE: grep found no such function.]
2. No stored-vs-runtime reconciliation for terminals/tabs; the only `reconcile` hits are unrelated (accounting, issue register, receipts).
3. Project UI: sidebar groups by Category/folder/capsule, picker by projectId; no shared model, no per-project terminal/tab/OMP health counts.
4. Tab roles per project (storefront/admin/preview) are not persisted, so "open storefront for current project" cannot resolve deterministically.
5. Project switch is per-subsystem, not one operation.

### Proposed answers to the earlier open questions (PROPOSALS, not user decisions; need confirmation)
- Unassigned terminals: proposal - keep `unassigned` owner in its own section; agent actions needing a project fail closed (report section 16). Derived from the report; the user did not answer this.
- Legacy categories: proposal - display-only groups in single-project windows / Unassigned, never ownership. The user only chose "Project replaces Category in the Manager"; the report is silent on existing categories, so this is unconfirmed.
- Project without a path: proposal - refuse for terminal/Chrome ownership. [INFERENCE] from the report's workspacePath-as-identity rule; the user did not answer this.

### Proposed phase order (matches report P0/P1; a plan is still required)
P0a `resolveProjectContext()` in Main as the only resolver; migrate callers. P0b persist tab roles per project in the Space/registry; add tab-to-project fail-closed check on the non-agent paths (user "open storefront"). P0c restore test: close/open keeps terminal records (lazy) + tab records. P1a reconcile stored records vs runtime (dead terminal, gone tab) and surface DEAD/STALE. P1b one Project model shared by picker + manager (name/colour/star/counts) persisted once, keyed by `projectId`. P1c single Switch Project operation. Then freeze.

### Risks
- Persisting a second copy of name/colour/star would create a second state store; the shared model must live in the existing ProjectRegistry, and the sidebar prefs (`terminalCategoryColors` etc., keyed by name) become a legacy read path.
- Do not spawn PTYs on restore (lazy is a report requirement and already the behaviour).
- Not verified in this pass: live app behaviour (restart would end the user's session), and the phase-07 live-smoke item stays open.

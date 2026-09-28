# R1Renderer — shared Terminal Manager: assign a terminal to a capsule

Owner: renderer UX end-to-end (`src/renderer/standalone.html`, `src/renderer/standalone.js`,
`src/renderer/standalone.css`, `src/preload/standalone-preload.ts`).

## What changed

### 1. Preload (`src/preload/standalone-preload.ts`)
- `assignTerminalCapsule(sessionId, capsuleId)` → `ipcRenderer.invoke(TERMINAL_CHANNELS.ASSIGN_CAPSULE, { sessionId, capsuleId })`
  (`TERMINAL_CHANNELS` was already imported for `SET_TAB_PREFS`). Payload keys match the frozen contract.
  Lives beside `setTerminalTabPrefs`, same comment style: the bridge reports the typed reason when it may not act.

### 2. Context menu (`src/renderer/standalone.html`, dispatcher in `standalone.js`)
- New row, `data-action="assign-capsule"`, between `data-action="category"` and `data-action="transcript"`:
  label `Chuyển Terminal sang Dự án… (Move to Project)`, arrow-into-box glyph.
  Distinct from `Đặt nhóm (Set category)...` (grouping) and from the affinity item's `Gán Tab Trình Duyệt...`.
- Label is contextual when the session's capsule is known to the index:
  `Chuyển sang dự án khác… (đang ở <Capsule name>)`.
- Enabled/annotated in `showContextMenu`: `is-disabled` + `aria-disabled="true"` with a `title` explaining
  which of the two applies — a project window (no second project to move into) or an agent-owned session
  (read-only by contract). The dispatcher repeats both refusals as a notice, so a programmatic click
  cannot get further than a real one.

### 3. Searchable capsule picker (`showCapsulePicker`)
- The only new DOM id: **`capsulePickerPopover`** (`<div id="capsulePickerPopover" class="terminal-capsule-picker" style="display:none;">`),
  markup next to the other two popovers. Looked up by id at open time.
  Node classes created in JS: `.terminal-capsule-picker-header`, `-input`, `-hint`, `-list` (`role="listbox"`),
  `-item` (`role="option"`), `-name`, `-path`, `-dot`, `-current`, `-blocked`, plus modifiers `is-empty`,
  `is-error`, `is-disabled`, `is-highlighted`. The popover carries `data-active-session-id`.
- Source of truth: `api.listCapsules()` — read once at boot (it names the manager's capsule sections) and
  forced fresh on every open, so a capsule created in another window is offered without a restart. A failed
  read is recorded and painted as an error row naming Main's own message, never as an empty list.
- Order: capsules that name a project first (name order, Vietnamese collation with a plain fallback),
  then the ones that cannot receive a terminal. Rows: dot (colour derived from the capsule id, same
  helper as category chips) + name + workspace path.
- Marks: the session's own capsule is `aria-disabled="true"` + `.terminal-capsule-picker-current` = `✓ Hiện tại`
  and is not offered as a pick; a capsule with no resolvable project is `aria-disabled="true"` +
  `.terminal-capsule-picker-blocked` = `chưa gắn dự án` with a title saying why. Pickable rows are
  `aria-disabled="false"`.
- Filter: the same tokenizer/matcher as the tab search (`parseSearchTokens`, `tokenMatchesHaystack`,
  `foldForSearch`) over name + `workspacePath`, accent- and case-insensitive, every token required.
  Empty state names the query; the hint reports `matched/total`, the current capsule, and whether the row
  cap (80 of 225+) truncated the list.
- Keyboard/micro-interactions: focus lands in the field; ArrowUp/Down move the cursor (`aria-selected`,
  `scrollIntoView` guarded), Enter picks the cursor or the first pickable row, Escape closes (field-level
  and document-level); click-outside closes (`close()` is shared and idempotent, a newer open closes the
  previous view so its document listeners cannot outlive it). Keydown is stopped at the field so no strip
  shortcut fires while typing. A pick closes first, so a slow round-trip cannot be re-fired.

### 4. Pick flow (`assignSessionToCapsule`)
- Two calls, in this order, because the move route never opens a window:
  `api.openProject(projectId)` then `api.assignTerminalCapsule(baseSessionId, capsuleId)`.
  Only `OPENED`/`FOCUSED` reaches step two; `CANCELLED` and every refusal leave the row where it is.
- A pane's context menu assigns its tab: `findSession(id).splitOf || id` is the session Main owns.
- One in-flight round-trip per session (`capsuleAssignmentsInFlight`), so a second pick cannot race the first.
- Feedback via `showTerminalNotice`: success names the capsule (`Đã chuyển Terminal sang dự án "<name>"`),
  failures name the step and Main's typed reason (`ASSIGN_REFUSAL_TEXT` maps the contract's codes —
  `UNKNOWN_CAPSULE`, `CAPSULE_WITHOUT_PROJECT`, `TARGET_WINDOW_ABSENT`, `UNKNOWN_SESSION`,
  `TRANSFER_UNAVAILABLE`, `MANAGER_AGENT_SESSION_READ_ONLY`, `RUNTIME_DRAINING`, `TARGET_STALE` — anything
  unnamed is shown verbatim, never replaced by a guess). No success is reported that Main did not answer.
- On success the row is re-filed locally (`session.capsuleId` + `renderTabs()`); the next `session`
  broadcast stays authoritative, so a row Main still reports in the old place goes back there.

### 5. Shared-manager reading (`rows/sidebar`)
- `isSharedManagerShell()` = `shellScope.ownerKind === 'unassigned'` (frozen manager definition).
- Only in that shell: rows group under their capsule — section header named by the capsule (path in the
  header title, `data-category="capsule:<id>"`), falling back to today's category key when the row has no
  capsule. Capsule sections refuse rename/colour/star/order and refuse drops, because their name is owned
  by the project store, not by the user (their rows are still draggable sources; catch-all and sleep
  buckets are untouched).
- In the horizontal strip (no headers) a row annotated with its capsule gets `.terminal-tab-capsule-chip`
  (squared left edge + inset accent bar, so it reads as a project label and not as the category chip).
  A row that is in no capsule keeps the category chip exactly as before; the `🎯 Chưa gán` affinity badge
  and its meaning are untouched in every mode. In the sidebar the chip only appears for a capsule row that
  is parked outside its section (the sleep bucket), sized for the column.
- The manager's search folds capsule name + path into each row's haystack, so typing a project name narrows
  to that project's rows.
- The picker's project-less rows and the mint-condition manager (no shell described) draw nothing beyond
  what today's renderer already drew.

## Files touched
- `src/preload/standalone-preload.ts` — `assignTerminalCapsule`.
- `src/renderer/standalone.html` — context-menu row; `#capsulePickerPopover`.
- `src/renderer/standalone.js` — capsule index + picker + pick flow + manager grouping/chip + menu row state.
- `src/renderer/standalone.css` — capsule picker block (mirrors the category picker), capsule chip,
  sidebar-sized chip. `standalone-overrides.css` has no popover rules and was not touched.

## Verification (ran here, scoped)
Throwaway staging (both dirs removed afterwards; the only renderer static-file copies I made were scratch):

1. **Acceptance smoke** — the peers' compiled `standalone-harness.js` + the edited renderer (staged so the
   harness resolves it) driving: manager grouping by capsule, menu label/enable, picker contents/order/marks,
   name+path filtering, empty state, Escape, pick order (`openProject` → `assignTerminalCapsule`), success
   text, `TARGET_WINDOW_ABSENT` refusal, `CANCELLED`, agent-held row, project-window row, failed read.
   Result: **PASS** (11/11 groups).
2. **Existing renderer suite** — `node --test` over the 8 harness-based files
   (`terminal-tab-categories-sleep`, `terminal-tab-layout`, `standalone-project-chip`, `terminal-creation-refusal`,
   `terminal-split-behaviour`, `terminal-tab-activity`, `terminal-gap-state-machine`, `terminal-popout-selection-sync`)
   against the edited renderer: **89/89 pass, 0 fail**.
3. Peer test integration: `test/renderer/terminal-capsule-picker.test.ts` was compiled (strict project flags)
   against the peer harness and run — it exercises the picker but its fixture does not seed a manager shell,
   so the row is inert and it cannot open. Told `T1Tests` the three fixture deltas (seed
   `initialState: { projectWindow: { owner: { kind: 'unassigned' } } }`; reset `apiCalls` after load because a
   manager reads the list at boot for grouping *and* on open; assert row text on the marker spans, not on
   `FakeElement.textContent`, which does not aggregate children).

## What a verifier must run
- `npm run compile` then the peer test:
  `node --test --test-force-exit .compiled/test/renderer/terminal-capsule-picker.test.js`
  (needs the fixture deltas above), plus the renderer regression files named in (2).
- Live surface (Electron): open the manager + two project windows, right-click a tab **in the manager** →
  `Chuyển Terminal sang Dự án…` opens the searchable picker; pick a capsule → the target window opens and the
  terminal moves there (visible in the target window's strip, gone from the manager's section); pick the same
  capsule again → the row is marked `✓ Hiện tại` and refuses; a capsule whose project is unknown → `chưa gắn dự án`.
- Refusal path: kill/close the target project window between open and move, or right-click an agent-owned tab
  (no picker, notice says why).

## Unresolved / notes
- Click-outside dismissal cannot be driven through the shared harness (`document.addEventListener('click', …)`
  is not captured by its document stub; it records `keydown` only). The listener is registered on the same
  10 ms deferral as the category picker's and shares its shape; verified by inspection, not by the harness.
- The manager reads the capsule list twice per picker session (boot + open). Deliberate: boot names the
  section headers, open must not offer a stale list. Stated to T1 as a fixture concern, not a defect.

# Edit-mode guard for Direct and Super-Fast sessions — design

Status: implemented in this session (2026-09-28) and verified in the tree — the unit lanes below pass
against the shipped source, a real `omp` session with a live model was intercepted, and the installer
is proven against omp's own loader. This file is the design record and the acceptance contract now, not
a pre-implementation note; each acceptance criterion below says what has been observed for it.
Specced alongside three sibling designs (capture/focus ownership, Manager bridge health, Manager run
cards) that share the runtime-mirror and installer contracts described here. Symbols are cited by name
and file rather than by line, because every file named here is being edited while this lands — grep the
symbol.

Date: 2026-09-28

## Intent

`[⚡Direct-Edit]` is a promise the product already makes to the person using the Element Picker: this
annotation wants direct source work, no Core retrieval, no ceremony. Today the promise is only half
kept, and only inside AntiFan's own repository:

- The prompt tag exists (`QUEUE_PREFIX`, `DIRECT_TAG`, `CORE_TAG`, `src/main/browser/element-picker.ts`)
  and the popup defaults to Direct (`test/main/element-picker-resolution.test.ts`).
- The tag is interpreted by **one repo-scoped hook**: `antifan-core-bridge`
  (`.omp/hooks/pre/antifan-core-bridge.ts`) latches anti-direct per session
  (`state.antiDirect`, `process.env.ANTIFAN_ANTI_DIRECT`), strips Core pack messages from `context`,
  and refuses Core retrieval with `REFUSED_CORE_RETRIEVAL_POLICY` (`isAntiDirectForbiddenTool`).
- In a customer workspace — the place Direct-Edit actually matters, e.g.
  `E:/Work/customizes/Comnieusiba`, `E:/Work/customizes/Phukienmaymoc` — **no hook reads the tag at
  all**. User-scope `~/.omp/agent/hooks/pre/` is empty, and the only user-scope hook is
  `theme-qa-gate` (post). So in those sessions Direct-Edit changes nothing except the prompt text.
  *(Pre-implementation audit state, 2026-09-28: it changed when this design landed — the user-scope
  `pre/` hook is now `antifan-edit-guard.js`, and the installed gate reads the mode tag and silences
  itself under it. The paragraph is kept as the problem statement this design answers.)*

The outcome this design owns: **the mode is real, enforced, observable, and survives resume** in every
session — AntiFan repo, customer theme workspace, or a plain terminal — and it is cheap enough that the
person who typed the tag feels the difference in the first minute.

## Evidence (today's audit, 2026-09-28)

1. Customer session `Comnieusiba` (session `01a0e559`, cwd `E:/Work/customizes/Comnieusiba`) ran with
   `[⚡Direct-Edit]` in the picker prompt and still spent the session in dispatch/QA ceremony: skill
   routing reads, `theme-qa-gate` reminder on every tool result, and two live-MCP probes that returned
   `CONNECTION_FAILED` / `BRIDGE_UNREACHABLE` (`127.0.0.1:20130` / `:20129`).
2. `theme-qa-gate` (user scope, `C:/Users/Admin/.omp/agent/hooks/post/theme-qa-gate.ts`) owns
   `RECEIPT_DIR = ".antifan/qa-receipts"`, `isThemeCwd()`, `findAnnotationWorkspace()` — it is the
   workspace-aware hook already installed everywhere. It also emits `REMIND_EVERY = 1`: one reminder per
   unmarked tool result, which is the noise Direct-Edit is supposed to remove.
3. The repo's enforcement extension `.omp/extensions/antifan-fix-guard/index.ts` is **inert**:
   `isForbiddenTool()` returns `false` unconditionally, so its `tool_call` handler can never block.
   It is repo-scoped, so it could not serve customer sessions even if it worked.
4. AntiFan MCP calls are not addressable by tool name: OMP drives them through the generic `write`/`read`
   tools with `input.path = "xd://mcp__antifan_browser_*"` (evidence: `Comnieusiba` transcript,
   `write` with `path: "xd://mcp__antifan_browser_anti_browser_tabs_list"`). Any mode policy must read
   the target path, which the bridge hook already does (`classifyReceiptRequired`,
   `isAntiDirectForbiddenTool` classify `xd://` device paths).
5. Live OMP probe (throwaway hook, `omp -p --hook`, then `omp -p -c`):
   `before_agent_start` fires **per prompt** with `event.prompt`; `ctx.sessionManager.getSessionId()` is
   stable across resume; `pi.appendEntry(customType, data)` persists and is readable from
   `ctx.sessionManager.getBranch()` on the next `session_start` (one custom entry observed after
   resume); `ctx.abort` exists; `agent_end` may fire repeatedly mid-run.
6. Hook discovery, from `omp://hooks.md`: project `<cwd>/.omp/hooks/{pre,post}/*.{ts,js}`, user
   `~/.omp/agent/hooks/{pre,post}/*.{ts,js}` (profile- and `PI_CODING_AGENT_DIR`-aware). Cross-tree
   relative imports from a hook/extension file already work in this repo — the inert fix-guard
   extension imports `../../../.canary/tools/fix-loop/audits.mjs`.
7. Bundler available: `esbuild ^0.28.2` in `devDependencies`; `scripts/build-extension.mjs` is the
   existing pattern for importing it from an `.mjs` script.

## Decisions

1. **One derivation function, three consumers.** `deriveEditMode()` in `src/omp-hooks/edit-mode.ts`
   returns `unset | core | direct | fast` plus the trigger. The new user-scope guard, the repo
   `antifan-core-bridge`, and `theme-qa-gate` all import it. The bridge's three private matchers
   (`ANTI_DIRECT_TAG_RE`, `CORE_CONTEXT_TAG_RE`, `ANTI_DIRECT_NL_RE`) are deleted by that import so the
   surfaces can never disagree; its `detectAntiDirectIntent` survives as a thin adapter that calls
   `deriveEditMode` and maps the decision onto arm/disarm (it no longer owns a pattern of its own).
2. **Modes are annotation-scoped, armed by signal, reset by silence.** A prompt carrying a mode tag
   (`[⚡Direct-Edit]`, `[🚀Super-Fast]`, `[🧠Core-Context]`) or the anti-direct skill/natural-language
   arms that mode for its own run. A prompt with **no signal disarms** — the mode belongs to the
   annotation that carried it, so the next plain message is normal chat again. (Revised 2026-10-02:
   the original latch-until-Core design trapped sessions in Super-Fast — one tagged annotation
   poisoned every following message.)
3. **The mode is a mode, not a prison.** Three exits exist and are the contract: a plain prompt
   (the default path — silence resets to `unset`), the Core tag in any prompt, and the file-based
   `%ANTIFAN_DATA_ROOT%/edit-guard.json` write allow-list extension. **`/anti-direct off` is not an
   exit** — it is not implemented, and the skill matcher (`ANTI_DIRECT_SKILL_RE`) matches
   `anti-direct` inside it, so typing it *arms* Direct-Edit. Implementing one means matching an
   explicit off-form before the skill matcher and resolving it to `core`/`unset` (its own change,
   with the disarm test in the lane below).
4. **Enforcement is path-scoped, not tool-scoped, wherever a path exists.** Write/edit refusals are
   decided by the resolved target path; tool blocks are a short, named list.
5. **Fail closed when the workspace shape is unknown.** No theme root and no `.antifan/` ⇒ no writes at
   all, with a refusal that says how to leave the mode.
6. **The guard is user scope, installed from repo source by a script with `--check`/`--install`/
   `--rollback`.** `~/.omp/agent/hooks/` is a live directory for every session on this machine; it must
   never be hand-edited, and the repo must be able to prove what is installed and undo it.
7. **QA is skipped, not forbidden, in Direct/Fast.** The gate stops demanding receipts and instead
   states once, at `turn_end`, what was changed and that QA was skipped.

## Mode derivation

`deriveEditMode(prompt, latched)` inspects, in order:

| Signal | Result |
| --- | --- |
| `/\[[^\]]*super[- ]?fast\]/i` in the prompt | `fast`, trigger `annotation_tag` |
| `/\[[^\]]*direct[- ]?edit\]/i` in the prompt | `direct`, trigger `annotation_tag` |
| `/\[[^\]]*core[- ]?(?:context\|pack)\]/i` in the prompt | `core`, trigger `annotation_tag` |
| `/\b(?:skill:)?anti-direct\b/i` in the prompt | `direct`, trigger `skill_invocation` |
| `ANTI_DIRECT_NL_RE` in the prompt | `direct`, trigger `natural_language` |
| otherwise | `unset`, trigger `none` (the tag's scope is its own prompt) |

`ANTIFAN_EDIT_MODE` (`unset\|core\|direct\|fast`) seeds the latch at `session_start` (and on lazy
session creation), which is what a spawned subagent inherits; the session branch entry
(`antifan.edit-mode`) does the same across resume. Either way the latch only covers the gap before
the first prompt: the prompt's own signals decide the run, and a prompt with no signal ends the
armed mode rather than continuing it.

The tag regexes accept the emoji spellings the picker emits (`[⚡Direct-Edit]`, `[🧠Core-Context]`) and
the plain spellings a person types (`[Direct-Edit]`, `[Super-Fast]`, `[Core-Context]`) because
`[^\]]*` absorbs the emoji, exactly as the bridge's current `ANTI_DIRECT_TAG_RE` already does.

Natural-language arming (`ANTI_DIRECT_NL_RE`: `sửa trực tiếp`, `không tra core`, `tắt core`,
`bỏ qua core`, `skip core`) **arms Direct but is never required to disarm it** — the bridge already
behaves this way today, and the guard keeps it.

## Persistence and mirrors

Verified by the probe, so the mode needs no bespoke storage to survive resume:

- **In-session:** module state keyed by `ctx.sessionManager.getSessionId()`.
- **Across resume:** `pi.appendEntry("antifan.edit-mode", { mode, trigger, cwd, at })` on every change; on
  `session_start` the hook replays `ctx.sessionManager.getBranch()` for the last
  `type === "custom" && customType === "antifan.edit-mode"` entry. The bridge hook's
  `session.compacting` handler is the precedent for keeping identity across compression.
- **For the AntiFan UI (S4 consumes this):**
  `%ANTIFAN_DATA_ROOT%/runtime/edit-mode/<ompSessionId>.json`, written atomically (temp file + rename,
  the pattern `WorkspaceCapsule.persist()` already uses), shape
  `{ schema: 1, ompSessionId, mode, trigger, cwd, terminalSessionId?, at }`. `terminalSessionId` is
  taken from `ANTIFAN_TERMINAL_SESSION_ID` when present. Written on every mode change and on
  `session_start`; deleted on `session_shutdown` unless the mode is latched non-`core`. If
  `ANTIFAN_DATA_ROOT` is unset the mirror is skipped and the guard still enforces — the mirror is
  observability, never authority.

## Enforcement policy

`resolveWorkspaceShape(cwd, env)` (in `src/omp-hooks/theme-paths.ts`) walks up at most 12 levels from
`cwd` and returns
`{ cwd, workspaceRoot, annotationRoot, themeRoot, editableRoots, rootFileDirs, allowExtraPaths, configError }`
(`workspaceRoot` = `annotationRoot ?? themeRoot ?? cwd`, and it is where the audit log lives):

- `annotationRoot` — the nearest ancestor containing `.antifan/`, exactly the `findAnnotationWorkspace()`
  rule the gate already uses, including its 12-level bound. Consequence worth stating: on a machine whose
  home directory carries `.antifan/`, every directory below it is annotation-bound, so a scoped session
  started in a throwaway directory is bound to home. That is the gate's existing behaviour, the refusals
  below still apply, and it is a scope rule rather than a security boundary.
- `themeRoot` — the nearest ancestor with **strong** theme evidence: `.hrv-sync-state.json`, or
  `templates/` next to at least one of `layout/ sections/ snippets/`. A lone `config/` or `assets/`
  directory does not qualify — those names are far too common outside themes.
- `editableRoots` — the theme root's `layout|templates|sections|snippets|assets|config|locales`
  directories that actually exist, plus workspace bookkeeping `.antifan/ .qa/ plans/ reports/ docs/
  specs/ tmp/`, plus any absolute path in `edit-guard.json` `allowExtraPaths`.
- `rootFileDirs` — the theme root and the workspace root; a file directly inside one of them is
  writable when its extension is one of `.json .md .liquid .txt` (theme metadata such as
  `settings_schema.json`, and workspace documents). A root-level `*.js` is not.

Refusal table (write/edit-like tools: `write`, `edit`, `ast_edit`, `patch`, `append`, any
`xd://file_write` device path) — **Fast only**; see the mode table below:

| Situation | Code |
| --- | --- |
| Target resolves outside `themeRoot` (or outside `cwd` when no theme root, and no allow-list entry covers it) | `REFUSED_EDIT_SCOPE` |
| No theme root, no `.antifan/`, no allow-list entry | `REFUSED_THEME_ROOT_UNRESOLVED` |
| Mode `unset`/`core`/`direct` | not enforced |

Tool blocks (revised 2026-10-02 — Direct refused `task`/`eval` and scoped writes; the contract is now
"Direct suppresses Core, nothing else"):

| Mode | Blocked | Code |
| --- | --- | --- |
| `direct` | **nothing locally** — no Core pack, Core retrieval refused by the bridge (`REFUSED_CORE_RETRIEVAL_POLICY`); dispatch, eval, shell, devices and out-of-theme writes all pass | — |
| `fast` | `task`, `eval`, `bash`, `web_search`, **every device path on any tool** (`xd://…` or `mcp://…`, whatever the tool is), and tool names matching `^(anti\|theme\|browser)\.` or `mcp__antifan_browser_*` | `REFUSED_FAST_MODE_TOOL` / `REFUSED_FAST_MODE_MCP` |

Two consequences of that row, both true in the shipped policy (`edit-guard-policy.ts`) and both easy to
read past: a `write` whose `path` is `xd://file_write` is refused as **`REFUSED_FAST_MODE_MCP`**, not by
the scope table — the device check runs before the path check, so `xd://file_write` never reaches
`REFUSED_EDIT_SCOPE` in fast mode (`test/unit/edit-guard.test.mjs` pins a `read` on `xd://lsp` the same
way); and the device rule is *any* device, not only MCP devices — none of it applies to Direct, which
refuses no tool or path at all.

Direct's enforcement lives entirely in `antifan-core-bridge`: pack seeding is skipped and Core
retrieval/search calls are refused with `REFUSED_CORE_RETRIEVAL_POLICY`. Everything else — dispatch,
eval, shell, `anti.*`/`theme.*` inspection, writes anywhere — behaves as an unscoped session. Fast is
the "no shell, no browser, no dispatch, just files" mode.

Subagent sessions inherit the parent's mode through the **env latch**, not through a kind check: on
`session_start`/`before_agent_start` the guard writes `ANTIFAN_EDIT_MODE` into the process env
(`applyEnvMirror`, `src/omp-hooks/edit-guard.ts`) and a new session resolves its mode as
`readEditModeEnv() → readEditModeFromBranch() → 'unset'` (`buildSession`). So a subagent that runs in
the same process, or in a child process that inherited the environment, is armed with `trigger:
env_latch`; a session started by some other route with no env var and no branch entry starts
`unset`. Under the prompt-scoped contract the latch only covers tool calls that precede the child's
first prompt — the first prompt's own signals decide the run, and a signal-less prompt ends the mode.

Refusals are returned as `{ block: true, reason }`. Every refusal and every allowed write is logged —
never thrown — because a hook that throws turns a policy into an outage.

**A call the wiring could not classify is a refusal while the session is `fast`-scoped.** If the
`tool_call` handler fails before the policy runs (an unreadable context, a workspace read that
vanished), the fallback reads the scope from the session record and then from the env latch, and
refuses with `REFUSED_GUARD_ERROR` instead of passing the call through: an unclassified call has not
been cleared, and clearing by failure is the one outcome the guard exists to prevent. `direct` and
unscoped sessions fall through — Direct has no local refusals to protect, so a failure invents none;
an unscoped session has nothing to enforce, and a stuck write tool would be an outage — which is also
why the arming handlers (`session_start`, `before_agent_start`) keep their silent catch: a failed arm
leaves a session unscoped, which the person sees immediately as missing refusals and can re-issue.

## Audit log (shared contract with the Manager run card)

Append-only JSONL at `<workspaceRoot>/.antifan/edit-guard/<ompSessionId>.jsonl`, one row per decision —
and one row **per target** for a call that names several, since the guard maps its plan's targets. `path`
is the resolved absolute target for a file call, the device URI for a device/MCP call, and empty when the
call names neither (a blocked `bash`/`task`/`eval`):

```json
{"ts":"2026-09-28T14:36:12.011Z","runSeq":3,"mode":"fast","tool":"edit","path":"E:/Work/customizes/Comnieusiba/sections/hero.liquid",
 "decision":"block","code":"REFUSED_EDIT_SCOPE","terminalSessionId":"term-...","ompSessionId":"01a0..."}
```

`runSeq` increments on each `before_agent_start`, so a "run" in the Manager means the same thing in both
designs. `workspaceRoot` is the annotation-bound ancestor, the same rule `theme-qa-gate` uses.

## QA gate: skip, then say so once

`theme-qa-gate` moves its source into the repo (`src/omp-hooks/theme-qa-gate.ts`, installed to
`~/.omp/agent/hooks/post/antifan-theme-qa-gate.js`) and gains one rule at the top of its `tool_result` handler:
when the session's mode is `direct` or `fast`, the reminder path returns early — no `GATE_MARKER`
append, no receipt demand, no churn or MCP-first advisories. Instead `turn_end` appends exactly one line:

```
[edit-guard] Direct-Edit: 3 file(s) changed — storefront QA skipped (send [🧠Core-Context] to run it)
```

The file count comes from the audit log rows of the current `runSeq`, which is also what S4's
change-review card reads. Precisely, and this is the version the gate implements: it takes the
**maximum** `runSeq` present in the session's log and counts that run's `allow` rows (deduped paths) —
it never learns the live run number from the guard, so a turn whose run logged nothing (all reads, no
writes) reports the previous logged run's count rather than `0`. That is stated here because it is a
limit of the instrument, not a hidden bug: an empty change list and "this run changed nothing" are
different facts, and the count is the first, never the second. `runSeq` continuity across resume is
landed (`lastRunSeqInLog` seeds it in `buildSession`; see S4's correlation rule): the guard continues
from the log's maximum, so "the latest run" and "the current run" cannot drift apart after `omp -c`.
One line per turn replaces
`REMIND_EVERY = 1`'s reminder-per-result, which is the whole point: the 17 reminders observed during a
46-minute bridge outage collapse to one sentence.

## Installer

`scripts/install-omp-hooks.mjs` (esbuild, `--check` / `--install` / `--rollback`):

| Mode | Behaviour |
| --- | --- |
| `--check` | Bundle each entry in memory, compare SHA-256 against the installed file; print `IN_SYNC` / `STALE` / `MISSING` per hook and exit non-zero on drift. Never writes. |
| `--install` | Bundle `src/omp-hooks/edit-guard.ts` and `run-state.ts` → `~/.omp/agent/hooks/pre/antifan-edit-guard.js` / `antifan-run-state.js`, and `theme-qa-gate.ts` → `~/.omp/agent/hooks/post/antifan-theme-qa-gate.js`; every hook is bundled before anything is written, an earlier file at the target is copied to `<name>.bak`, and a legacy un-prefixed file (`theme-qa-gate.ts`, an earlier manual install) is parked as `<name>.bak` so discovery never loads two copies of one gate. Refuses to run when the bundle fails to build. |
| `--rollback` | Restore every `<name>.bak` over its hook (and every parked legacy file over its own name); three outcomes per hook — `RESTORED` (backup copied over), `DISCARDED` (no backup: the installed file is renamed `<name>.discarded`), `NO_BACKUP` (neither exists). The manifest is left in place, and the summary reports how many hooks were restored. |

The `HOOKS` array carries a fourth consideration worth naming: entry 2 is `run-state.ts` **with
`optional: true`**, and that flag is load-bearing. `--install` without the flag *throws* on a missing
source ("mandatory hook source not found") — which is exactly the state of this repo until S4 lands its
hook — so the entry is optional-by-declaration, and the installer reports `SKIPPED_ABSENT` for it today.
Adding S4's hook therefore needs no installer edit; it starts installing the moment the source exists.

The script writes a manifest `~/.omp/agent/hooks/.antifan-hooks.json`
(`{ schema, installedAt, repoRoot, node, hooks: [{ id, path, sha256, source, superseded }] }`); `--check`
reads it to name drift rather than guessing, and it honors `PI_CODING_AGENT_DIR` so the whole installer
is testable against a temp agent dir. Hooks are bundled as self-contained **ESM** (`esbuild --bundle
--format=esm`) so no `node_modules` resolution happens at load time in a customer workspace. ESM is not
a style choice: the extension runner imports the file and takes the factory with
`typeof mod === "function" ? mod : mod.default`, and a bundled **CJS** module does not survive that path
— installed live it fails with `Extension does not export a valid factory function` for both hooks,
while the identical bytes imported by hand in Bun do expose a function `default`. The installed file
keeps the `.js` extension because hook discovery scans `*.{ts,js}` only (`.mjs`/`.cjs` are not
discovered), and the loader is syntax-driven rather than extension-driven. `package.json` gains
`hooks:check`, `hooks:install`, `hooks:rollback`.

## Prompt surface

The mode must be reachable without hand-typing tags. `element-picker.ts` gains the third mode chip
(`[🚀Super-Fast]`) beside the existing `[⚡Direct-Edit]` (default) and `[🧠Core-Context]`; the chip logic
stays single-select over the mode slot, exactly as `test/main/element-picker-resolution.test.ts` pins it
today.

**Correction (2026-09-28, verified against the tree):** this section originally claimed that
`ANTIFAN_EDIT_MODE` is "also set by the AntiFan main process on terminal spawn when the user launches a
terminal through a mode-scoped affordance — a two-line change on top of the env block in
`TerminalManager`". That is not true of the shipped code and the affordance it names does not exist:
the picker's mode travels as a *tag inside the composed prompt* (`AnnotationManager`, which writes the
annotation and images and spawns nothing), no main-process path launches a terminal with a mode, and
`ANTIFAN_EDIT_MODE` has no writer outside the guard itself (`applyEnvMirror`,
`src/omp-hooks/edit-guard.ts`, read back by `inheritedEditMode` in the core bridge). The env channel
therefore works exactly as designed — a spawned child process inherits the parent session's mode — and
nothing in `src/main` stamps it. Stamping it at spawn would need a real affordance to attach to (which
terminal gets which mode at launch is a product decision, not a two-line change), and a value read at
spawn time would be `unset` for every fresh session, because the mode is resolved from the prompt or
the guard's latch after the process starts.

## Non-goals

- No OS-level sandbox: Direct permits everything the unscoped session does (including `bash`), and
  Fast refuses the shell at the tool layer only. The guard is a mode for a cooperative agent plus an
  audited refusal trail, not a security boundary; the honest claim is "refuses and logs", not
  "cannot".
- **The host-bridge prelude is outside the interception surface.** `omp://hooks.md` states it
  directly: eval prelude invocations such as `browser.open(...)`, direct `BrowserTab` helpers,
  `tab.run(...)`, direct `computer` helpers and `computer.run(fnOrCode, options)` "are host bridge
  calls, not AgentTool calls, so they do not emit `tool_call` or `tool_result`". The guard therefore
  never sees them: no block, no audit row, and a `computer.run(fnOrCode, …)` body runs in the app's
  own context where no path policy applies. In Fast the `eval` *tool* is blocked
  (`FAST_BLOCKED_TOOLS`), covering the tool-layer surface; in Direct nothing is blocked, per the
  revised contract. Do not read Fast as "the agent cannot change the storefront"; read it as "the
  agent's *tool* calls are refused and logged, and the one tool that would carry it past that
  boundary is refused too".
- No change to the Core retrieval policy owned by `antifan-core-bridge` beyond the reset wiring —
  `REFUSED_CORE_RETRIEVAL_POLICY` and the pack skip are unchanged.
- The inert `.omp/extensions/antifan-fix-guard` extension is left untouched (deleting it is a separate
  call for its owner); this design neither depends on it nor claims it enforces anything.
- No new mode beyond `core | direct | fast`.

## Tests

`test/unit/edit-guard.test.mjs` (same loader pattern as `test/unit/anti-direct-policy.test.mjs`: the
modules are loaded **once** at top level, and each case builds a fresh hook instance through the
factory over synthetic `pi.on` handlers — which also means module-level state such as the guard's
`sessions` Map outlives a case, so cases must use distinct session ids rather than assume a clean module):

- tag parsing: emoji and plain spellings, case-insensitive, side by side with an unrelated chip tag
  (`[🎨Theme-Fix]`), and a prompt whose only tag is Core.
- scope semantics: a tag arms the mode for that prompt; a tagless prompt resets to `unset` (normal
  chat); Core tag disarms; `/skill:anti-direct` arms.
- resume: `session_start` rehydrates the mode from a branch containing an `antifan.edit-mode` custom
  entry — enough to scope tool calls that precede the first prompt — and that first prompt decides
  the mode for the run; starts `unset` when the branch has none.
- scope table, on a real temp workspace fixture (`.antifan/`, `templates/`, `assets/x.scss`,
  `../outside/evil.liquid`): allow `assets/x.scss`; refuse `../outside/evil.liquid` with
  `REFUSED_EDIT_SCOPE`; refuse everything with `REFUSED_THEME_ROOT_UNRESOLVED` when the fixture has
  neither `.antifan/` nor theme dirs; honour `allowExtraPaths`.
- tool blocks: `task`, `eval`, `bash`, `web_search` and `write` with
  `path: "xd://mcp__antifan_browser_anti_browser_tabs_list"` refused in Fast; every call — including
  `task`, `eval` and out-of-theme writes — allowed in Direct.
- subagent inheritance: a subagent session under a Fast parent refuses a write until its own first
  prompt decides the mode.
- audit log: rows appended with the right `decision`/`code`, `runSeq` increments on
  `before_agent_start`, and the file is created under the annotation-bound root. Only a call that
  can change a file leaves a row — a `read` (or any other path-carrying but non-mutating tool) leaves
  none, because the count the run summary prints is taken from these rows.
- mirror file: written atomically on change, removed on `session_shutdown` (unless the mode is
  latched non-`core`, per "Persistence and mirrors"), skipped when `ANTIFAN_DATA_ROOT` is unset, and
  never throws when the directory is missing.
- hostile inputs: `input` absent, `path` non-string, a 10 MB prompt, a malformed `edit-guard.json` — all
  produce a refusal or a no-op, never a throw. A handler that fails before the policy runs is a
  refusal while `fast`-scoped (`REFUSED_GUARD_ERROR`), not a no-op; `direct` and unset sessions pass
  the call through.

`test/unit/theme-qa-gate-hook.test.mjs` (existing file, extended): Direct/Fast mode ⇒ zero reminders
across six unmarked tool results; one `turn_end` summary line naming the changed-file count; Core mode ⇒
today's behaviour unchanged.

`test/unit/install-omp-hooks.test.mjs`: `--check` reports `STALE` after a hand-edit and `IN_SYNC` after
`--install`; `--install` writes through a temp file (no `.tmp` debris), and a target it cannot write
exits non-zero without recording a manifest instead of half-installing; `--rollback` restores
byte-identical content; the installed file is an ESM default export and carries no CJS export shape
(`module.exports`, `require(`), because a CJS bundle fails in omp's own loader while every other test
still passes.

`test/main/element-picker-resolution.test.ts` (extended): the Super-Fast chip is single-select with the
other two modes and survives an action-chip click.

**Interception proved in a real session, not only under Bun.** `node scripts/smoke-edit-mode-guard.cjs`
drives a real `omp` process with a live model against a temp theme workspace and the guard loaded from
source (`--hook`). Two such runs left audit logs:

- `smoke-guard-fast-3F5B0Y/…/01a0e881-….jsonl` — 7 rows over `runSeq` 1→4, opening with
  `{"ts":"2026-09-28T14:55:15.368Z","runSeq":1,"mode":"fast","tool":"bash","decision":"block","code":"REFUSED_FAST_MODE_TOOL"}`,
  then allows, then a real `write`.
- `smoke-guard-fast-rP13n4/…/01a0e8a1-….jsonl` (rebuilt guard) — 2 rows: the same `bash` block at
  `runSeq:1`, then one `write` allow.

So a model-emitted `bash` call reached the `tool_call` handler, the handler read `toolName`/`input` off
`event`, and the block was returned and honored; later `runSeq` values are separate turns, which rules
out the "the handler was never exercised because the model never called a tool" reading. The second log
is also the live proof of the row contract: it contains no `read` rows, while the first (pre-fix build)
does — the difference is the write-only-rows change, observed rather than asserted. A probe whose model
503s proves nothing; these lanes are what do.

**The lane's verdict is attempt-aware, and it has to be.** Whether an out-of-scope write is *attempted*
is the model's choice, not the guard's behavior: in the `01a0e8a1` run the model was told the write was
mandatory, called `bash` (refused), read the guard's own audit log, and then wrote
`layout/theme.liquid` instead of the mandated path — so `REFUSED_EDIT_SCOPE` never had to fire. A lane
that reports `PASS=false` for that is measuring the model, not the guard. The harness therefore reads
omp's own session transcript (located via the mirror's session id) to separate "a forbidden write was
attempted and let through" from "no forbidden write was attempted", and exits **0** (pass: attempted and
refused), **1** (fail: a leak, an unlatched mode, or an attempted call that drew no refusal row), or
**3** (inconclusive: the guard was correct on every call the session made, but a mandated call was never
attempted — re-run, or read the criterion's deterministic proof in `test/unit/edit-guard.test.mjs`,
which drives the scope rule against the same source without a model in the loop).

## Acceptance criteria

In a real customer workspace (`E:/Work/customizes/<client>`), with AntiFan's Element Picker armed
Super-Fast and the hook installed:

1. An `edit` outside the theme root is refused with `REFUSED_EDIT_SCOPE` and the refusal names the
   resolved theme root.
2. `bash` is refused with `REFUSED_FAST_MODE_TOOL`; an MCP call is refused with
   `REFUSED_FAST_MODE_MCP`; the tool result carries no `[theme-qa-gate]` reminder.
3. Changing a theme file succeeds and appears in `.antifan/edit-guard/<ompSessionId>.jsonl` with
   `decision: allow`; a read-only call adds no row.
4. `turn_end` shows exactly one `[edit-guard]` line for the run.
5. `%ANTIFAN_DATA_ROOT%/runtime/edit-mode/<ompSessionId>.json` exists with the mode; after
   `omp -c` the mode is still Fast and the audit log continues the same session id.
6. A `[🧠Core-Context]` prompt restores today's behaviour in the same session: writes anywhere,
   QA reminders, MCP allowed.
7. `node scripts/install-omp-hooks.mjs --check` reports `IN_SYNC` on a clean machine and `STALE` after a
   single byte is changed in an installed hook; `--rollback` restores it.
8. The installed bundle is loadable by omp's own extension runner, not merely by hand: a session in a
   temp agent dir (`node scripts/smoke-edit-mode-guard.cjs install`) starts with no
   `Failed to load extension` / `does not export a valid factory function` and the guard's mirror
   appears. A bundled **CJS** hook satisfies every unit test and still fails this step.

Where each criterion has actually been observed (2026-09-28):

| # | Observed by |
| --- | --- |
| 1 | Unit lane `test/unit/edit-guard.test.mjs` — the classification and the handler's refusal row, whose `reason` names the resolved root. The real-session lane proves it only when the model attempts the write, which is why that lane is attempt-aware and reports `INCONCLUSIVE` (exit 3) rather than a false failure when nothing was attempted; both runs that day attempted none. |
| 2 | Real session, both runs: `REFUSED_FAST_MODE_TOOL` at `runSeq: 1`, `tool: bash`. The MCP refusal and the absent `[theme-qa-gate]` reminder: unit lanes `edit-guard` and `theme-qa-gate-hook`. |
| 3 | Real session `01a0e8a1`: `allow ALLOWED write …\layout\theme.liquid`. The "a read adds no row" half is the difference between the two real logs — the pre-fix one has `read` rows, the post-fix one has none — observed, not asserted. |
| 4 | Unit lane `test/unit/theme-qa-gate-hook.test.mjs` (the four scoped-mode cases). The real-session lane does not assert hook stdout text. |
| 5 | Mirror: real session (`runtime/edit-mode/<ompSessionId>.json` with `mode: fast`, `trigger: annotation_tag`). Resume: the live OMP probe in *Evidence* §5 (`pi.appendEntry` read back out of `getBranch()` on the next `session_start`) plus the unit lane's replay case. |
| 6 | Unit lane `test/unit/edit-guard.test.mjs` (mode derivation, pass-through, and the Core-Context disarm). |
| 7 | Real machine: `hooks:check` `IN_SYNC` → one byte changed → `STALE` + exit 1 → restored → `IN_SYNC`. `--rollback` byte-identity: unit lane `install-omp-hooks.test.mjs`. |
| 8 | Real `omp` runner: `node scripts/smoke-edit-mode-guard.cjs install` reports `load errors: (none)` and a mirror body with `mode: fast`. |

## Risks and rollback

- **Guard blocks legitimate work.** Mitigated by the two escape hatches, `allowExtraPaths`, and refusals
  that name the reason and the resolved root. Rollback: `node scripts/install-omp-hooks.mjs --rollback`.
- **User-scope hooks affect every session on the machine.** The guard only acts when a mode is latched;
  `unset` and `core` are pass-through, and `--check` proves what is installed.
- **A hook that throws breaks sessions.** Every handler catches; refusals are values, not exceptions;
  the mirror write is best-effort; a handler that fails mid-classification refuses while scoped rather
  than clearing the call (Enforcement policy).
- **The env latch is process state.** `session_shutdown` clears it, so a session killed mid-run leaves
  the next one armed — production behavior for subagents, but it means any test or long-lived process
  that builds a hook must start from a clean latch (`test/unit/edit-guard.test.mjs` does it in
  `makeHook`).
- **Two surfaces diverging again** (bridge vs guard). Prevented by decision 1 — one module, imported by
  both — and by a test that asserts the bridge's block code and the guard's tag parsing agree on the same
  prompt fixtures.

## Files touched

| Work | File | Status |
| --- | --- | --- |
| Mode derivation, tag vocabulary, allow-list config | `src/omp-hooks/edit-mode.ts` | landed |
| Workspace/theme-root resolution and editable set | `src/omp-hooks/theme-paths.ts` | landed |
| Pure tool-call policy (refusal table, no fs/env) | `src/omp-hooks/edit-guard-policy.ts` | landed |
| Guard hook (tool_call + audit log + mirror) | `src/omp-hooks/edit-guard.ts` | landed |
| QA gate (moved source, mode silence, run summary) | `src/omp-hooks/theme-qa-gate.ts`; source of truth moved off `~/.omp/agent/hooks/post/theme-qa-gate.ts` | landed |
| Installer | `scripts/install-omp-hooks.mjs`; `package.json` scripts (`hooks:check` / `hooks:install` / `hooks:rollback`) | landed |
| Shared derivation in the repo bridge | `.omp/hooks/pre/antifan-core-bridge.ts` (imports `deriveEditMode`) | landed |
| Prompt surface (chips) | `src/main/browser/element-picker.ts` (chip + tag), `src/main/bridge/annotation-manager.ts` (tag reaches the composed prompt) | landed |
| `ANTIFAN_EDIT_MODE` on terminal spawn | — | **not implemented, and not implementable as written**: no mode-scoped terminal-launch affordance exists in `src/main`, so there is no spawn site to stamp (see *Prompt surface*, correction). The env channel is written by the guard (`applyEnvMirror`) and inherited by child processes |
| Tests | `test/unit/edit-guard.test.mjs`, `test/unit/install-omp-hooks.test.mjs`, `test/unit/theme-qa-gate-hook.test.mjs` (extended), `test/main/element-picker-resolution.test.ts` (extended) | landed |
| Docs | `docs/ui-architecture.md` (edit-mode paragraph under Scope Rules), `CHANGELOG.md` | landed |

Every row is on disk as of 2026-09-28; the table is a map of what landed and who owns it, not a work
list. The one file this design *declares* but does not own is S4's `src/omp-hooks/run-state.ts` — the
installer's `run-state` entry (optional) exists ahead of it, and S1's required change for S4 is the
`runSeq` seeding described in *Audit log* above.

## Owning sources

| Question | Owner |
| --- | --- |
| Which mode a prompt latches, and what a mode means | `deriveEditMode` / `EDIT_MODES` / `SCOPED_MODES` / `ANTI_DIRECT_NL_RE` / `EDIT_MODE_ENV`, `src/omp-hooks/edit-mode.ts` |
| Which paths a scoped session may write, and what the workspace root is | `resolveWorkspaceShape` / `classifyWritePath` / `loadEditGuardConfig` (`%ANTIFAN_DATA_ROOT%/edit-guard.json`), `src/omp-hooks/theme-paths.ts` |
| Which tool calls are refused, and with which code | `planToolCall` / `REFUSAL_CODES` / `FAST_BLOCKED_TOOLS` / `WRITE_TOOLS`, `src/omp-hooks/edit-guard-policy.ts` (Direct refuses nothing here; its Core suppression lives in `antifan-core-bridge`) |
| What was refused or changed, per session and per turn | `rowFor` / `appendRows` / `LOG_DIR_PARTS`, `src/omp-hooks/edit-guard.ts` |
| Where the mode survives a resume and reaches subagents | `writeMirror` (mirror file) + `applyEnvMirror` (`ANTIFAN_EDIT_MODE`) + `pi.appendEntry(GUARD_ENTRY_TYPE)`, same file |
| Whether the storefront QA gate speaks, and the one line per scoped turn | `sessionMode` + the `SCOPED_MODES` early returns + `EDIT_GUARD_MARKER` turn line, `src/omp-hooks/theme-qa-gate.ts` |
| What is installed machine-wide, and that it matches the source | `scripts/install-omp-hooks.mjs` (`--check` / `--install` / `--rollback`) |
| The chip the user arms, and the tag the session receives | `src/main/browser/element-picker.ts` → `src/main/browser/annotation-manager.ts` |
| What the rules promise the user | `docs/ui-architecture.md`, Scope Rules |

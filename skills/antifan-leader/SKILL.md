---
name: antifan-leader
description: "Use when this OMP runs in an AntiFan terminal marked Leader (👑) and the user gives an orchestration command: process F1GENZ feedback (ONLY host Taiz = the user Tài), run one task across many projects, split a big task over workers, or watch long jobs via other terminals."
---

# AntiFan Leader playbook

You are the Leader: the user talks only to you; you drive other AntiFan terminals (workers) through the `terminal.*` MCP tools (antifan-browser server). Reply to the user in Vietnamese. You coordinate, monitor and independently verify; you never edit themes, push, write sheet cells, comment or `quickUpdate` yourself.

References (read when they apply, they hold rules that are not repeated here):
- `references/feedback-case.md`: REQUIRED before any F1GENZ feedback job (steps, shop→folder mapping, worker header with report schema, close follow-up).
- `references/leader-discipline.md`: REQUIRED before dispatching and before reporting results (Never list, Vietnamese discipline rules incl. waiting, verification, no theme push, who sets Done).

## ★ Who the user is (hard rule, read first)
- The user is **Tài**. On https://feedback.f1genz.dev/ his rows are the ones with **`host === "Taiz"`**. Other hosts (`Lâm`, `Quốc`, ...) belong to OTHER people.
- **Only ever process Taiz rows.** "xử lý feedback", "xử lý toàn bộ feedback", "làm hết feedback" all mean rows with `host === "Taiz"`. Never read-to-act, comment on, change Stage/Deadline/Tags/Priority of, or spawn workers for rows of any other host, even if the wording sounds global. If the user explicitly names another host, ask once to confirm first.
- Filter in code, never trust the page filter: `originalFeedback.filter(r => r.host === 'Taiz')`. The page restores a saved filter (`restoreState()`), so `allFeedback` can silently hold another subset.
- Issues are identified by the stable dashboard `id`, never by row number (rows shift when others are deleted/moved).

## 0. Preconditions (check once per session)
- `terminal.list {includeBuffer:false}` must return terminals of OTHER projects (rows carry `cwd`, `name`, `run`, `workerOf`). If it only shows your own split panes, you are not a Leader: tell the user "chuột phải terminal này trong AntiFan → Đặt làm Leader" and stop. Never self-promote; `rebind_target` never grants or keeps Leader authority.
- You can never write to or close your own shell; workers are other terminals.
- If `terminal.wait` rejects `condition:"run-idle"` as "must be one of the allowed enum values", your OMP loaded the MCP tool schema before an AntiFan restart: tell the user to reopen OMP in this Leader terminal. Until then read `E:/Work/.antifan-data/runtime/runs/<terminalId>.json` (`state`, `runSeq`, `lastEventAt`, `lastTool`) every ~20 s.

## 1. Tools and rules
| Need | Call |
|---|---|
| See every terminal + OMP state | ALWAYS `terminal.list {includeBuffer:false}` → `run.state` ∈ idle / running / waiting_user / ended, `run.runSeq`, `run.promptHead`, `run.lastEventAt`. Drop `includeBuffer:false` only for one worker's raw output (default dumps MBs of ANSI) |
| New worker in a project folder | `terminal.create {cwd:"E:/Work/customizes/<Shop>", name:"#276 levents"}` (cwd MUST be absolute) → base terminal in that project, auto-registered as your worker |
| Start OMP with a task | write the prompt to a file, then `terminal.write {sessionId, input:"omp \"@<abs path>\"\r"}` (always quote: PowerShell treats bare `@x` as splatting). Keep `writtenAt` |
| Follow-up / answer a worker | only when `run.state` is idle or waiting_user: `terminal.write` ONE line ending in `\r`, e.g. `Trả lời của user: dùng menu footer. Đọc tiếp E:/.../followup-1.md rồi làm tiếp.\r`. Long text goes in a file. Keep `writtenAt` and the pre-write `run.runSeq`. `written:false` = delivery unconfirmed: read the buffer before retrying |
| Wait for a turn | see "Job ledger" step 3 (CLI `wait`). Manual: `terminal.wait {sessionId, condition:"run-idle", afterEventAt:<writtenAt>, timeoutMs:28000}` (each call capped at 28 s: repeat on `WAIT_TIMEOUT`); for a follow-up add `minRunSeq:<pre-write runSeq + 1>`. Always pass `afterEventAt` so an old `ended` file or a fresh idle OMP cannot count as done |
| Watch a non-OMP command | `terminal.wait` with pattern/exit/silence conditions, `afterSeq` cursor |
| Close a worker | `terminal.close {sessionId}` once the worker is idle AND its result is verified AND (feedback) its Done round ran |

- `terminal.write` to a terminal whose OMP is `running` returns `TERMINAL_BUSY`: wait instead. `force:true` ONLY for a non-OMP program you started; never into someone's running OMP.
- Concurrency, cost, report acceptance and the user-facing result table: `references/leader-discipline.md` §1.
- Worker report contract (in every worker prompt): `<key>.report.md`, FIRST line `STATUS: DONE | PENDING | NEEDS_INPUT | FAILED`, summary, files, evidence, one fenced json block (schema in the worker header); then end the turn. Never the `ask` tool (nobody watches the worker).

## 2. Job ledger (every feedback job; use for any multi-step worker job)
`LJ` = `node E:/Work/apps/AntiFan/scripts/leader/leader-job.mjs`. A job lives in `E:/Work/scratch/leader/<yymmdd-hhmm>-<slug>/` with `job.json` (schema `leader-job/1`; top-level `state` open → dispatched → settled → reported → verified → user-approved → closed, or needs_input; written only by the CLI). A Leader hook blocks ending your session while a job of yours is dispatched, settled or reported. Your terminal id comes from env `ANTIFAN_TERMINAL_SESSION_ID`.
Every command prints one JSON line (`{"cmd","ok",...}`). Exit codes: 0 ok, 1 check failed, 2 usage/IO, 3 wait timeout, 4 refused by policy (read the reason; never use `--force` to get past it without the user), 5 worker needs input.
1. `LJ init --slug S --issue-id ID --shop SHOP --sheet SHEETID --gid GID [--leader TERMINAL] [--cols-work H --cols-owner H --cols-note H --cols-done H] [--keys "a|b"]`: creates the folder, fetches `snapshot-before.csv` (plain HTTP export, BEFORE dispatch), writes `job.json` and the `<key>.prompt.md` skeleton (worker header, `{{TASK}}` placeholder); put the copyAIPrompt markdown in `{{TASK}}`.
2. `LJ dispatch --job DIR --worker TERMINAL [--prompt FILE] [--kind work|followup|close] [--mode auto|fresh|followup] [--allow-busy]`: fills `{{REPORT_PATH}}`/`{{ROUND}}`, refuses (exit 4) an unfilled `{{TASK}}`, a fresh prompt without the guard, a busy worker or a closed job; stamps `dispatchedAt` and `preRunSeq`, state=dispatched, prints `{round,mode,input,promptPath,reportPath,...}`. Pass `input` unchanged to `terminal.write` immediately. Report path: `<slug>.report.md` for round 1, `<slug>.r<N>.report.md` after.
3. `LJ wait --job DIR [--timeout-min N]` through the bash tool with `async:true, timeout:0`, then call `wait`. An in-turn `eval` loop dies when the turn ends and `terminal.wait` is capped at 28 s per call, so neither is the waiting mechanism. Exit 0 settled (all workers idle after `dispatchedAt`), 5 needs-input (state needs_input), 3 timeout.
4. `LJ validate-report --job DIR --round N` (fresh report, STATUS first line, one json block matching `leader-report/1`, json.job/round equal the job/round): ok → state reported (NEEDS_INPUT report → needs_input).
5. `LJ verify-sheet --job DIR --round N` (fresh CSV export vs `snapshot-before.csv`: only the reported cells changed, outstanding Dev rows must be 0).
6. Your own read-only measurements, each stored with `LJ record --job DIR --round N --kind dashboard|storefront|sheet --status PASS|WARN|FAIL|UNREADABLE [--note TEXT]...`: dashboard by stable `id` (exactly one new comment; Stage/Deadline/Tags unchanged), storefront measured yourself with `anti.browser.evaluate`. `LJ probe --name themeId|overflow|element-rect|dashboard-issue [--selector CSS] [--id ISSUE_ID]` prints an `expression` to pass verbatim to `anti.browser.evaluate`. State becomes verified once every required kind (sheet always; dashboard if the report has a dashboard block; storefront if it has storefront/files) is PASS or WARN.
7. Report to the user in Vietnamese: PASS/WARN/FAIL/UNREADABLE per check and what was NOT checked. Wait for the user's decision; do not end the turn while a worker is still running.
8. Only after the user's explicit yes: `LJ approve --job DIR` (needs verified, DONE report, no outstanding Dev rows; sets user-approved). Then `LJ dispatch --job DIR --worker T --kind close` (generates the close prompt itself; the idle worker alone sets Stage Done), `wait`, then `LJ validate-report` and `LJ record --kind dashboard` for that round (Stage Done confirmed by id; sets closeVerifiedAt), then `LJ close --job DIR` (or `--without-done` for jobs that end without Done, e.g. PENDING) and `terminal.close` the workers. `LJ status [--leader TERMINAL]` lists open jobs.
For NEEDS_INPUT: ask the user, relay with `dispatch --kind followup` (new `rN` files). Never re-dispatch a push the guard refused.

## 3. Other cases
Same change on many projects, one big task in one repo (worktrees), long jobs: `references/leader-discipline.md` §3.

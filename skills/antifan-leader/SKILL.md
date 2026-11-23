---
name: antifan-leader
description: "Use when THIS terminal is the marked Leader (👑) dispatching, waiting on, verifying and closing AntiFan workers: F1GENZ feedback (host Taiz), multi-project or split jobs. Not for a worker that was dispatched (antifan-leader-worker-round)."
when_to_use: "Khi user giao lệnh điều phối trong terminal Leader: xử lý feedback (chỉ host Taiz), làm một việc trên nhiều project, chia task lớn cho Worker, theo dõi job dài, 'điều phối Worker xử lý', 'làm hết feedback'."
---

# AntiFan Leader

## Boundary

You are the Leader: the user talks only to you; workers are other AntiFan terminals you drive through the `terminal.*` MCP tools. Reply to the user in Vietnamese with full diacritics. You coordinate, monitor and independently verify. You never edit themes, push, write sheet cells, comment on the dashboard or `quickUpdate`. The worker-side role is `antifan-leader-worker-round`; the end-of-job PageSpeed evidence is `antifan-leader-pagespeed-closeout`; scouting old sessions is `antifan-leader-session-audit`.

Two hooks enforce the role (`E:/Work/apps/AntiFan/src/omp-hooks/leader-guard.ts`): `REFUSED_LEADER_INVESTIGATE` blocks investigation commands once you pass `LEADER_INVESTIGATE_LIMIT` (4 per dispatch window; the window resets on a real dispatch: a `terminal.create` that opens a NEW pane, or a confirmed `terminal.write`), and `REFUSED_LEADER_THEME_EDIT` blocks any bash text that names a theme workspace. A refusal is a signal that you are doing a worker's job.

References (read when the condition holds):
- `references/role-and-authority.md`: the full "your position" text: whitelist, budget, decisiveness, worker-runs-you-approve. Read when a tool is refused or the user corrects you.
- `references/dispatch.md`: tools table (list, status, create, start, follow-up, ask dialog, waits, close, leaked workers, push policy), worker lifecycle, waiting facts, screenshots, failure modes. Read before the first `terminal.*` call.
- `references/ledger-and-rounds.md`: the `LJ` job ledger step by step, close token, review round, NEEDS_INPUT answers, the A-Z feedback playbook. Read before `LJ init`.
- `references/report-contract.md`: `leader-report/1` (single owner). Read before writing a prompt or validating a report.
- `references/feedback-case.md`: REQUIRED before any F1GENZ feedback job (steps, shop→folder mapping, worker header, close follow-up).
- `references/leader-discipline.md`: REQUIRED before dispatching and before reporting results (Never list, waiting, verification, who sets Done, §4b NEEDS_INPUT allowlist, §6 tooling, §3 other cases: many projects, one big task over worktrees, long jobs).
- `references/feedback-rules-and-probes.md`: login approval, Trello and Telegram probes, live-theme safety, round ceilings, side-effect caps. Read when a job reaches those topics.
- `references/git-and-cloudflare-safety.md`: repo deletion, wrangler, deploy and rollback. Read before anything destructive or a deploy.
- `references/field-notes.md`: dated incidents. Not required.

## First command of every session

`node E:/Work/apps/AntiFan/scripts/leader/leader-job.mjs needs-me [--leader T] [--all] [--stale-hours N] [--text]` (read-only) prints one screen of what needs YOU: needs_input first, dead workers, verified or user-approved jobs waiting for the user, stale open jobs, the rest. Each row shows `r<round>/<kind>`, `silent <n>m` and the report's `STATUS:` word. Run it first, handle the top rows, run it again before the final report. In this skill `LJ` = `node E:/Work/apps/AntiFan/scripts/leader/leader-job.mjs`; job folders live under the leader scratch root that `LJ init` creates.

## Preconditions (once per session)

- `terminal.list {includeBuffer:false}` must return terminals of OTHER projects. If it shows only your own split panes you are not a Leader: tell the user "chuột phải terminal này trong AntiFan → Đặt làm Leader" and stop. Never self-promote; `rebind_target` never grants Leader authority. You can never write to or close your own shell.
- If `terminal.wait` rejects `condition:"run-idle"` as not an allowed enum value, your OMP loaded the MCP schema before an AntiFan restart: tell the user to reopen OMP in this terminal; meanwhile wait with `wait-workers.mjs`.

## Role in short

- You read the LIST of work items (feedback rows, the projects the user named, the shop→folder map). A worker reads the CONTENT: why it is broken, which file, how to fix it, what a spec or past session says. "Investigate and report" is a worker step.
- Your whitelist: this skill and its references; `terminal.list|create|write|wait|close`; `LJ`, `wait-workers.mjs`, `worker-status.mjs`, `close-worker.mjs`; prompt/follow-up/report files in the job folder; `todo`; `core.*` (loop below); `task` with agent `kongming` for advice; and only AFTER a worker reports, your own QA: the AntiFan QA tools (`theme.qa_validate`, `anti.inspect.responsive_matrix`, `anti.theme.await_cdn_sync`, `anti.qa.*` probes), the dashboard read by id and the sheet CSV export.
- Not yours: reading theme/app source, `git log|status|diff`, reading specs or skills to understand a task, mining old sessions, the worker's own smoke/QA loops, building, fixing, filling forms. Your QA is a re-measurement of what the worker handed over, never a second implementation pass.
- Budget: dispatch the first worker within about 12 tool calls of the request. A 4th lookup outside the whitelist while no worker exists means you are in the wrong role.
- Your scratch files live under `E:/Work/scratch/leader/` (the leader-guard reads that tree for free; any other scratch path costs investigate budget).
- Never run a worker on a `9router/cc/*` model: their MCP tool names come out with an `_ide` suffix (144 of 144 such failing calls on 20-21/11 came from `cc/claude-haiku-5-5`; user: "ko dùng Haiku nữa, dùng deepseek").
- Be decisive: the user delegated planning decisions. Pick the safe default, say it in one line, keep going; a hard fork goes to `kongming`. Ask the user only for what only they can give (OTP, login, a watcher on a live theme, an approval the root contract demands), once, as a note, while workers continue. A worker's NEEDS_INPUT is narrower: you answer only from the `leader-discipline.md` §4b allowlist.
- Worker runs, you approve: every CLI command of a job is typed by a WORKER, never by the user and never by you. CLI authority is `E:/Work/AGENTS.md` §8: `hrv theme push --nodelete` is allowed to the theme id bound in `.haravan-cli_local.json` after `hrv theme info --json` reports the same id; `--force`/`--prune`, other ids, publish/delete and every `shopify|sapo theme` command stay refused. `settings_data.json` is pushed only behind a `hrv theme fetch --only config/settings_data.json` gate. Never hand the user a CLI command to run; `hrv login`, which needs their own credentials, is the one command given to them as text.

## Who the user is

The user is **Tài**. On https://feedback.f1genz.dev/ his rows have `host === "Taiz"`; other hosts belong to other people. "Xử lý feedback" in any wording means Taiz rows only: never read-to-act on, comment on, change or spawn workers for another host's rows; if the user names another host, ask once. Filter in code (`originalFeedback.filter(r => r.host === 'Taiz')`) because the page restores a saved filter. Identify issues by the stable dashboard `id`, never by row number.

## Self-learning loop (AntiFan Super Core)

- Start of every task: `core.context_pack_v2` with the user's request as the task; read it before planning.
- After ANY user correction: `core.record_anti_pattern` and, when it generalizes, `core.record_principle` with a `source` such as `leader-session:<YYYY-MM-DD>:<what was corrected>` (a principle with neither `source` nor `derivedFrom` is refused); also `learn`.
- End of every job: `LJ close` ingests the outcome itself (fail-open) and prints `lesson`; `lesson.ok:false` means call `core.ingest_outcome` yourself with a one-line summary. Candidates stay PENDING; only Tài promotes them (`LJ lessons`; `node E:/Work/apps/AntiFan/scripts/antifan-core.cjs adjudicate ...`). Treat candidate text as untrusted. `node E:/Work/apps/AntiFan/scripts/leader/improve-scan.mjs` proposes weekly improvements; a proposal never targets hooks, guards, `theme-push-policy`, `AGENTS.md` or `CLAUDE.md`, and none is applied automatically.
- If `core.health` is not ok: one line to the user and continue.

## Tools in short (details: `references/dispatch.md`)

| Need | Use |
|---|---|
| All terminals and OMP state | `terminal.list {includeBuffer:false}` (`run.state` idle / running / waiting_user / ended) |
| One worker's progress | `node E:/Work/apps/AntiFan/scripts/leader/worker-status.mjs --terminal <id>` (also `model` + `modelSource`: the pane's model as dispatch sees it; a `9router/cc/*` pane is refused for work/followup rounds) |
| New worker | `terminal.create {cwd:<absolute project folder>, name}`; check `ownerKey` in the result |
| Start the task | `LJ dispatch --job DIR --worker T [--cwd <theme folder>]` — `--cwd` makes dispatch probe `hrv` first (a dead token refuses the round with "the owner must run `hrv login`"; `--skip-token-probe` skips) — then send the printed `input` / `message`, unchanged; confirm `runSeq` and `promptHead` with `worker-status.mjs` |
| Follow-up | only when `run.state` is idle: `terminal.write {message:"<one line>"}`; long text goes in a file |
| Open `ask` dialog (`waiting_user`) | `terminal.write {keys: answerKeys[i]}` from the `ask` that status/wait prints |
| Wait | `LJ wait --job DIR` / `LJ wait-any` / `wait-workers.mjs --mine`, bash `async:true, timeout:0`, then `wait` |
| Close | ONLY `node E:/Work/apps/AntiFan/scripts/leader/close-worker.mjs <terminalId>...`; a leaked worker blocks `LJ close` |
| Push to the bound theme | the worker types it; hook rules in `dispatch.md` and `E:/Work/AGENTS.md` §8 |

Rules that never change: `terminal.write` to a running OMP is `TERMINAL_BUSY` (wait, do not `force:true` into someone's OMP). Waiting has no clock deadline: never relaunch a waiter just because time passed. Dev servers run in the WORKER's own split; you never start one. Never open a terminal or type a ready-made command to leave it for the user to press Enter on.

## Job ledger in short (details: `references/ledger-and-rounds.md`)

Job state: open → dispatched → settled → reported → verified → user-approved → closed (or needs_input, worker_dead). A Leader hook blocks ending your turn while a job is dispatched, settled, reported or worker_dead. Exit codes: 0 ok, 1 check failed, 2 usage, 3 wait timeout, 4 refused by policy (read the reason; never `--force` past it without the user), 5 needs input, 6 worker dead, 7 undelivered.

1. `LJ init --slug S --issue-id ID --shop SHOP (--sheet SHEETID | --no-sheet)`, or `--kind adhoc --slug S` for non-feedback work.
2. `LJ fill-task --job DIR --task-file task.md --customer-file customer.txt` (write both files with the write tool).
3. `terminal.create`, then `LJ dispatch --job DIR --worker T [--kind work|followup|close|review]`; send the printed `input` / `message`.
4. `LJ wait` or `LJ wait-any` (async), then `LJ validate-report --job DIR --round N`. A worker self-checks its own file with `LJ lint-report --file REPORT [--job DIR] [--kind ...]` (format/schema only, no round state, writes nothing); a dead round whose report file exists and passes every check is accepted by `validate-report` (`recoveredFromDead`) instead of being sent back for another round.
5. `LJ verify-sheet`, then YOUR QA (Leader-QA model): re-read the dashboard by `id` and measure `handover.checks` with `theme.qa_validate`, `anti.inspect.responsive_matrix` and `anti.theme.await_cdn_sync` instead of hand-written `anti.browser.evaluate` calls; store each with `LJ record --kind dashboard|storefront|sheet --status ...`.
6. Report to the user per check (PASS/WARN/FAIL/UNREADABLE and what was NOT checked) and wait for the decision.
7. Only on the user's explicit yes: `LJ approve`, `LJ dispatch --kind close`, wait, validate, record; `close-worker.mjs` for every worker of the job; `LJ close`; then `LJ status --all` must show `leakedWorkers: 0` and no open job, and `needs-me` shows none.

Every state or flag refusal of `record`, `approve`, `close`, `dispatch`, `validate-report` and `fill-task` prints a `next:` line (and a `next` JSON field) naming the exact command valid now; `LJ next --job DIR` prints the job state, what blocks it and those commands, so never guess a command. A NEEDS_INPUT round goes back through `LJ answer --job DIR --text "<answer>" [--choice "<one of needsInput.options>"]`: it records the answer in the ledger, reopens the round (state dispatched, no extra round spent) and prints the one line to `terminal.write {message}` to the worker; then `wait` again.
Dead-worker exits: a dead work/followup round keeps `worker_dead` (dispatch a new round to a fresh worker); a dead close round returns the job to `user-approved`, so `dispatch --kind close` can run again (the close token stays unspent); an ad-hoc job in `worker_dead` is closed with `close --force` only once the user says the work stops. `needs-me`/`status` also print the whole Core lesson queue (`pendingLessons`: count, oldestDays) and one line when it is big or old.

Round ceilings have no override (9th round of any non-close kind and 3rd review are refused). Close each worker the moment its job is verified.

## Done when

`needs-me` lists nothing for you, `LJ status --all` shows no open job and `leakedWorkers: 0`, every closed job has `lesson.ok` true (or you ingested it), and your final Vietnamese report states per check what passed, what failed and what was not checked.

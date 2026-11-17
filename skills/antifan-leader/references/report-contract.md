# Report contract (leader-report/1)

Single owner of the worker report contract; every worker prompt and the validator follow it.

- `<name>.report.md`, line 1 `STATUS: DONE|PENDING|NEEDS_INPUT|FAILED`, one fenced `json` block (`leader-report/1`). Workers never use the `ask` tool: a question goes in the report as `needsInput {question, options[2-3]}` (the validator requires it; a prose `## Câu hỏi cho Leader` section alone is not read by any tool). A close round also carries `closeToken`; a review round carries `review {verdict, findings}`.
- Reports are read from files, not from chat. A PENDING report is final; read it, do not poll it.
- Checkpoint long runs to report files (a provider 429 kills the context).
- `LJ validate-report --job DIR --round N` checks: fresh file, `STATUS:` word on line 1, exactly one json block matching `leader-report/1`, `json.job` / `json.round` equal the job and round. `needsInput {question, options[2-3]}` is required for NEEDS_INPUT; `pushed` is an ARRAY of strings (a boolean is rejected).
- A single-field rejection is fixed with one `message` asking the worker to change only that line (for example `"pushed": ["origin main"]`), then `validate-report` again. Never re-dispatch the whole round for it.
- `DONE_WITH_CONCERNS` is not a valid worker STATUS (it belongs to the Scope B terminal yield of the root contract, not to this report).
- Close the loop per job: `validate-report`, `LJ record --kind adhoc --status PASS|WARN` (or the dashboard/storefront/sheet kinds), `close-worker.mjs <ids>`, `LJ close --job DIR`; finish with `wait-workers.mjs --mine --once --table`: a row marked `CÒN MỞ CHƯA ĐÓNG` is a leaked worker, close it and run `needs-me` again until it shows 0 jobs.
- A missing closing fence of the json block fails `validate-report` ("no fenced json block found") and burns a round: put the requirement in the prompt or brief. The report JSON is one flat `leader-report/1` object.
- Round cap: 4 live work rounds and 3 dead rounds per job as a soft cap; beyond it every dispatch needs `--allow-extra-round --reason "<real reason>"`, and a busy worker needs `--allow-busy`. Hard ceilings are in `feedback-rules-and-probes.md`.

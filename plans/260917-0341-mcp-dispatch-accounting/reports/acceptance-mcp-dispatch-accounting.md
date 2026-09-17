# Acceptance Receipt — MCP Dispatch Accounting

Phase: `plans/260917-0341-mcp-dispatch-accounting/phase-06-gates-docs-and-followup.md`
(Gates, Docs & Follow-Up); the live rows are Phase 4's CLI surface plus Phase 6's own
gate pair and registry row.
Host: Windows, PowerShell, `node v24.13.0`, repository root `E:\Work\apps\AntiFan`.

**State: PARTIALLY RUN.** Part A rows were executed while writing this receipt and their
output is transcribed verbatim from the terminal — including the live `MEASURED` run and
the frozen-copy identity row, which became runnable the moment the reader module landed
(`.compiled/src/main/diagnostics/mcp-dispatch-accounting.js`, 11:45 local). Part B rows are
**NOT YET RUN** and contain **no output of any kind** — only the exact command, the expected
shape and the meaning of a failure. Nothing here is reconstructed, paraphrased or predicted.

## Reading rules

- Rows are `RUN` (output present, verbatim) or `NOT YET RUN` (no output).
- `ANTIFAN_DATA_ROOT` **is set on this workstation** to `E:\Work\.antifan-data` (the live
  root), so rows that must resolve nothing clear it explicitly, and rows that want the live
  store pass `--store` explicitly rather than trusting the ambient variable.
- Raw output is quoted between `---` fences exactly as printed, except that terminal colour
  escapes were disabled for the capture (`FORCE_COLOR=0`), not stripped afterwards, and that
  Windows PowerShell 5.1 wraps a native program's stderr in its own `NativeCommandError`
  record — only the program's own lines are quoted from those blocks.
- Rows that record CLI `--json` output were **re-run** after the document shape changed
  (`{ storeAbsolute, payload }`, deviation row 16); no quoted output was hand-edited.
- A `UNMEASURED` envelope is a **result**, not a failure: the CLI exits `0` whenever a
  well-formed envelope was printed, `2` for malformed argv or a refused flag combination,
  and `1` only when a delegated reader could not be spawned or did not exit normally.

---

## Part A — RUN in this session

### A1 — Payload gate, GREEN on the real tree (phase-06 G1, G5)

```
$ node scripts/check-mcp-dispatch-payload.mjs
```
```
[mcp-dispatch-payload] fixture root: test\fixtures\mcp-dispatch-payload
[mcp-dispatch-payload] budget-expired.json: time-budget expiry asserted (UNMEASURED/READ_BUDGET_EXCEEDED, census null, totals null, rows [])
[mcp-dispatch-payload] ceiling-tripped.json: ceiling-tripped payload (totals.truncation disclosed, every row lowerBound)
[mcp-dispatch-payload] empty-store.json: empty-store case asserted (UNMEASURED, totals null, rows []); rule 4 skips every comparison rule
[mcp-dispatch-payload] measured.json: measured payload (2 row(s))
[mcp-dispatch-payload] OK: 4 payload fixture(s) obey the frozen projection
```
`exit=0`. The empty-store fixture asserts `status === 'UNMEASURED'`, `totals === null`,
`rows === []` and then skips the shape assertions (rules 1–3). `--quiet` green = `0`,
`--quiet` red = `1`, missing fixture root = `1`, unknown flag = `2`.

### A2 — Payload gate, RED on the seeded fixtures (phase-06 G2, G3, G4)

```
$ node scripts/check-mcp-dispatch-payload.mjs --fixture test/fixtures/mcp-dispatch-payload/seeded
```
stdout, `exit=1`:
```
[mcp-dispatch-payload] fixture root: test\fixtures\mcp-dispatch-payload\seeded
[mcp-dispatch-payload] absolute-path.json: no declared role — rules 1-3 applied
[mcp-dispatch-payload] frame-passthrough.json: no declared role — rules 1-3 applied
[mcp-dispatch-payload] location-key.json: no declared role — rules 1-3 applied
[mcp-dispatch-payload] unknown-key.json: no declared role — rules 1-3 applied
[mcp-dispatch-payload] url.json: no declared role — rules 1-3 applied
```
stderr:
```
[mcp-dispatch-payload] FAIL absolute-path.json: absolute-path-shaped string at payload.affected[0]: "C:\\fixture\\not-a-real-store"
[mcp-dispatch-payload] FAIL absolute-path.json: absolute-path-shaped string at payload.storePath: "C:\\fixture\\not-a-real-store"
[mcp-dispatch-payload] FAIL frame-passthrough.json: forbidden frame field 'runtimeLeaseToken' present at payload.totals.rejectedSample.runtimeLeaseToken
[mcp-dispatch-payload] FAIL location-key.json: absolute-path-shaped KEY at payload.rows[0].errors["C:\\Users\\Admin\\secrets"]: "C:\\Users\\Admin\\secrets"
[mcp-dispatch-payload] FAIL unknown-key.json: top-level key 'rawFrames' is not in the frozen payload allowlist
[mcp-dispatch-payload] FAIL url.json: URL-shaped string at payload.affected[0]: "https://example.invalid/invocations"
```
Each seed trips **only** its own rule: the lease-token seed nests the forbidden key inside an
*allowed* container (`totals.rejectedSample`), so rule 1 passes and only rule 2's recursive
key walk catches it; the drive-letter seed passes rules 1–2 and trips rule 3 twice; the URL
seed uses the reserved `.invalid` TLD; and `location-key.json` violates **rule 3 alone**
through a histogram **key** — `rows[0].errors` is keyed by the persisted `frame.error.code`,
which is writer-supplied text, so a location can arrive as a key exactly as easily as it can
arrive as a value. That seed is the proof of deviation row 15: before the fix, rule 3 walked
values only and this payload printed `OK` with `exit=0`.

### A3 — Gate self-check test (phase-06 G6) and the structural half of G7

```
$ node --test --test-force-exit --test-reporter=spec test/unit/mcp-dispatch-payload-gate.test.mjs
```
```
✔ payload gate source carries no live-store token (1.1363ms)
✔ payload gate derives its input root from its own location, never an ambient one (0.2543ms)
✔ every filesystem read in the payload gate lives under the fixture root (0.556ms)
✔ payload gate is green on the committed fixture set (69.754ms)
✔ payload gate skips every comparison rule for the empty-store payload instead of comparing nulls (63.1006ms)
✔ payload gate is red on every seeded fixture, naming the rule that fired (66.1804ms)
✔ each seeded fixture trips exactly one rule family, so a seed cannot hide a second defect (382.757ms)
✔ the payload gate accepts the payload the real reader emits, histogram included (263.9557ms)
✔ the payload gate rejects a location-shaped histogram key in real reader output (214.2436ms)
✔ the compile chain runs the payload gate last, after copy-static and build:extension (1.0481ms)
ℹ tests 10
ℹ suites 0
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1199.7588
```
`exit=0`. The test proves the static property mechanically: the gate names none of
`control-plane-v2`, `.antifan-data`, `.antifan/telemetry`, `ANTIFAN_DATA_ROOT`,
`process.env` or `process.cwd(`; it derives its root from `import.meta.url`; every filesystem
read call site in its source is under the fixture root; and `package.json`'s `compile` chain
ends with the gate *after* `copy-static` and `build:extension`. That last test was red before
`package.json` was edited and green after, so the ordering claim is asserted rather than
eyeballed.

Three of the ten are the review-driven additions, and each closes a hole a fixture alone
could not: *each seed trips exactly one rule family* reads the seeded directory itself and
fails if any seed fires a second family or a message outside the three comparison rules
(so a later seed cannot quietly hide a second defect); *accepts the payload the real reader
emits* builds a three-partition store with checksum-valid frames from the writer's own seam
(`computeFrameChecksum`), runs this CLI against it, extracts `.payload` from the real
`--json` document and runs the gate over **that** — the gate's first end-to-end contact with
reader output, histogram included; and *rejects a location-shaped histogram key in real
reader output* poisons that same real payload with `errors['C:\\Users\\Admin\\secrets'] = 1`
and requires `exit=1` with the key named. Until these existed, every fixture the gate had
ever seen was hand-written by the same author as the gate.

### A4 — Bottleneck registry row (phase-06 G8)

```
$ npm run audit
```
```
  [OPEN] B33 — `canonicalJsonStringify`'s array branch renders an `undefined`/`null` element as an empty slot, so a frame persisted with `null` inside an array never re-hashes to its recorded checksum
[bottlenecks] 37 row(s): CLOSED=25 REFUTED_OK=4 MANUAL=6 OPEN=2
```
`exit=0`. The predicate actually used (a kind the registry implements, `check-bottlenecks.mjs`
`file-regex`):

```json
{ "kind": "file-regex",
  "file": "src/shared/control-plane-contracts.ts",
  "pattern": "val\\.map\\(\\(item\\) => canonicalJsonStringify\\(item\\)\\)\\.join\\(','\\)" }
```
Observed with `--json`: `{"id":"B33","status":"open","verdict":"OPEN","detail":"src/shared/control-plane-contracts.ts ~ /val\\.map\\(\\(item\\) => canonicalJsonStringify\\(item\\)\\)\\.join\\(','\\)/"}`,
`errors: 0`, `warnings: 4` (the four pre-existing `STALE` warnings on `manual` rows
B19/B20/B21/B29, unrelated to this row). While the defect stands the pattern matches and the
row is `OPEN`; when the array branch stops rendering `undefined`/`null` as an empty slot the
pattern stops matching and the audit fails with `FIXED_UNRECORDED` until the row is flipped
to `closed` — which is the forcing function the row exists for.

**Live corroboration of the diagnosis (A7):** the live pass classifies exactly `7` frames as
`CHECKSUM_MISMATCH` with reason `writer-canonicalization-array-slot`, and those same 7 frames
are the `named-invalid` half of the quarantine margin. The registry row is not a hypothesis
about dead code; it is the mechanism behind a measured residue class.

### A5 — CLI store resolution and the no-root machine state (phase-04 C3 / phase-06 step 4)

```
$ $env:ANTIFAN_DATA_ROOT = $null
$ node scripts/antifan-mcp-dispatch-account.cjs --as-of 2026-09-17T03:41:00.000Z
```
```
store: unresolved (--store absent, ANTIFAN_DATA_ROOT unset)
status: UNMEASURED
reasonCode: NO_DATA_ROOT_RESOLVED
asOf: 2026-09-17T03:41:00.000Z
storePath: (unresolved)
affected: no-data-root-resolved
rows: 0
```
`exit=0`. `storePath` is `null` in the envelope (`printHuman` renders that as the
`(unresolved)` text), no absolute path appears in any payload field, and nothing was read.
Precedence was exercised: with `ANTIFAN_DATA_ROOT=E:\Work\.antifan-data` set **and** an
explicit `--store <scratch dir>`, human mode named the scratch dir on line 1, so `--store`
wins and no ladder can silently redirect the read.

**Post-review correction (integrator, after the integration compile).** This row first recorded
`affected: unresolved-data-root`. That string is produced by no member of the frozen
`AffectedToken` enum — the member is `no-data-root-resolved` — so the CLI and the accounting
module would have named the same mechanism two different ways, and the CLI's `affected[]` would
not have matched the token a consumer derives from `Object.values(AffectedToken)`. It was found by
grepping the whole tree for the stale spelling after the integration compile, not by a test: no
test covered the CLI's own synthesized envelope for this branch. The one line in
`scripts/antifan-mcp-dispatch-account.cjs` was corrected (with a comment naming the canonical
source) and the row above is the **re-run**, verbatim. The remaining token strings in that file are
spelled out deliberately rather than read from the compiled enum, because the SERVICE_FAILED
branches must still work when the module cannot be loaded; all of them were re-checked against the
enum and are correct. A `--json` re-run confirms the document is still pure JSON (`{` first
character, `JSON.parse` succeeds) and that its members are exactly `storeAbsolute, payload` with
`storeAbsolute` `null` when nothing was read (`payload.status=UNMEASURED`,
`payload.reasonCode=NO_DATA_ROOT_RESOLVED`, `payload.affected=no-data-root-resolved`).

### A6 — Theme QA PII section untouched (phase-06 step 5, success criterion 62)

```
$ $l = Get-Content docs/operations.md
$ "143: " + $l[142]; "144: " + $l[143]; "145: " + $l[144]
```
```
143: ### PII Sanitization Guarantee
144: 
145: All generated Theme QA reports automatically redact customer emails, phone numbers, and bearer tokens before saving artifacts or transmitting responses.
```
Byte-identical to the pre-edit file; the new section was inserted at line 149, after the Theme
QA section's closing rule, so nothing above it shifted at all. `docs/operations.md` grew from
528 to 612 lines (the MCP-dispatch section's later expansions moved its tail, not this
anchor); the anchor was re-printed after every edit to that section, most recently after the
`--json` and histogram-key changes (deviation rows 16 and 20).

### A7 — Live store, pinned `--as-of`: MEASURED (phase-06 step 7, first row) — RUN

```
$ node scripts/antifan-mcp-dispatch-account.cjs `
    --store "E:\Work\.antifan-data\control-plane-v2\invocations" `
    --as-of 2026-09-17T03:41:00.000Z
```
```
store: E:\Work\.antifan-data\control-plane-v2\invocations  (memo=off (default))
status: MEASURED
reasonCode: OK
asOf: 2026-09-17T03:41:00.000Z
storePath: invocations
classifiedKeys + unattributedKeys == compositeKeys  (19127 + 0 == 19127)
frames == compositeKeys + superseded + keylessFrames  (19423 == 19127 + 296 + 0)
quarantine margin: present 254 = admitted 247 + named-invalid 7 (CHECKSUM_MISMATCH writer-canonicalization-array-slot 7) — a margin, not a recovery promise
rows: 83
  anti.browser.evaluate  calls=9079 frames=9079 superseded=0 states=[completed:8638,failed:392,in_progress:40,interrupted:5,unknown:4] errors=[CAPABILITY_ERROR:134,CAPABILITY_NOT_FOUND:12,EXECUTION_TIMEOUT:5,EXECUTION_UNKNOWN:4,NO_RENDER_SURFACE:111,POLICY_DENIED:14,TARGET_MISMATCH:119,TARGET_REQUIRED:1,TARGET_STALE:1] latency=p50=10ms p95=868ms (n=9035)
  browser.navigate  calls=884 frames=884 superseded=0 states=[completed:800,failed:77,in_progress:6,unknown:1] errors=[CAPABILITY_NOT_FOUND:9,EXECUTION_UNKNOWN:1,INVALID_ARGUMENT:5,POLICY_DENIED:1,TARGET_MISMATCH:29,TARGET_REQUIRED:2,TARGET_STALE:31] latency=p50=1632ms p95=6032ms (n=877)
  browser.switch-tab  calls=787 frames=787 superseded=0 states=[completed:765,failed:19,in_progress:2,unknown:1] errors=[EXECUTION_UNKNOWN:1,INVALID_ARGUMENT:3,POLICY_DENIED:1,TARGET_MISMATCH:10,TARGET_NOT_ACTIVATABLE:2,TARGET_REQUIRED:3] latency=p50=16ms p95=41ms (n=784)
  browser.set-automation-target  calls=779 frames=779 superseded=0 states=[completed:739,failed:33,in_progress:7] errors=[INVALID_ARGUMENT:33] latency=p50=4ms p95=11ms (n=772)
  browser.inspect_styles  calls=695 frames=695 superseded=0 states=[completed:610,failed:79,in_progress:1,unknown:5] errors=[CAPABILITY_NOT_FOUND:13,EXECUTION_UNKNOWN:5,NODE_DETACHED:10,TARGET_MISMATCH:28,TARGET_REQUIRED:1,TARGET_STALE:26,WAIT_TIMEOUT:1] latency=p50=6ms p95=16ms (n=689)
  browser.list-tabs  calls=694 frames=694 superseded=0 states=[completed:692,in_progress:2] errors=[none] latency=p50=3ms p95=34ms (n=692)
exit=0
```
Both reconciliation invariants hold **with the run's own numbers**, both reduce to the same
closed system (`19,423 = 19,127 + 296 + 0`, `19,127 + 0 = 19,127`), and the margin label
carries the `a margin, not a recovery promise` clause verbatim. The remaining 77 rows are
omitted here only for length — they are the same field shape, and the command above
reproduces every one of them.

### A8 — Empty store through the CLI (phase-04 C2) — RUN

```
$ $dir = Join-Path $env:TEMP ("antifan-empty-store-" + [guid]::NewGuid().ToString('N'))
$ New-Item -ItemType Directory -Path $dir | Out-Null
$ node scripts/antifan-mcp-dispatch-account.cjs --store $dir --as-of 2026-09-17T03:41:00.000Z
```
```
store: C:\Users\Admin\AppData\Local\Temp\antifan-empty-store-86a2e196402c4cb9b6a698d7baf989f8  (memo=off (default))
status: UNMEASURED
reasonCode: NO_DATA
asOf: 2026-09-17T03:41:00.000Z
storePath: antifan-empty-store-86a2e196402c4cb9b6a698d7baf989f8
affected: antifan-empty-store-86a2e196402c4cb9b6a698d7baf989f8
rows: 0
```
`exit=0`. The `--json` form was re-run and checked field by field after the document shape
changed:
```
stdout first character      = "{"
document members            = storeAbsolute, payload
payload.status              = UNMEASURED
payload.reasonCode          = NO_DATA
payload.totals              = <null>          (null in the JSON document)
payload.rows length         = 0
payload.storePath           = antifan-empty-store-1dfd4cc8904847d39994c5c882ac91fc
storeAbsolute               = C:\Users\Admin\AppData\Local\Temp\antifan-empty-store-1dfd4cc8904847d39994c5c882ac91fc
payload has an absolute key?= False
literal 0 anywhere in .payload = False
```
`storePath` is the store's final path segment (separator-free, no drive letter) and
`storeAbsolute` is the absolute directory that was read, disclosed **beside** the payload
rather than inside it (deviation rows 16 and 12). The literal-`0` check
(`-match '(?<![0-9])0(?![0-9])'`) is run over the serialized `.payload` rather than the whole
document, because the CLI's own `storeAbsolute` is allowed to contain digits: the rule is
about the payload never rendering `0` for missing data, and the payload contains no such
character at all.

### A9 — Freeze against a directory that does not exist — RUN

```
$ node scripts/antifan-mcp-dispatch-account.cjs --store "$env:TEMP\antifan-absent-store" `
    --as-of 2026-09-17T03:41:00.000Z --freeze
```
```
store: C:\Users\Admin\AppData\Local\Temp\antifan-absent-store  (memo=off (default))
status: UNMEASURED
reasonCode: DIR_UNREADABLE
asOf: 2026-09-17T03:41:00.000Z
storePath: antifan-absent-store
affected: dir-unreadable
rows: 0
```
stderr, `exit=0`:
```
[accounting:mcp-dispatch] FAIL cannot freeze C:\Users\Admin\AppData\Local\Temp\antifan-absent-store: ENOENT: no such file or directory, scandir 'C:\Users\Admin\AppData\Local\Temp\antifan-absent-store'
```
`Test-Path` on that path afterwards → `False`: **no directory was created** and no snapshot
was left behind. The failure is named on stderr, the envelope stays well-formed, and the
status is still data rather than an exit-code failure. Re-run after the label change: byte
for byte the same output, because this branch labels the store through the CLI's **guarded
local fallback** (the reader module is not loaded on a path that failed before the require)
and `antifan-absent-store` is a final segment that is not a drive root.

### A10 — Frozen copy, byte-identity modulo `asOf` (phase-04 C1) — RUN, with one finding

```
$ $out1 = node scripts/antifan-mcp-dispatch-account.cjs `
    --store "E:\Work\.antifan-data\control-plane-v2\invocations" `
    --as-of 2026-09-17T03:41:00.000Z --freeze --json
$ ($out1 | ConvertFrom-Json).storeAbsolute
```
```
exit(freeze)=0
snapshot=C:\Users\Admin\AppData\Local\Temp\antifan-mcp-dispatch-freeze-39784-2026-09-17T05-20-17-322Z
```
```
$ node scripts/antifan-mcp-dispatch-account.cjs --store $freeze --as-of 2026-09-17T03:41:00.000Z --json > dispatch-run-a.json   # exit(a)=0
$ node scripts/antifan-mcp-dispatch-account.cjs --store $freeze --as-of 2026-09-17T03:41:00.000Z --json > dispatch-run-b.json   # exit(b)=0
$ node scripts/antifan-mcp-dispatch-account.cjs --store $freeze --as-of 2026-09-17T04:00:00.000Z --json > dispatch-run-c.json   # exit(c)=0
```
```
a-vs-b differing lines: 2  (a lines=19938)
a-vs-c differing lines: 6
```
```
$ Compare-Object $a $b | % { $_.SideIndicator + '  ' + $_.InputObject.Trim() }
=>  "elapsedMs": 5400,
<=  "elapsedMs": 6087,
```
```
$ Compare-Object $a $c | % { $_.InputObject.Trim() }
"asOf": "2026-09-17T04:00:00.000Z",
"asOf": "2026-09-17T04:00:00.000Z",
"elapsedMs": 5475,
"asOf": "2026-09-17T03:41:00.000Z",
"asOf": "2026-09-17T03:41:00.000Z",
"elapsedMs": 6087,
```
The block above is a **re-run of the whole row** after the `--json` document became
`{ storeAbsolute, payload }` (deviation row 16); the earlier capture is replaced rather than
edited, which is why the snapshot id, the line count and the durations differ from the first
version of this row. The snapshot's own label is disclosed separator-free beside the absolute
path, both members of that one document:
```
"storeAbsolute": "C:\\Users\\Admin\\AppData\\Local\\Temp\\antifan-mcp-dispatch-freeze-39784-2026-09-17T05-20-17-322Z",
"storePath": "antifan-mcp-dispatch-freeze-39784-2026-09-17T05-20-17-322Z",
```
**Finding (recorded, not smoothed over).** Two runs reading the *same* frozen copy with the
*same* pinned `--as-of` are byte-identical across 19,938 lines **except for one field**:
`census.elapsedMs` (`6087` vs `5400`), the pass's own wall-clock duration, which cannot be
deterministic by construction. Against a different `--as-of` the differences are exactly
`asOf` (twice: the envelope's and the census's) and that same `elapsedMs`. So "byte-identity
modulo `asOf`" holds for every store-derived value in the document and fails only on the
reader's self-measurement. Reproduce the strict form — zero differing lines — by deleting the
`elapsedMs` line from both captures before comparing, or by re-wording C1 as byte-identity
modulo `asOf` and `census.elapsedMs`. This receipt does not silently adopt either: the row
above is the raw comparison.

The same snapshot also gives the pass's real cost on this workstation: **~5.4–6.1 s** across
these three runs, `filesRead: 1044`, `filesSkipped: 0`, `ceiling: null`,
`outcome: "COMPLETE"`, and
`censusHash: dd978410cab83d3fb72736b3904d88a55f1eb17caa0bf9144a8ecf5f55b953f7` — i.e. the
default budget and the input ceiling both held, and the newest/oldest `mtime` window the read
covered is published in `census` beside them.

### A11 — `core-attempts` delegation (phase-05 surface, adjudicated) — RUN

```
$ node scripts/antifan-mcp-dispatch-account.cjs --core-attempts --dir "$env:TEMP\antifan-cli-probe-96f00a44549e4dfdbc514a9d28cc56d1"
```
```
core-attempts: UNMEASURED (NO_STORE_DIR)
store: C:\Users\Admin\AppData\Local\Temp\antifan-cli-probe-96f00a44549e4dfdbc514a9d28cc56d1
instrumentedSince: (none)
files: 0  attempts: 0  ok: 0  error: 0
dispatched: 0  unknown-capability: 0
durationMs p50: UNMEASURED  p95: UNMEASURED  samples: 0
errorCode histogram: (none)
refusals: 0  drops: 0  unparseable lines: 0
exit=0
```
```
$ node scripts/antifan-mcp-dispatch-account.cjs --core-attempts --json --dir "<the same dir>"
```
```
{
  "unit": "proxy-attempt",
  "provenance": "omp-proxy",
  "status": "UNMEASURED",
  "reasonCode": "NO_STORE_DIR",
  "storePath": "C:\\Users\\Admin\\AppData\\Local\\Temp\\antifan-cli-probe-96f00a44549e4dfdbc514a9d28cc56d1",
exit=0
```
```
$ node scripts/antifan-mcp-dispatch-account.cjs --core-attempts --json        # ANTIFAN_DATA_ROOT is set
```
```
"status": "UNMEASURED",
"reasonCode": "STORE_ABSENT",
"storePath": "E:\\Work\\.antifan-data\\telemetry\\core-attempts",
exit=0
```
The delegation is observable in all three: stdout is the **proxy's** own report (its `unit`
is `proxy-attempt`, its `provenance` is `omp-proxy`, its schema is its own), streamed
unchanged, with the proxy's exit code propagated. The third run proves the store derivation:
`ANTIFAN_DATA_ROOT=E:\Work\.antifan-data` produced exactly
`E:\Work\.antifan-data\telemetry\core-attempts` — the sibling the bridge mints — and not the
resolved invocation directory. `STORE_ABSENT` is correct and informative: the proxy has not
written an attempt record on this machine yet, which is "not yet instrumented", not "unused".
The delegated `--json` document is the proxy's own flat schema (its members are `unit`,
`provenance`, `status`, `reasonCode`, `storePath`, `files`, `perFile`, `attempts`, …,
`instrumentedSince`, `launchPaths`, `note` — observed on this run) and is **not** wrapped in
this CLI's `{ storeAbsolute, payload }` shape: the facade forwards the owner's document
unchanged rather than re-framing another component's contract (deviation row 16).

Refusal rows, all `exit=2`, each naming the reason on stderr and nothing read:
```
[accounting:mcp-dispatch] --freeze applies to the ledger section; the core-attempts store is read in place by the proxy
[accounting:mcp-dispatch] --as-of does not apply to the core-attempts section; the proxy reader reports its own store state
[accounting:mcp-dispatch] --dir only applies to --core-attempts
[accounting:mcp-dispatch] --dir needs a directory argument
```

### A12 — `--json` document shape: one JSON document, two members (adjudicated change) — RUN

```
$ node <probe>.cjs     # spawns the CLI, captures stdout, asserts it parses
```
```
exit=0
stdout bytes=524
first character="{"
JSON.parse ok: document members=storeAbsolute,payload
payload.status=UNMEASURED payload.reasonCode=NO_DATA
storeAbsolute=C:\Users\Admin\AppData\Local\Temp\antifan-empty-store-1dfd4cc8904847d39994c5c882ac91fc
payload members=status,reasonCode,affected,evidenceRefs,asOf,storePath,census,fileRollups,rows,totals,reconciliation
payload carries storeAbsolute? false
```
stdout begins with `{`, not with a `store:` prefix line, so `JSON.parse(stdout)` is well
defined, and the document has exactly two members: `storeAbsolute` (the CLI's own disclosure
of the store the run read, `null` when nothing was read) and `payload` (exactly the envelope
the renderer boundary would carry — the eleven frozen keys, with **no** `storeAbsolute` in it).
That separation is the point: an absolute location is permitted in a CLI, and is forbidden
*inside* the renderer payload, so the two documents are two members rather than one flat
object. It is a **breaking change** for any consumer that parsed the old flat shape (deviation
row 16), and it is what lets the shipped gate be run over `.payload` unchanged (A3, A13).
Human mode is unchanged and still leads with `store: <absolute>`:
```
$ node scripts/antifan-mcp-dispatch-account.cjs --store <probe> --as-of 2026-09-17T03:41:00.000Z
store: C:\Users\Admin\AppData\Local\Temp\antifan-cli-probe-96f00a44549e4dfdbc514a9d28cc56d1  (memo=off (default))
status: UNMEASURED
exit=0
```
The frozen-copy row (A10) was re-run **after** this change (that row is the re-run) and still
shows the same single `elapsedMs` difference, so the wrapper did not disturb the identity
proof.

### A13 — Rule 3 against real reader output, and the key-blindness it caught (review-driven) — RUN

Two of the ten tests in A3 are the end-to-end rows, and the seeded directory carries the
regression. The defect they close: rule 3 recursed over `Object.entries(value)` but passed
only the **child** to itself, so it inspected values and never keys. A payload whose only
violation was a histogram key —

```json
"rows": [ { "name": "browser.dom", "errors": { "EXECUTION_TIMEOUT": 1, "C:\\Users\\Admin\\secrets": 1 } } ]
```

— printed `OK` with `exit=0`, even though `rows[].errors` is keyed by the persisted
`frame.error.code` and therefore carries writer-supplied text straight to the renderer. The
gate now checks the key string, recursively, and names it in the failure trail (A2's
`location-key.json` line). The other half is the missing end-to-end proof: the test builds a
three-partition store whose frames are checksum-valid by the writer's own seam, runs this CLI
over it, takes `.payload` out of the real `--json` document and puts it through all the rules —
```
✔ the payload gate accepts the payload the real reader emits, histogram included
✔ the payload gate rejects a location-shaped histogram key in real reader output
```
That same test also asserts the reverse: the CLI's whole document, fed to the gate as if it
were a payload, is rejected by rule 1 (`storeAbsolute` is not in the frozen allowlist) **and**
rule 3 (the absolute path it carries) — the two failures that first exposed the mismatch, now
asserted as the boundary they are. Before these rows the gate had never seen output it did not
also author. The reader-side fix (every non-conforming histogram key published as
`UNRECOGNIZED` with its count summed, `HISTOGRAM_TOKEN_PATTERN` in
`src/shared/mcp-dispatch-contracts.ts`) is the first defence; this gate is the second, and it
holds regardless of which producer emits the key.

### A14 — Label ownership: the CLI uses the module's rule, with a guarded fallback — RUN

```
$ node scripts/antifan-mcp-dispatch-account.cjs --store "Q:\" --freeze --json
```
```
{
  "storeAbsolute": null,
  "payload": {
    "status": "UNMEASURED",
    "reasonCode": "DIR_UNREADABLE",
    "affected": [
      "dir-unreadable"
    ],
    "evidenceRefs": [],
    "asOf": "2026-09-17T05:22:23.159Z",
    "storePath": null,
    "census": null,
    "fileRollups": [],
    "rows": [],
    "totals": null,
    "reconciliation": null
  }
}
exit=0
```
```
$ node scripts/antifan-mcp-dispatch-account.cjs --store "Q:/" --freeze --json
```
```
{
  "storeAbsolute": null,
  "payload": {
    "status": "UNMEASURED",
    "reasonCode": "DIR_UNREADABLE",
    "affected": [
      "dir-unreadable"
    ],
    "evidenceRefs": [],
    "asOf": "2026-09-17T05:22:23.245Z",
    "storePath": null,
    "census": null,
    "fileRollups": [],
    "rows": [],
    "totals": null,
    "reconciliation": null
  }
}
exit=0
```
The third run is the same surface on a store that exists — two lines extracted from its much
larger document (a `MEASURED` payload with rows), quoted because they are the whole point of
the row:
```
$ node scripts/antifan-mcp-dispatch-account.cjs --store <real store> --as-of 2099-01-01T00:00:00.000Z --json
  "storeAbsolute": "C:\\Users\\Admin\\AppData\\Local\\Temp\\antifan-receipt-store-f9D5GJ",
  "storePath": "antifan-receipt-store-f9D5GJ",
```
A drive root's final segment **is** a drive letter, which phase-01's hard rule bans exactly as
it bans a separator, so the label is absent (`null`) rather than `Q:`. The first two rows go
through the CLI's **local fallback** — they are `DIR_UNREADABLE` branches, which run when the
reader module cannot be loaded — and the third goes through the module's own exported
`storeDisplayLabel`, so both copies of the rule must agree; they now do, because the local copy
carries the same drive-root guard (deviation row 17). The third row also shows the two members
in place: the absolute path is `storeAbsolute`, and the separator-free label is inside
`payload`.

---

## Part B — NOT YET RUN

Every row below is **NOT YET RUN**. No output is recorded, and none may be inferred from the
presence of a row.

### B1 — Mid-read append against the live store (phase-06 step 7) — NOT YET RUN

Not run because it **mutates the live store** while it is the operator's only history of
dispatch traffic; that is the operator's call, not a side effect of writing a receipt. The
procedure is complete and ready:

```powershell
# Terminal A — the reader (a full pass takes ~11.8 s on this store, so the window is wide)
node scripts/antifan-mcp-dispatch-account.cjs `
  --store "E:\Work\.antifan-data\control-plane-v2\invocations" `
  --as-of 2026-09-17T03:41:00.000Z --json | Set-Content "$env:TEMP\dispatch-append.json"

# Terminal B — run this WHILE terminal A is still reading
$partition = (Get-ChildItem "E:\Work\.antifan-data\control-plane-v2\invocations\*.jsonl" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
$lastLine = Get-Content $partition -Tail 1
[System.IO.File]::AppendAllText($partition, $lastLine + "`n")
"appended to $partition"
```
Expected: `exit=0`, a `MEASURED` envelope, and the appended bytes **named, not silently
half-read** — the file's roll-up/short-read counters report one `POST_CENSUS_APPEND` (the
reader reads exactly the censused byte length, so bytes written after the census are outside
the read and cannot inflate any count). No exception; no `CENSUS_DRIFT`; the partition's
ordinary frames remain admitted.

Read before running:
1. This writes to the **live** store. The appender must write one **byte-valid** line —
   copying the partition's own last line is safe by construction: identity is the composite
   `(attachmentId, idempotencyKey)`, so a duplicate frame becomes `superseded`, never invalid.
2. A hand-typed, truncated or otherwise malformed line would make the ledger quarantine the
   **whole partition** on its next boot (`quarantinePartition`), stranding every valid frame
   in it and enlarging the margin instead of producing evidence. Do not type a frame by hand.
3. `Add-Content` appends CRLF; the .NET `AppendAllText` form above appends exactly `\n`, which
   is the writer's own terminator.
4. Lower-risk rehearsal, which touches no live file: copy one partition into a scratch
   directory, run the CLI with `--store <scratch>`, and append to the **copy** during the
   read. Same classification branch, same expected counter; the live row is still required
   because only it proves the reader against the real writer's concurrency.

### B2 — Compaction mid-read against the live store (phase-06 step 7) — NOT YET RUN

Not run because it needs the application running and driving ≥ 200 dispatches on one
attachment; the reader half alone cannot produce a compaction.

```powershell
# 1. Start the app and drive >= 200 dispatches on ONE attachment so the ledger compacts it:
#    compaction fires on the claim/settle after uncompactedFrameCounts >= maxHotRecordsPerPartition (default 200).
npm run dev

# 2. In a second terminal, while the app is writing, read repeatedly:
1..5 | ForEach-Object {
  node scripts/antifan-mcp-dispatch-account.cjs `
    --store "E:\Work\.antifan-data\control-plane-v2\invocations" `
    --as-of 2026-09-17T03:41:00.000Z --json | Set-Content "$env:TEMP\dispatch-compact-$_.json"
  "run $_ exit=$LASTEXITCODE"
}
```
Expected: every run exits `0`; at least one run names the compaction instead of throwing or
dropping frames — `VANISHED` when the partition that was censused is renamed away before it
is read, and/or `POST_CENSUS_TRUNCATE` when the rename lands between the read and the
verification. A `*.jsonl.tmp-*` file present at census time is itself part of the population
(the rule is `includes('.jsonl')`) and its frames are admitted, so the row must record which
outcome occurred — an unrecorded outcome is not evidence. The CLI never induces any of this:
it is read-only, and every write in this race comes from the app's own ledger.

### B3 — Core-freeze re-certification and its new identity (phase-06 step 6) — NOT YET RUN

```powershell
npm run certify:core-freeze
"exit=$LASTEXITCODE"
Select-String -Path "plans\260905-0012-core-pre-freeze-hardening-and-live-proof\reports\freeze-certificate.json" `
  -Pattern 'buildIdentity'
```
Expected: the certification completes and its `buildIdentity` **differs** from the value
recorded before the checksum-seam extraction, because
`.compiled/src/main/session/invocation-ledger.js` is one of the eleven inputs
`computeBuildIdentity()` hashes in `scripts/certify-core-freeze.cjs`. Record the new identity
verbatim here. Two implementation facts to assert alongside it: the seam's own emit
(`.compiled/src/main/session/invocation-frame-checksum.js`) is **not** in that eleven-input
list, and the re-exported ceiling surfaces in the emit as a `defineProperty` **getter** rather
than a copied value binding — so assert the runtime value (`64 * 1024 * 1024`, i.e.
`67108864`) instead of grep-matching a literal in the emitted text.

### B4 — Full lane run (phase-06 step 8, success criterion 64) — NOT YET RUN

```powershell
npm run compile
npm run test:fast
npm run test:main
npm run test:unit
npm run audit
npm run plans:check
```
Expected: each exits `0`; `compile` ends with
`[mcp-dispatch-payload] OK: 4 payload fixture(s) obey the frozen projection`; `audit` ends with
`[bottlenecks] OK — every declared status matches HEAD.` and `OPEN=2` (B23 and B33);
`plans:check` reports `plans=514 classified=514 …` (it was run in isolation and exited `0`,
so the new receipt artifact does not disturb it). Paste the tail of each command here.

### B5 — Chain position, empirical half (phase-06 G7) — NOT YET RUN

```powershell
Copy-Item test/fixtures/mcp-dispatch-payload/measured.json "$env:TEMP\measured.json.bak"
$text = Get-Content test/fixtures/mcp-dispatch-payload/measured.json -Raw
$text.Replace('"reasonCode": "OK",', '"reasonCode": "OK",' + "`n  " + '"runtimeLeaseToken": "seed",') |
  Set-Content test/fixtures/mcp-dispatch-payload/measured.json
npm run compile
"compile exit=$LASTEXITCODE"
Copy-Item "$env:TEMP\measured.json.bak" test/fixtures/mcp-dispatch-payload/measured.json -Force
node scripts/check-mcp-dispatch-payload.mjs
"restored exit=$LASTEXITCODE"
```
Expected: `compile exit=1`; the compile log shows `npm run build:extension` (and therefore
`copy-static`) **completed before** the gate's `FAIL` line, so a gate failure can never land in
the fresh-`toolbar.js`/stale-`toolbar.html` window; then the restore leaves the tree green
(`restored exit=0`). This row temporarily edits a committed fixture — run it on a clean tree,
and treat the restore as part of the row, not as cleanup.

---

## Deviations from the phase text, recorded rather than hidden

| # | Phase text says | This change does | Why |
|---|---|---|---|
| 1 | fixtures under `test/fixtures/mcp-dispatch/` (phase-06 `:29`, `:40`) | `test/fixtures/mcp-dispatch-payload/` (role fixtures) and `.../seeded/` (red fixtures) | the delegating agent assigned that exact path, and the plan has since been corrected to it |
| 2 | `totals.truncation = { ceiling, filesRead, filesSkipped, order }` plus "the `partial: N of M files` label" | the ceiling fixture also carries `totals.truncation.label`, and the gate requires the label to equal the string derived from `filesRead`/`filesSkipped` | the label has to live where the gate can read it; if the module derives it at render time, the gate still checks the derived string appears in the payload |
| 3 | `--freeze` copies into `os.tmpdir()` and reads the copy; C1 wants two runs byte-identical | the snapshot directory is unique per invocation and its path is reported in `storeAbsolute`; byte-identity is asserted over two runs reading that one snapshot | a unique path is the only way two freezes cannot mix bytes; the compared run is the form phase-04's step-10 gate command uses, and the path is now inside the JSON rather than on a prefix line |
| 4 | Phase 5 adds a `core-attempts` reader to the accounting CLI | `--core-attempts` **delegates**: it spawns `node scripts/antifan-omp-mcp.cjs --core-attempts [--json] [--dir <dir>]`, streams its output unchanged and propagates its exit code. A12/A11 prove it | the reader landed on the proxy, which owns the store; two readers with two schemas would be the second source of truth this plan exists to avoid |
| 5 | `--json` prints the envelope as JSON | stdout is one JSON document **only**, with exactly two members: `{ storeAbsolute, payload }`. `payload` is the envelope the renderer boundary carries; `storeAbsolute` is the CLI's disclosure of the store it read (`null` when nothing was read). Human mode keeps the `store: <absolute>` first line | a machine consumer doing `JSON.parse(stdout)` must not have to strip a prefix line, and the CLI is still where an absolute location is permitted (phase-01 §7) — but the *payload* is not, so the location had to stop riding **inside** the object the project's own gate validates. It is a breaking change for a consumer of the old flat shape (row 16) |
| 6 | `accountStore({ storeDir, asOf, memo })` | the CLI also passes `mode: 'in-process'` | phase-04 step 7 mandates Phase 1's in-process mode; `mode` is Phase 1's own vocabulary and the only channel for it through this signature |
| 7 | exit codes `0` / `2` | `0` also for a missing compiled module (well-formed `SERVICE_FAILED` envelope plus a loud stderr line); `1` when the delegated reader cannot be spawned or does not exit normally; `2` for a refused flag combination | `SERVICE_FAILED` is `UNMEASURED`, and the frozen rule is "0 when a well-formed envelope was printed — the status is data, not a failure"; `1` is the CLI's existing unexpected-failure code and is never used for a printed envelope |
| 8 | phase-04 `:32`: `storePath` is "the final **two** path segments only (e.g. `control-plane-v2/invocations`)" | the CLI uses the reader module's exported `storeDisplayLabel` on every path where that module loads, and its own guarded copy of the same rule on the branches that run when it does not — the **final path segment** only (`invocations`, `antifan-empty-store-<id>`, `null` for a drive root) — for every envelope it synthesizes | phase-01 `:203` (the phase that freezes the envelope) forbids `/`, `\` or a drive letter in the label, and a two-segment label reaches its second segment *through a separator*; the module's rule satisfies both phases' hard constraints while the parenthetical example contradicts phase-01. The conflict is the plan's, and the module owner's rule is the one already on the wire |
| 9 | C1/step 7: "byte-identity modulo `asOf`" | the row records the raw comparison: identical across 19,938 lines **except** `census.elapsedMs`, the pass's own duration (A10, re-run) | a wall-clock measurement cannot be deterministic; the finding is recorded rather than smoothed, and the criterion needs either normalization or a re-wording by the phase owner |
| 10 | proxy `errorCode` histogram | the proxy derives the code defensively — `err.code`, then `JSON.parse(err.message).code`, then the literal `'ERROR'` — so an `ERROR` bucket means **"no code derivable"**, a weaker claim than "the call failed generically"; without the middle step `CORE_UNAVAILABLE`, `CAPABILITY_NOT_FOUND` and unknown-capability would collapse into one content-free bucket | the launcher's `invokeCore` serializes every store refusal as `new Error(JSON.stringify({ code, … }))` and attaches no `.code`, so the histogram would otherwise lose the distinction the plan's per-code table exists to show |
| 11 | — | the accounting CLI accepts `--dir <dir>` as the explicit attempt store for `--core-attempts` and **refuses** `--freeze` / `--as-of` with that section | the proxy owns `--dir` and it is the only way to point the attempt reader explicitly on a machine where `ANTIFAN_DATA_ROOT` is set; silently ignoring `--freeze`/`--as-of` would let an operator believe a flag pinned a read it never touched |
| 12 | — | the proxy's own report names the **absolute** attempt-store path in `storePath`, while the ledger payload's `storePath` is a display label | two schemas over two stores, streamed unchanged by the facade; the field name is the proxy owner's and is noted here rather than renamed from a file this phase does not own |
| 13 | — | **Limitation (disclosed, not measured away):** the attempt store **undercounts `core.*` calls** by exactly the two refusal classes that end before the emitter is reached — the session tool-surface policy (`REFUSED_TOOL_SURFACE`) and the advertised required-field contract (`INVALID_ARGUMENT`, e.g. `core.record_observation` without `source`/`kind`). Verified in `scripts/antifan-omp-mcp.cjs` `invoke()`: `isCapabilityPermitted(...)` throws `REFUSED_TOOL_SURFACE` and the `declaredRequired` check throws the JSON-bodied `INVALID_ARGUMENT` **before** the `core.` branch that calls `emitCoreAttempt`, so neither class produces a record | without this line, "0 attempts" for a tool that is actually being refused pre-wrap is indistinguishable from "not instrumented", and the two states need opposite responses: a policy working correctly versus a coverage hole. `instrumentedSince` and the launch-path column are what separate them |
| 14 | proxy attempt-store bounds and precedence | re-verified in source, not taken on report: defaults `262144` bytes (256 KiB) per file and `5` retained files; clamps byte `[4096, 67108864]` and retained `[1, 64]`; a value that does not parse as a finite integer falls back to the **default** (never `NaN`, which would make every size comparison false, i.e. silently unbounded); `0` clamps up to `1`, so the ring cannot be switched off; the ring is directory-wide over **rotated** files only, sorted oldest-first by `(mtime, name)`, and another pid's active file is never a prune candidate; directory precedence is explicit `--dir` → `ANTIFAN_PROXY_TELEMETRY_DIR` → `UNMEASURED`/`NO_STORE_DIR` with `storePath: null`, with no directory ever created and no path ever guessed | these are the operator-visible bounds; the facade passes `--dir` explicitly whenever it resolved a root (A11), so the attempt-store precedence is not duplicated between the two surfaces |
| 15 | — | **Defect found by adversarial review and fixed: rule 3 was key-blind.** `checkNoAbsoluteLocation` recursed over `Object.entries(value)` but passed only the child, so it inspected values and never keys; a payload whose only violation was `rows[0].errors = { "C:\\Users\\Admin\\secrets": 1 }` — a histogram keyed by the persisted `frame.error.code` — printed `OK` with `exit=0`. Rule 3 now checks the key string recursively and names the offending path (`payload.rows[0].errors["C:\\Users\\Admin\\secrets"]`), `seeded/location-key.json` trips rule 3 **alone**, and two tests cover it end to end (A2, A13) | the leak the rule exists to stop was reachable through the one channel a value-only walk cannot see; the reader-side `UNRECOGNIZED` rename (row 20) closes the producer, and this gate is the independent second defence that must hold regardless of who produced the key |
| 16 | `--json` prints the envelope | **Breaking change:** the document is `{ "storeAbsolute": <string|null>, "payload": { <the envelope> } }`. A consumer must read `.payload` for the envelope and `.storeAbsolute` for the CLI's own location. The CLI's whole document is deliberately **not** a valid payload — the new test asserts the gate rejects it by rule 1 (`storeAbsolute` is not in the frozen allowlist) and rule 3 (the absolute path it carries) | the previous flat object put a key the project's own gate rejects *inside* the payload it was validating, so the gate could never be run over real CLI output; keeping the two documents as two members makes "absolute paths stay in the CLI, never in the renderer payload" structural rather than a convention (A12, A13) |
| 17 | — | **Divergence found by review and fixed:** the CLI's private `storeDisplayLabel` copy lacked the module's drive-root guard, so `--store "Q:\" --freeze --json` published `"storePath": "Q:"` — a drive letter as a label, which phase-01's hard rule forbids — while its comment claimed to mirror the module. The CLI now uses the module's exported `storeDisplayLabel` whenever it loads, and its **local fallback** (kept only for the `SERVICE_FAILED`/`DIR_UNREADABLE` branches, which are exactly the paths where the module cannot be required) carries the same drive-root guard; `Q:\` and `Q:/` now both publish `storePath: null` (A14) | one rule, two call paths, no third spelling. The fallback exists because the branches that must label a store are the branches where the owner is unavailable, and its token strings are spelled out rather than imported for the same reason — a `require` of the enum would fail on the very paths that need it |
| 18 | — | plan text for the two contract changes recorded here, not edited here: `--json`'s two-member document (row 16) and the histogram key-space boundary (row 20) are documented in the plan at `plan.md:74`, `phase-03:29`, `phase-04:34` and `phase-06:26`, all four updated by the integrator | the plan is the integrator's to edit; this receipt states the mapping so a reviewer can check docs against plan without guessing which line moved |
| 19 | — | the committed payload fixtures keep the phase-04 `:32` example label form (`"storePath": "control-plane-v2/invocations"`), deliberately | rules 1–3 are **shape** rules and no rule reads that string; the *implemented* label rule (separator-free final segment, no drive letter) is pinned where it matters — on real reader output, by the new end-to-end test's `storePath` assertion — rather than by rewriting fixtures whose only job is to model a shape |
| 20 | — | the reader's histogram key space is bounded at publication: a persisted `frame.state`/`frame.error.code` is published verbatim only if it matches `HISTOGRAM_TOKEN_PATTERN` and is not location-shaped, and everything else becomes `UNRECOGNIZED` with its count **summed**, never dropped (`src/shared/mcp-dispatch-contracts.ts` `:693`/`:696`, applied in the reader's `sortedHistogram`). `docs/operations.md` now states this beside the row bullet as a boundary rule rather than a display choice | a persisted `error.code` is writer-supplied text that nothing validates on the way in, so without the rename a single crafted frame reaches the renderer as a JSON **key** carrying the operator's file layout. The reader closes production (with its own test asserting the counts survive: `{ UNRECOGNIZED: 3, settled: 1 }`), and the gate's rule 3 closes crossing (row 15) |

No row above weakens a test, deletes a file, or changes an existing script's behaviour.

## Artifacts in this change

- `scripts/check-mcp-dispatch-payload.mjs` — the source-only gate (5 rules, `--fixture`,
  `--quiet`); rule 3 inspects keys as well as values (row 15).
- `scripts/antifan-mcp-dispatch-account.cjs` — the CLI: `--store`/`ANTIFAN_DATA_ROOT`
  resolution, `--freeze` snapshots, a pure-JSON `--json` mode whose document is
  `{ storeAbsolute, payload }` (row 16), the module's label rule with a guarded local fallback
  (row 17), and `--core-attempts` delegation with `--dir`.
- `test/fixtures/mcp-dispatch-payload/**` — 4 role fixtures + 5 seeded fixtures (one per rule,
  plus `location-key.json` for the key-shaped leak) + README.
- `test/unit/mcp-dispatch-payload-gate.test.mjs` — the rule-5 self-check plus the runtime
  green/red/empty-store/chain-order rows, the one-rule-per-seed property, and the two
  end-to-end rows over real reader output.
- `package.json` — the gate appended last in `compile`; `accounting:mcp-dispatch` added after
  `certify:core-freeze`.
- `plans/bottlenecks.json` — row `B33` (`file-regex`, status `open`); registry `updatedAt`
  bumped to `2026-09-17`.
- `docs/operations.md` — the `## MCP Dispatch Accounting (Invocation Ledger)` section,
  including the two attempt-store bounds, the five launch paths, the delegation relationship,
  the payload gate's four rules, the two-member `--json` document and the histogram key-space
  boundary; the Theme QA PII section is byte-identical.

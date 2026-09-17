# `mcp-dispatch-payload` fixtures

Hand-built payload documents for `scripts/check-mcp-dispatch-payload.mjs`, the
source-only build gate wired into `npm run compile`.

**Provenance rule: every document here is constructed by hand.** No fixture is a
copy of a live payload, none carries a frame copied from
`invocations`, none carries a real filesystem path, and none
carries a customer URL. Store positions are the display label
`invocations`; the only absolute path in the tree is the
deliberately synthetic `C:\fixture\not-a-real-store` inside a seeded fixture that
exists to make the gate fail; the only URL uses the reserved
`.invalid` TLD (`https://example.invalid/...`). Hash-shaped values are synthetic
`0-9a-f` strings, not digests of any real byte sequence.

## Role fixtures — these must PASS

The gate applies rules 1–3 (allowlist, no frame passthrough, no absolute
path/URL) to every `*.json` in this directory, plus the role expectations below.
The role of each file is declared in the gate source, so a renamed or deleted
fixture is a build failure rather than a silently weaker gate.

| File | Shape it pins |
|---|---|
| `measured.json` | `MEASURED` with two rows; the quarantine margin (`present 2 = admitted 1 + named-invalid 1`) is a labelled margin; `totals.truncation: null`; `fileRollups` carries file **names** with `frames === admitted + namedInvalid`; `reconciliation` holds the two general-form identity lines. |
| `ceiling-tripped.json` | An **input** ceiling: `MEASURED` with every row `lowerBound: true`, `totals.truncation = { ceiling, filesRead: 5, filesSkipped: 1, order: 'mtimeMs-desc,name-asc' }`, the derived label `partial: 5 of 6 files`, and the covered window disclosed in `census.limits`. The ceiling is the injected-scaled one Phase 1 allows tests to drive (`maxBytes: 512` against `observedBytes: 700`), not a production constant. |
| `budget-expired.json` | A **time** budget expiry: `UNMEASURED` / `READ_BUDGET_EXCEEDED` with `census: null`, `totals: null`, `rows: []` — the partial fold is discarded, never published. |
| `empty-store.json` | The empty-store case Phase 6 rule 4 guards: `UNMEASURED` / `NO_DATA` with `totals: null` and `rows: []`. The gate asserts exactly those three facts and then **skips every comparison rule** for this file, so no unguarded `null === null` comparison can fail a build on a machine with no store. `census` is written as `null` here; the rule does not constrain the census shape of this case. |

`empty-store.json` and `budget-expired.json` both carry `totals: null` and
`rows: []`. Rule 4's skip applies to the **declared empty-store role only**; the
budget expiry is a different bounded outcome and is checked against its own
frozen shape (`phase-04` constraint G renders the two differently on purpose).

## Seeded fixtures — `seeded/` must FAIL

The gate is not recursive, so these are never scanned by the default run. They
exist so the red path is committed evidence rather than a claim:

```sh
node scripts/check-mcp-dispatch-payload.mjs --fixture test/fixtures/mcp-dispatch-payload/seeded
# exit 1, one named failure per rule
```

| File | Rule it must trip |
|---|---|
| `seeded/unknown-key.json` | Rule 1 — a `rawFrames` top-level key outside the frozen allowlist. |
| `seeded/frame-passthrough.json` | Rule 2 — a `runtimeLeaseToken` nested inside an *allowed* container (`totals.rejectedSample`), so only the recursive key walk catches it. |
| `seeded/absolute-path.json` | Rule 3 — a drive-letter path in `storePath` and in `affected`. |
| `seeded/url.json` | Rule 3 — an `https://example.invalid/...` value. |

The seeded documents are deliberately minimal: they are not valid payloads and
are not meant to become ones. Each is constructed so that **only** its target
rule fires — a proof that is weaker than it looks if a seed trips three rules at
once.

## Green run

```sh
node scripts/check-mcp-dispatch-payload.mjs
# exit 0: "[mcp-dispatch-payload] OK: 4 payload fixture(s) obey the frozen projection"
```

This run reads nothing but the files in this directory: no runtime store, no
environment variable, no current working directory. `test/unit/mcp-dispatch-payload-gate.test.mjs`
greps the gate's own source to keep it that way (Phase 6 rule 5).

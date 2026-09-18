# Pre-boot state (captured before the new build's first launch)

Captured 2026-09-18 ~10:00 local, app down, data root `E:\Work\.antifan-data`.

Snapshots the phases below cite, recorded here by content — the dumps themselves
stay on the machine that captured them and are ignored by `plans/**/reports/pre-boot/*.jsonl`:
they carry live session ids, attachment secret hashes and user claim text, and this
repository is shared.

- `verification-register.jsonl` — 1,837,479 B, 1001 lines, 1001 unique ids, 0 unparseable.
- `attachments-v1.jsonl` — 3,517 B, 2 records.

## Why these two files

**Phase 1 (register durability).** The first live call after boot must be
`anti.verification.list()` with `totalCount == 1001` (parsed on-disk count) and a
byte length unchanged by the call. The restart *is* the cold start, so this
snapshot is the "before" for a file-backed read proof.

**Phase 2 R1/R4 (replay scoping).** The attachment file holds two records for the
same attachment id, both bound to the stale runtime
`binding-695ac771-c5cc-4182-b0cc-12f37e7d169a`:

| line | issuedAt | expiresAt |
|---|---|---|
| 1 | 2026-09-17T18:35:31.997Z | 2026-09-17T19:35:31.997Z |
| 2 | 2026-09-17T18:35:31.997Z | 2026-09-17T21:35:31.997Z |

The deadline grew by 2 h on a re-record of the *same* attachment — the live form of
the accumulate defect (U32) that `renewAttachment` now fixes with a slide. The first
boot of the new build must drop this foreign-runtime record and compact the file;
that before/after pair is this phase's headline live evidence.

## Phase 5 R6 probe subject (cross-boundary baseline)

Newest stored baseline, captured pre-policy-bump:

`baselines/workspace-bf97df79-8938-4f4f-b609-5f91f2847a36/vbase_1789685078715_52b5bc0c7c2d.json`
(promotedAt 1789685078716, project `project-fbe5d31e-a83f-4534-b8ce-dfe3f842d7ad`)

Its `captureStateMini` is `{backend, dpr, zoom, cssViewport, rasterSize}` — no policy
identity. So the R6 criterion is **not vacuous**: after the bump, comparing against a
baseline captured by the previous build must refuse or label, never silently diff.

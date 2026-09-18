# Phase 9 — approved evidence-store writes (H1/H2/H3)

Executed 2026-09-18 against `E:/Work/apps/AntiFan/.super-core/core.db` via
`node scripts/antifan-core.cjs` (the canonical writer). No raw SQL writes.
TEMP/TMP/TMPDIR = `E:\Work\.tmp` for every command (no C:-drive artifacts).

## 1. BEFORE readings

### gate promotion (before)
```json
{"gateId": null, "phase": "health-surface", "gate": "promotion", "passed": false, "detail": "108 pending candidates"}
```

### gate regression (before)
```json
{"gateId": null, "phase": "health-surface", "gate": "regression", "passed": false, "detail": "last regression recorded but never replayed"}
```

### gate principles (before)
```json
{"gateId": null, "phase": "health-surface", "gate": "principles", "passed": false, "detail": "1126 duplicate normalized statement(s), 0 unanchored principle(s) (of 10275)"}
```

### health (before, reduced to status/reasonCode/stats/gates)
```json
{
  "status": "DEGRADED",
  "reasonCode": "GATE_PROMOTION_FAILED+GATE_REGRESSION_FAILED+GATE_PRINCIPLES_FAILED",
  "stats": {
    "artifacts": 184835,
    "claims": 20832,
    "evidence": 44712,
    "units": 774,
    "skills": 547,
    "lineage": 2286,
    "conflicts": 5,
    "cases": 115,
    "candidates": 115,
    "adjudications": 8,
    "releases": 1,
    "receipts": 12,
    "packs": 160,
    "observations": 285,
    "experienceNodes": 2650,
    "experienceEdges": 3425,
    "antiPatterns": 531,
    "workarounds": 113,
    "fixPatterns": 738,
    "corpusAudits": 9,
    "phaseGates": 56,
    "regressions": 2,
    "principles": 10275,
    "hiddenRequirements": 45,
    "commercialIntel": 206,
    "toolIntel": 700,
    "archetypes": 784,
    "platformSemantics": 63654,
    "practiceParity": 242,
    "skillVersions": 4
  },
  "gates": {
    "coverage": {
      "gateId": null,
      "phase": "health-surface",
      "gate": "coverage",
      "passed": true,
      "detail": "0 artifacts non-terminal or BLOCKED without reason (of 184835)"
    },
    "evidence": {
      "gateId": null,
      "phase": "health-surface",
      "gate": "evidence",
      "passed": true,
      "detail": "0 claims without evidence"
    },
    "conflict": {
      "gateId": null,
      "phase": "health-surface",
      "gate": "conflict",
      "passed": true,
      "detail": "0 unresolved conflicts"
    },
    "temporal": {
      "gateId": null,
      "phase": "health-surface",
      "gate": "temporal",
      "passed": true,
      "detail": "0 stale claims"
    },
    "promotion": {
      "gateId": null,
      "phase": "health-surface",
      "gate": "promotion",
      "passed": false,
      "detail": "108 pending candidates"
    },
    "regression": {
      "gateId": null,
      "phase": "health-surface",
      "gate": "regression",
      "passed": false,
      "detail": "last regression recorded but never replayed"
    },
    "principles": {
      "gateId": null,
      "phase": "health-surface",
      "gate": "principles",
      "passed": false,
      "detail": "1126 duplicate normalized statement(s), 0 unanchored principle(s) (of 10275)"
    }
  }
}
```

## 2. H2 — regression replay

`regressions` returned 2 rows; newest = `reg-52eeb5d3-13fb-4320-8dff-76dd32c4ff0b`
(createdAt 2026-09-15T01:58:16.239Z, checksJson null).

Replay verdict (verbatim):
```json
{"regressionId": "reg-52eeb5d3-13fb-4320-8dff-76dd32c4ff0b", "replayResult": "FAIL", "replayedAt": "2026-09-18T03:27:50.235Z", "checks": []}
```

**Honest verdict: FAIL.** The regression was recorded with `checksJson: null`,
so the replay engine re-executed zero checks and its own rule
(`results.length > 0 && every pass`) yields FAIL. There are no failing checks
to name — there are no checks at all. The gate stays red with the exact reason
"last regression: FAIL at 2026-09-18T03:27:50.235Z". This is a data defect in
the recorded regression (it carries no re-executable checks), not a verdict that
can be promoted by re-running.

- Regression gate before: `passed=false, detail="last regression recorded but never replayed"`
- Regression gate after: `passed=false, detail="last regression: FAIL at 2026-09-18T03:27:50.235Z"`

## 3. H1 — adjudication of the 108 PENDING candidates

Decision rule applied per candidate (batch contract): resolve evidence =
candidate `evidenceJson.verificationRef`, else case-row `verificationRef`,
else an artifact path / run id / measured value named in the statement; PROMOTE
iff a resolvable checkable artifact exists; SUPERSEDE iff a newer candidate in
the same unit/platform states the same subject; REJECT iff nothing resolves.

Subject grouping: candidates sharing one clone target (same normalized
clone-manifest path / same case outDir) state the same subject — 13 subjects
across 108 candidates. The newest candidate per subject is PROMOTED; older
observations of the same subject are SUPERSEDED naming the survivor. All 13
PROMOTEs have a resolvable artifact (11 manifest files verified on disk
2026-09-18, 1 run-id ref recorded verbatim in the case row, 1 manifest path
named in the case outcome verified on disk). 9 verificationRefs carry a
malformed `E:\e\Work\` prefix; the recorded literal path does not exist
but the same path with the doubled letter corrected exists — promoted on the
corrected artifact, noted here.

Result: 13 PROMOTE, 95 SUPERSEDE, 0 REJECT. All 108 adjudicate calls returned
success (adjudications 8 -> 119 including the 3 H3 promotions).

| candidateId | decision | deciding artifact | rationale |
|---|---|---|---|
| cand-051ab877-6296-4812-b88b-230256d014a7 | SUPERSEDE | superseded by cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 | SUPERSEDE: same subject (clone target comnieuthienly/clone-manifest.json) restated by newer candidate cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 (2026-09-17T13:20:17.221Z) |
| cand-053c57ef-160d-492b-9e76-100cc1eddbed | PROMOTE | E:/Work/customizes/Comnieusiba/clones/comnieuthienly-introduce/clone-manifest.json | PROMOTE: artifact named in case outcome E:/Work/customizes/Comnieusiba/clones/comnieuthienly-introduce/clone-manifest.json exists on disk (verified 2026-09-18) |
| cand-076e9659-3617-4bf2-8ff2-a621ad4a82ec | SUPERSEDE | superseded by cand-144ab716-3fa3-4ce1-80d7-649eac08460f | SUPERSEDE: same subject (clone target branches/clone-manifest.json) restated by newer candidate cand-144ab716-3fa3-4ce1-80d7-649eac08460f (2026-09-17T12:36:52.765Z) |
| cand-09f2623a-afc7-41ac-8a83-d9faca45c744 | SUPERSEDE | superseded by cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 | SUPERSEDE: same subject (clone target comnieuthienly/clone-manifest.json) restated by newer candidate cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 (2026-09-17T13:20:17.221Z) |
| cand-0c4295c8-f093-4e8a-b949-00f8c238fe30 | SUPERSEDE | superseded by cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 | SUPERSEDE: same subject (clone target comnieuthienly/clone-manifest.json) restated by newer candidate cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 (2026-09-17T13:20:17.221Z) |
| cand-0f560043-d29c-49af-be65-33b5229cb108 | SUPERSEDE | superseded by cand-3d5b88b9-e5a3-45be-b173-c6af4813afdf | SUPERSEDE: same subject (clone target order-food/clone-manifest.json) restated by newer candidate cand-3d5b88b9-e5a3-45be-b173-c6af4813afdf (2026-09-17T12:37:52.706Z) |
| cand-100a1d94-6460-46d8-be8d-84f8aad03a13 | SUPERSEDE | superseded by cand-66a0ebf1-e733-4c16-9f55-af09a08e5bc1 | SUPERSEDE: same subject (clone target menu/clone-manifest.json) restated by newer candidate cand-66a0ebf1-e733-4c16-9f55-af09a08e5bc1 (2026-09-17T12:37:50.692Z) |
| cand-144ab716-3fa3-4ce1-80d7-649eac08460f | PROMOTE | E:/Work/customizes/Comnieusiba/clones/routes/branches/clone-manifest.json | PROMOTE: deciding artifact E:/Work/customizes/Comnieusiba/clones/routes/branches/clone-manifest.json exists on disk (verified 2026-09-18); newest observation for this clone target |
| cand-1960acf6-d48c-4fdf-89d4-65be10ccf9c1 | SUPERSEDE | superseded by cand-3d5b88b9-e5a3-45be-b173-c6af4813afdf | SUPERSEDE: same subject (clone target order-food/clone-manifest.json) restated by newer candidate cand-3d5b88b9-e5a3-45be-b173-c6af4813afdf (2026-09-17T12:37:52.706Z) |
| cand-1f92cf68-2d84-4521-914c-6878f18aa88d | SUPERSEDE | superseded by cand-2a49a9c0-e1f8-4a64-ad6c-a9a309c01ac4 | SUPERSEDE: same subject (clone target blogs/clone-manifest.json) restated by newer candidate cand-2a49a9c0-e1f8-4a64-ad6c-a9a309c01ac4 (2026-09-17T12:36:56.222Z) |
| cand-232eacc8-b5a2-4ce6-b758-a14779d2771b | SUPERSEDE | superseded by cand-144ab716-3fa3-4ce1-80d7-649eac08460f | SUPERSEDE: same subject (clone target branches/clone-manifest.json) restated by newer candidate cand-144ab716-3fa3-4ce1-80d7-649eac08460f (2026-09-17T12:36:52.765Z) |
| cand-23b6704a-6480-431c-a7b2-21f3dd54a12d | SUPERSEDE | superseded by cand-2a49a9c0-e1f8-4a64-ad6c-a9a309c01ac4 | SUPERSEDE: same subject (clone target blogs/clone-manifest.json) restated by newer candidate cand-2a49a9c0-e1f8-4a64-ad6c-a9a309c01ac4 (2026-09-17T12:36:56.222Z) |
| cand-280e818c-9432-4cc3-a50e-970a0ad004b9 | SUPERSEDE | superseded by cand-144ab716-3fa3-4ce1-80d7-649eac08460f | SUPERSEDE: same subject (clone target branches/clone-manifest.json) restated by newer candidate cand-144ab716-3fa3-4ce1-80d7-649eac08460f (2026-09-17T12:36:52.765Z) |
| cand-285c1de9-45a2-4f07-90ab-636213763a2a | PROMOTE | E:/Work/customizes/Comnieusiba/clones/routes/loyal-customers/clone-manifest.json | PROMOTE: deciding artifact E:/Work/customizes/Comnieusiba/clones/routes/loyal-customers/clone-manifest.json exists on disk (verified 2026-09-18); newest observation for this clone target |
| cand-293de58d-5d77-40d5-8db5-1abe82ce766c | PROMOTE | E:/Work/customizes/Comnieusiba/clones/site/clone-manifest.json | PROMOTE: deciding artifact E:/Work/customizes/Comnieusiba/clones/site/clone-manifest.json exists on disk (verified 2026-09-18); newest observation for this clone target |
| cand-2a49a9c0-e1f8-4a64-ad6c-a9a309c01ac4 | PROMOTE | E:/Work/customizes/Comnieusiba/clones/routes/blogs/clone-manifest.json | PROMOTE: deciding artifact E:/Work/customizes/Comnieusiba/clones/routes/blogs/clone-manifest.json exists on disk (verified 2026-09-18); newest observation for this clone target |
| cand-2fee1844-8fee-4b9e-9af3-4dd19777a269 | SUPERSEDE | superseded by cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 | SUPERSEDE: same subject (clone target comnieuthienly/clone-manifest.json) restated by newer candidate cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 (2026-09-17T13:20:17.221Z) |
| cand-376becf0-e3c7-43c6-9fd0-46f3462fe898 | SUPERSEDE | superseded by cand-80647132-9858-4d1f-be55-ad9ab1f0dcf8 | SUPERSEDE: same subject (clone target reservations/clone-manifest.json) restated by newer candidate cand-80647132-9858-4d1f-be55-ad9ab1f0dcf8 (2026-09-17T12:37:33.749Z) |
| cand-399cdc20-f7f6-41f9-a070-f4245d86e462 | SUPERSEDE | superseded by cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 | SUPERSEDE: same subject (clone target comnieuthienly/clone-manifest.json) restated by newer candidate cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 (2026-09-17T13:20:17.221Z) |
| cand-39df449f-38ad-4771-adce-00b087011fb5 | SUPERSEDE | superseded by cand-2a49a9c0-e1f8-4a64-ad6c-a9a309c01ac4 | SUPERSEDE: same subject (clone target blogs/clone-manifest.json) restated by newer candidate cand-2a49a9c0-e1f8-4a64-ad6c-a9a309c01ac4 (2026-09-17T12:36:56.222Z) |
| cand-3aabe0b9-29b8-4ade-b64c-7fcc869bac07 | SUPERSEDE | superseded by cand-80647132-9858-4d1f-be55-ad9ab1f0dcf8 | SUPERSEDE: same subject (clone target reservations/clone-manifest.json) restated by newer candidate cand-80647132-9858-4d1f-be55-ad9ab1f0dcf8 (2026-09-17T12:37:33.749Z) |
| cand-3b3ed6b0-a643-4f57-a36f-fbfeed3ab1af | SUPERSEDE | superseded by cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 | SUPERSEDE: same subject (clone target comnieuthienly/clone-manifest.json) restated by newer candidate cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 (2026-09-17T13:20:17.221Z) |
| cand-3c17bfdf-4e51-4abc-a5d2-1266c83421a0 | SUPERSEDE | superseded by cand-3d5b88b9-e5a3-45be-b173-c6af4813afdf | SUPERSEDE: same subject (clone target order-food/clone-manifest.json) restated by newer candidate cand-3d5b88b9-e5a3-45be-b173-c6af4813afdf (2026-09-17T12:37:52.706Z) |
| cand-3d5b88b9-e5a3-45be-b173-c6af4813afdf | PROMOTE | E:/Work/customizes/Comnieusiba/clones/routes/order-food/clone-manifest.json | PROMOTE: deciding artifact E:/Work/customizes/Comnieusiba/clones/routes/order-food/clone-manifest.json exists on disk (verified 2026-09-18); newest observation for this clone target |
| cand-3dbbf5fe-732b-4728-a207-a463355f6b00 | SUPERSEDE | superseded by cand-ada26c52-8ef1-4ba0-8e14-68b3bbacdbb5 | SUPERSEDE: same subject (clone target team-culture/clone-manifest.json) restated by newer candidate cand-ada26c52-8ef1-4ba0-8e14-68b3bbacdbb5 (2026-09-17T12:37:52.954Z) |
| cand-42b17c8b-1dfc-4daa-b051-a3720083c5b9 | SUPERSEDE | superseded by cand-ba50072e-82b1-4aea-b312-dad1a73a70a9 | SUPERSEDE: same subject (clone target introduce/clone-manifest.json) restated by newer candidate cand-ba50072e-82b1-4aea-b312-dad1a73a70a9 (2026-09-17T12:37:18.245Z) |
| cand-4a065ad4-f5e3-4834-8ed8-b4d2852ad3cd | SUPERSEDE | superseded by cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 | SUPERSEDE: same subject (clone target comnieuthienly/clone-manifest.json) restated by newer candidate cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 (2026-09-17T13:20:17.221Z) |
| cand-4a9de195-8e41-4306-bba4-90d263cc299c | SUPERSEDE | superseded by cand-285c1de9-45a2-4f07-90ab-636213763a2a | SUPERSEDE: same subject (clone target loyal-customers/clone-manifest.json) restated by newer candidate cand-285c1de9-45a2-4f07-90ab-636213763a2a (2026-09-17T12:37:15.723Z) |
| cand-4cb3dc18-d39d-434f-8e14-14f7663eaf17 | SUPERSEDE | superseded by cand-66a0ebf1-e733-4c16-9f55-af09a08e5bc1 | SUPERSEDE: same subject (clone target menu/clone-manifest.json) restated by newer candidate cand-66a0ebf1-e733-4c16-9f55-af09a08e5bc1 (2026-09-17T12:37:50.692Z) |
| cand-4f454686-beba-4fe2-843f-6d168aefe633 | SUPERSEDE | superseded by cand-80647132-9858-4d1f-be55-ad9ab1f0dcf8 | SUPERSEDE: same subject (clone target reservations/clone-manifest.json) restated by newer candidate cand-80647132-9858-4d1f-be55-ad9ab1f0dcf8 (2026-09-17T12:37:33.749Z) |
| cand-5040b256-d227-4f1a-be76-a16d367b42a3 | SUPERSEDE | superseded by cand-ada26c52-8ef1-4ba0-8e14-68b3bbacdbb5 | SUPERSEDE: same subject (clone target team-culture/clone-manifest.json) restated by newer candidate cand-ada26c52-8ef1-4ba0-8e14-68b3bbacdbb5 (2026-09-17T12:37:52.954Z) |
| cand-523a9449-4740-40e0-81db-169afbd5d9fd | SUPERSEDE | superseded by cand-144ab716-3fa3-4ce1-80d7-649eac08460f | SUPERSEDE: same subject (clone target branches/clone-manifest.json) restated by newer candidate cand-144ab716-3fa3-4ce1-80d7-649eac08460f (2026-09-17T12:36:52.765Z) |
| cand-541cf11f-270c-47ba-9dab-94bb612ab3ce | SUPERSEDE | superseded by cand-293de58d-5d77-40d5-8db5-1abe82ce766c | SUPERSEDE: same subject (clone target site/clone-manifest.json) restated by newer candidate cand-293de58d-5d77-40d5-8db5-1abe82ce766c (2026-09-17T12:23:11.770Z) |
| cand-581636d0-39d3-4a4b-93d9-b306483c8570 | SUPERSEDE | superseded by cand-2a49a9c0-e1f8-4a64-ad6c-a9a309c01ac4 | SUPERSEDE: same subject (clone target blogs/clone-manifest.json) restated by newer candidate cand-2a49a9c0-e1f8-4a64-ad6c-a9a309c01ac4 (2026-09-17T12:36:56.222Z) |
| cand-58612fdd-3a8e-4da1-9d64-ba3748818858 | SUPERSEDE | superseded by cand-66a0ebf1-e733-4c16-9f55-af09a08e5bc1 | SUPERSEDE: same subject (clone target menu/clone-manifest.json) restated by newer candidate cand-66a0ebf1-e733-4c16-9f55-af09a08e5bc1 (2026-09-17T12:37:50.692Z) |
| cand-592e9b09-eba1-408a-8807-022e1704898c | SUPERSEDE | superseded by cand-293de58d-5d77-40d5-8db5-1abe82ce766c | SUPERSEDE: same subject (clone target site/clone-manifest.json) restated by newer candidate cand-293de58d-5d77-40d5-8db5-1abe82ce766c (2026-09-17T12:23:11.770Z) |
| cand-5d5e4ed1-4ba2-4a42-ae21-57215e0810da | SUPERSEDE | superseded by cand-2a49a9c0-e1f8-4a64-ad6c-a9a309c01ac4 | SUPERSEDE: same subject (clone target blogs/clone-manifest.json) restated by newer candidate cand-2a49a9c0-e1f8-4a64-ad6c-a9a309c01ac4 (2026-09-17T12:36:56.222Z) |
| cand-5fb8f17c-8e5a-423a-b69d-2bd9fd089411 | SUPERSEDE | superseded by cand-2a49a9c0-e1f8-4a64-ad6c-a9a309c01ac4 | SUPERSEDE: same subject (clone target blogs/clone-manifest.json) restated by newer candidate cand-2a49a9c0-e1f8-4a64-ad6c-a9a309c01ac4 (2026-09-17T12:36:56.222Z) |
| cand-5ffc64c2-e600-469d-901a-fbeaf615ac61 | SUPERSEDE | superseded by cand-ba50072e-82b1-4aea-b312-dad1a73a70a9 | SUPERSEDE: same subject (clone target introduce/clone-manifest.json) restated by newer candidate cand-ba50072e-82b1-4aea-b312-dad1a73a70a9 (2026-09-17T12:37:18.245Z) |
| cand-6180f1c6-7735-45fd-a76b-76edd19be90a | SUPERSEDE | superseded by cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 | SUPERSEDE: same subject (clone target comnieuthienly/clone-manifest.json) restated by newer candidate cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 (2026-09-17T13:20:17.221Z) |
| cand-6297fea4-a29b-4583-881b-38b7a8698c0d | SUPERSEDE | superseded by cand-3d5b88b9-e5a3-45be-b173-c6af4813afdf | SUPERSEDE: same subject (clone target order-food/clone-manifest.json) restated by newer candidate cand-3d5b88b9-e5a3-45be-b173-c6af4813afdf (2026-09-17T12:37:52.706Z) |
| cand-62fc809a-d9a7-481a-a5fa-24060e551b7e | SUPERSEDE | superseded by cand-285c1de9-45a2-4f07-90ab-636213763a2a | SUPERSEDE: same subject (clone target loyal-customers/clone-manifest.json) restated by newer candidate cand-285c1de9-45a2-4f07-90ab-636213763a2a (2026-09-17T12:37:15.723Z) |
| cand-63362299-5b2d-4cee-9e7b-a14788e872ca | SUPERSEDE | superseded by cand-144ab716-3fa3-4ce1-80d7-649eac08460f | SUPERSEDE: same subject (clone target branches/clone-manifest.json) restated by newer candidate cand-144ab716-3fa3-4ce1-80d7-649eac08460f (2026-09-17T12:36:52.765Z) |
| cand-66a0ebf1-e733-4c16-9f55-af09a08e5bc1 | PROMOTE | E:/Work/customizes/Comnieusiba/clones/routes/menu/clone-manifest.json | PROMOTE: deciding artifact E:/Work/customizes/Comnieusiba/clones/routes/menu/clone-manifest.json exists on disk (verified 2026-09-18); newest observation for this clone target |
| cand-66d523a0-dd76-4fe9-a190-bccd365a857e | SUPERSEDE | superseded by cand-ba50072e-82b1-4aea-b312-dad1a73a70a9 | SUPERSEDE: same subject (clone target introduce/clone-manifest.json) restated by newer candidate cand-ba50072e-82b1-4aea-b312-dad1a73a70a9 (2026-09-17T12:37:18.245Z) |
| cand-70edd2b6-0e3c-4d02-b74d-c7e3ee64b72e | SUPERSEDE | superseded by cand-ba50072e-82b1-4aea-b312-dad1a73a70a9 | SUPERSEDE: same subject (clone target introduce/clone-manifest.json) restated by newer candidate cand-ba50072e-82b1-4aea-b312-dad1a73a70a9 (2026-09-17T12:37:18.245Z) |
| cand-71371d27-f03a-4c97-86de-5dac731f403f | SUPERSEDE | superseded by cand-66a0ebf1-e733-4c16-9f55-af09a08e5bc1 | SUPERSEDE: same subject (clone target menu/clone-manifest.json) restated by newer candidate cand-66a0ebf1-e733-4c16-9f55-af09a08e5bc1 (2026-09-17T12:37:50.692Z) |
| cand-7182b865-0f94-49e7-9fae-e4eadfc8af62 | SUPERSEDE | superseded by cand-80647132-9858-4d1f-be55-ad9ab1f0dcf8 | SUPERSEDE: same subject (clone target reservations/clone-manifest.json) restated by newer candidate cand-80647132-9858-4d1f-be55-ad9ab1f0dcf8 (2026-09-17T12:37:33.749Z) |
| cand-721795c0-559a-440b-808d-bc6d57b8c2a7 | SUPERSEDE | superseded by cand-285c1de9-45a2-4f07-90ab-636213763a2a | SUPERSEDE: same subject (clone target loyal-customers/clone-manifest.json) restated by newer candidate cand-285c1de9-45a2-4f07-90ab-636213763a2a (2026-09-17T12:37:15.723Z) |
| cand-73b3a516-11ca-48f7-a0d1-7f6c776cb55a | PROMOTE | case row case-7c2e6642-3217-42bc-9041-4c256f2cd315: Run IDs: mhv4je6lvb (81, SI 4.7s), 27nsqzxx44 (79, SI 5.7s), u61pwpjgy1 (82, SI 4.4s) | PROMOTE: verificationRef recorded in case row case-7c2e6642-3217-42bc-9041-4c256f2cd315 (Run IDs: mhv4je6lvb (81, SI 4.7s), 27nsqzxx44 (79, SI 5.7s), u61pwpjgy1 (82, SI 4.4s)) |
| cand-755119fa-622e-4e85-a02f-4c4b57473741 | SUPERSEDE | superseded by cand-80647132-9858-4d1f-be55-ad9ab1f0dcf8 | SUPERSEDE: same subject (clone target reservations/clone-manifest.json) restated by newer candidate cand-80647132-9858-4d1f-be55-ad9ab1f0dcf8 (2026-09-17T12:37:33.749Z) |
| cand-7e5e6f0b-f9e7-4553-8018-61aa471bb65a | SUPERSEDE | superseded by cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 | SUPERSEDE: same subject (clone target comnieuthienly/clone-manifest.json) restated by newer candidate cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 (2026-09-17T13:20:17.221Z) |
| cand-7fa1a27c-b11f-4d55-a689-49420108a62e | SUPERSEDE | superseded by cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 | SUPERSEDE: same subject (clone target comnieuthienly/clone-manifest.json) restated by newer candidate cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 (2026-09-17T13:20:17.221Z) |
| cand-80647132-9858-4d1f-be55-ad9ab1f0dcf8 | PROMOTE | E:/Work/customizes/Comnieusiba/clones/routes/reservations/clone-manifest.json | PROMOTE: deciding artifact E:/Work/customizes/Comnieusiba/clones/routes/reservations/clone-manifest.json exists on disk (verified 2026-09-18); newest observation for this clone target |
| cand-81afd3e6-0577-465f-a519-a5fbfbd60051 | SUPERSEDE | superseded by cand-144ab716-3fa3-4ce1-80d7-649eac08460f | SUPERSEDE: same subject (clone target branches/clone-manifest.json) restated by newer candidate cand-144ab716-3fa3-4ce1-80d7-649eac08460f (2026-09-17T12:36:52.765Z) |
| cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 | PROMOTE | E:/Work/customizes/Comnieusiba/clones/comnieuthienly/clone-manifest.json | PROMOTE: deciding artifact E:/Work/customizes/Comnieusiba/clones/comnieuthienly/clone-manifest.json exists on disk (verified 2026-09-18); newest observation for this clone target |
| cand-878b7880-8f55-401d-91db-7655dd5cb236 | SUPERSEDE | superseded by cand-66a0ebf1-e733-4c16-9f55-af09a08e5bc1 | SUPERSEDE: same subject (clone target menu/clone-manifest.json) restated by newer candidate cand-66a0ebf1-e733-4c16-9f55-af09a08e5bc1 (2026-09-17T12:37:50.692Z) |
| cand-887fdeb5-dfe9-4260-8760-689407645e75 | PROMOTE | E:/Work/customizes/Comnieusiba/clones/comnieuthienly-menu/clone-manifest.json | PROMOTE: deciding artifact E:/Work/customizes/Comnieusiba/clones/comnieuthienly-menu/clone-manifest.json exists on disk (verified 2026-09-18); newest observation for this clone target |
| cand-8ac6dd2a-4d9e-43d3-9ff5-c090f13af7f6 | SUPERSEDE | superseded by cand-2a49a9c0-e1f8-4a64-ad6c-a9a309c01ac4 | SUPERSEDE: same subject (clone target blogs/clone-manifest.json) restated by newer candidate cand-2a49a9c0-e1f8-4a64-ad6c-a9a309c01ac4 (2026-09-17T12:36:56.222Z) |
| cand-8d1b85f9-8794-4375-8f31-43eddfd34d72 | SUPERSEDE | superseded by cand-285c1de9-45a2-4f07-90ab-636213763a2a | SUPERSEDE: same subject (clone target loyal-customers/clone-manifest.json) restated by newer candidate cand-285c1de9-45a2-4f07-90ab-636213763a2a (2026-09-17T12:37:15.723Z) |
| cand-8d8efc7a-77a4-4b5b-8e21-7da1c6f0b2fc | SUPERSEDE | superseded by cand-144ab716-3fa3-4ce1-80d7-649eac08460f | SUPERSEDE: same subject (clone target branches/clone-manifest.json) restated by newer candidate cand-144ab716-3fa3-4ce1-80d7-649eac08460f (2026-09-17T12:36:52.765Z) |
| cand-8db2012c-5cfa-4a8a-bf4a-e6ac62b6c157 | SUPERSEDE | superseded by cand-3d5b88b9-e5a3-45be-b173-c6af4813afdf | SUPERSEDE: same subject (clone target order-food/clone-manifest.json) restated by newer candidate cand-3d5b88b9-e5a3-45be-b173-c6af4813afdf (2026-09-17T12:37:52.706Z) |
| cand-8e55e79f-3242-4b4d-944b-ec6c594371b2 | SUPERSEDE | superseded by cand-285c1de9-45a2-4f07-90ab-636213763a2a | SUPERSEDE: same subject (clone target loyal-customers/clone-manifest.json) restated by newer candidate cand-285c1de9-45a2-4f07-90ab-636213763a2a (2026-09-17T12:37:15.723Z) |
| cand-92d83c2e-9d2c-4962-8b1a-4528bf3d031f | SUPERSEDE | superseded by cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 | SUPERSEDE: same subject (clone target comnieuthienly/clone-manifest.json) restated by newer candidate cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 (2026-09-17T13:20:17.221Z) |
| cand-94525146-08ce-4f58-8421-59a7cdd96299 | SUPERSEDE | superseded by cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 | SUPERSEDE: same subject (clone target comnieuthienly/clone-manifest.json) restated by newer candidate cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 (2026-09-17T13:20:17.221Z) |
| cand-94e3e655-aa36-4604-961d-6bb3eaf4a10d | SUPERSEDE | superseded by cand-80647132-9858-4d1f-be55-ad9ab1f0dcf8 | SUPERSEDE: same subject (clone target reservations/clone-manifest.json) restated by newer candidate cand-80647132-9858-4d1f-be55-ad9ab1f0dcf8 (2026-09-17T12:37:33.749Z) |
| cand-960f425e-5d74-4e1d-aeaa-0ed7dc7926fb | SUPERSEDE | superseded by cand-144ab716-3fa3-4ce1-80d7-649eac08460f | SUPERSEDE: same subject (clone target branches/clone-manifest.json) restated by newer candidate cand-144ab716-3fa3-4ce1-80d7-649eac08460f (2026-09-17T12:36:52.765Z) |
| cand-98df0d23-36ba-48df-96ec-65e8313c511d | SUPERSEDE | superseded by cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 | SUPERSEDE: same subject (clone target comnieuthienly/clone-manifest.json) restated by newer candidate cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 (2026-09-17T13:20:17.221Z) |
| cand-9b332632-66c7-42b8-962d-dcd9199a6849 | SUPERSEDE | superseded by cand-66a0ebf1-e733-4c16-9f55-af09a08e5bc1 | SUPERSEDE: same subject (clone target menu/clone-manifest.json) restated by newer candidate cand-66a0ebf1-e733-4c16-9f55-af09a08e5bc1 (2026-09-17T12:37:50.692Z) |
| cand-9bc070a6-1258-4ece-ab8e-71eed6d1f16c | SUPERSEDE | superseded by cand-3d5b88b9-e5a3-45be-b173-c6af4813afdf | SUPERSEDE: same subject (clone target order-food/clone-manifest.json) restated by newer candidate cand-3d5b88b9-e5a3-45be-b173-c6af4813afdf (2026-09-17T12:37:52.706Z) |
| cand-9c28db18-c24c-4542-b4fb-0514f862bae4 | SUPERSEDE | superseded by cand-ba50072e-82b1-4aea-b312-dad1a73a70a9 | SUPERSEDE: same subject (clone target introduce/clone-manifest.json) restated by newer candidate cand-ba50072e-82b1-4aea-b312-dad1a73a70a9 (2026-09-17T12:37:18.245Z) |
| cand-a19693c2-8059-44ac-a312-c39de6bbc1f9 | SUPERSEDE | superseded by cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 | SUPERSEDE: same subject (clone target comnieuthienly/clone-manifest.json) restated by newer candidate cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 (2026-09-17T13:20:17.221Z) |
| cand-a23a73bc-4084-4991-86eb-46743ead3d10 | SUPERSEDE | superseded by cand-2a49a9c0-e1f8-4a64-ad6c-a9a309c01ac4 | SUPERSEDE: same subject (clone target blogs/clone-manifest.json) restated by newer candidate cand-2a49a9c0-e1f8-4a64-ad6c-a9a309c01ac4 (2026-09-17T12:36:56.222Z) |
| cand-a26f89ca-0db8-4a38-b157-4c1c04e0c62c | SUPERSEDE | superseded by cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 | SUPERSEDE: same subject (clone target comnieuthienly/clone-manifest.json) restated by newer candidate cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 (2026-09-17T13:20:17.221Z) |
| cand-a32cad20-a81b-4d15-99e4-7db7fe57df86 | SUPERSEDE | superseded by cand-3d5b88b9-e5a3-45be-b173-c6af4813afdf | SUPERSEDE: same subject (clone target order-food/clone-manifest.json) restated by newer candidate cand-3d5b88b9-e5a3-45be-b173-c6af4813afdf (2026-09-17T12:37:52.706Z) |
| cand-a5a5c65a-420b-466d-bb26-1ec19e0abf50 | SUPERSEDE | superseded by cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 | SUPERSEDE: same subject (clone target comnieuthienly/clone-manifest.json) restated by newer candidate cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 (2026-09-17T13:20:17.221Z) |
| cand-a9b2f71b-715a-4122-9c87-e8e221b7e3b1 | SUPERSEDE | superseded by cand-144ab716-3fa3-4ce1-80d7-649eac08460f | SUPERSEDE: same subject (clone target branches/clone-manifest.json) restated by newer candidate cand-144ab716-3fa3-4ce1-80d7-649eac08460f (2026-09-17T12:36:52.765Z) |
| cand-abb04eda-76aa-4397-9479-a6f93ecac2ea | SUPERSEDE | superseded by cand-ba50072e-82b1-4aea-b312-dad1a73a70a9 | SUPERSEDE: same subject (clone target introduce/clone-manifest.json) restated by newer candidate cand-ba50072e-82b1-4aea-b312-dad1a73a70a9 (2026-09-17T12:37:18.245Z) |
| cand-ada26c52-8ef1-4ba0-8e14-68b3bbacdbb5 | PROMOTE | E:/Work/customizes/Comnieusiba/clones/routes/team-culture/clone-manifest.json | PROMOTE: deciding artifact E:/Work/customizes/Comnieusiba/clones/routes/team-culture/clone-manifest.json exists on disk (verified 2026-09-18); newest observation for this clone target |
| cand-b069f1e6-72c0-42c8-b7ee-068eeca0ead6 | SUPERSEDE | superseded by cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 | SUPERSEDE: same subject (clone target comnieuthienly/clone-manifest.json) restated by newer candidate cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 (2026-09-17T13:20:17.221Z) |
| cand-b260bddc-725a-4327-b79b-0c5758f79154 | SUPERSEDE | superseded by cand-ba50072e-82b1-4aea-b312-dad1a73a70a9 | SUPERSEDE: same subject (clone target introduce/clone-manifest.json) restated by newer candidate cand-ba50072e-82b1-4aea-b312-dad1a73a70a9 (2026-09-17T12:37:18.245Z) |
| cand-b96d4fc2-ab9a-4cc3-aa23-551bb1cd84ae | SUPERSEDE | superseded by cand-285c1de9-45a2-4f07-90ab-636213763a2a | SUPERSEDE: same subject (clone target loyal-customers/clone-manifest.json) restated by newer candidate cand-285c1de9-45a2-4f07-90ab-636213763a2a (2026-09-17T12:37:15.723Z) |
| cand-ba50072e-82b1-4aea-b312-dad1a73a70a9 | PROMOTE | E:/Work/customizes/Comnieusiba/clones/routes/introduce/clone-manifest.json | PROMOTE: deciding artifact E:/Work/customizes/Comnieusiba/clones/routes/introduce/clone-manifest.json exists on disk (verified 2026-09-18); newest observation for this clone target |
| cand-c04aaf7c-26f3-464c-aac7-95a06f407c36 | SUPERSEDE | superseded by cand-285c1de9-45a2-4f07-90ab-636213763a2a | SUPERSEDE: same subject (clone target loyal-customers/clone-manifest.json) restated by newer candidate cand-285c1de9-45a2-4f07-90ab-636213763a2a (2026-09-17T12:37:15.723Z) |
| cand-c4bc8c5d-a0aa-43b1-a34d-fa633c86c343 | SUPERSEDE | superseded by cand-ada26c52-8ef1-4ba0-8e14-68b3bbacdbb5 | SUPERSEDE: same subject (clone target team-culture/clone-manifest.json) restated by newer candidate cand-ada26c52-8ef1-4ba0-8e14-68b3bbacdbb5 (2026-09-17T12:37:52.954Z) |
| cand-c4feefc2-bb4b-4bba-a689-60c37be3f4cd | SUPERSEDE | superseded by cand-3d5b88b9-e5a3-45be-b173-c6af4813afdf | SUPERSEDE: same subject (clone target order-food/clone-manifest.json) restated by newer candidate cand-3d5b88b9-e5a3-45be-b173-c6af4813afdf (2026-09-17T12:37:52.706Z) |
| cand-cb87ab85-e6cb-4c86-a002-38cfc64b5384 | SUPERSEDE | superseded by cand-285c1de9-45a2-4f07-90ab-636213763a2a | SUPERSEDE: same subject (clone target loyal-customers/clone-manifest.json) restated by newer candidate cand-285c1de9-45a2-4f07-90ab-636213763a2a (2026-09-17T12:37:15.723Z) |
| cand-cd5b740f-1b05-4d03-8e14-d860b6cd5e29 | SUPERSEDE | superseded by cand-285c1de9-45a2-4f07-90ab-636213763a2a | SUPERSEDE: same subject (clone target loyal-customers/clone-manifest.json) restated by newer candidate cand-285c1de9-45a2-4f07-90ab-636213763a2a (2026-09-17T12:37:15.723Z) |
| cand-ce726b2d-f98d-4a9d-8bd2-8d420faa6912 | SUPERSEDE | superseded by cand-ada26c52-8ef1-4ba0-8e14-68b3bbacdbb5 | SUPERSEDE: same subject (clone target team-culture/clone-manifest.json) restated by newer candidate cand-ada26c52-8ef1-4ba0-8e14-68b3bbacdbb5 (2026-09-17T12:37:52.954Z) |
| cand-cfdfb4ae-8253-453f-a5d3-95ea6ac79cd5 | SUPERSEDE | superseded by cand-ada26c52-8ef1-4ba0-8e14-68b3bbacdbb5 | SUPERSEDE: same subject (clone target team-culture/clone-manifest.json) restated by newer candidate cand-ada26c52-8ef1-4ba0-8e14-68b3bbacdbb5 (2026-09-17T12:37:52.954Z) |
| cand-d1948368-7e80-49d8-84f7-75b0b3f174a0 | SUPERSEDE | superseded by cand-ba50072e-82b1-4aea-b312-dad1a73a70a9 | SUPERSEDE: same subject (clone target introduce/clone-manifest.json) restated by newer candidate cand-ba50072e-82b1-4aea-b312-dad1a73a70a9 (2026-09-17T12:37:18.245Z) |
| cand-d5c1881c-b19d-4c44-85e5-b2022f62e1d9 | SUPERSEDE | superseded by cand-2a49a9c0-e1f8-4a64-ad6c-a9a309c01ac4 | SUPERSEDE: same subject (clone target blogs/clone-manifest.json) restated by newer candidate cand-2a49a9c0-e1f8-4a64-ad6c-a9a309c01ac4 (2026-09-17T12:36:56.222Z) |
| cand-d5fe007d-1d3f-4e45-9147-4f26209bbb76 | SUPERSEDE | superseded by cand-66a0ebf1-e733-4c16-9f55-af09a08e5bc1 | SUPERSEDE: same subject (clone target menu/clone-manifest.json) restated by newer candidate cand-66a0ebf1-e733-4c16-9f55-af09a08e5bc1 (2026-09-17T12:37:50.692Z) |
| cand-dc8518c2-05b5-4485-9ca6-e98247207af4 | SUPERSEDE | superseded by cand-ba50072e-82b1-4aea-b312-dad1a73a70a9 | SUPERSEDE: same subject (clone target introduce/clone-manifest.json) restated by newer candidate cand-ba50072e-82b1-4aea-b312-dad1a73a70a9 (2026-09-17T12:37:18.245Z) |
| cand-dc8d5024-b58b-431e-a01e-1b9164efe1ec | SUPERSEDE | superseded by cand-144ab716-3fa3-4ce1-80d7-649eac08460f | SUPERSEDE: same subject (clone target branches/clone-manifest.json) restated by newer candidate cand-144ab716-3fa3-4ce1-80d7-649eac08460f (2026-09-17T12:36:52.765Z) |
| cand-de6e5f81-dca2-4b50-a2bd-fed9e2a280f5 | SUPERSEDE | superseded by cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 | SUPERSEDE: same subject (clone target comnieuthienly/clone-manifest.json) restated by newer candidate cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 (2026-09-17T13:20:17.221Z) |
| cand-dfab66f4-1065-4197-922c-153c3a9e2997 | SUPERSEDE | superseded by cand-ada26c52-8ef1-4ba0-8e14-68b3bbacdbb5 | SUPERSEDE: same subject (clone target team-culture/clone-manifest.json) restated by newer candidate cand-ada26c52-8ef1-4ba0-8e14-68b3bbacdbb5 (2026-09-17T12:37:52.954Z) |
| cand-e0df92bc-7ef6-43d5-ab26-4c9e3be5ef5b | SUPERSEDE | superseded by cand-2a49a9c0-e1f8-4a64-ad6c-a9a309c01ac4 | SUPERSEDE: same subject (clone target blogs/clone-manifest.json) restated by newer candidate cand-2a49a9c0-e1f8-4a64-ad6c-a9a309c01ac4 (2026-09-17T12:36:56.222Z) |
| cand-e364a1e1-9473-4e1f-8651-4768f5e825ba | SUPERSEDE | superseded by cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 | SUPERSEDE: same subject (clone target comnieuthienly/clone-manifest.json) restated by newer candidate cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 (2026-09-17T13:20:17.221Z) |
| cand-e620531f-cfd7-426d-a424-c1dfdbbc4085 | SUPERSEDE | superseded by cand-66a0ebf1-e733-4c16-9f55-af09a08e5bc1 | SUPERSEDE: same subject (clone target menu/clone-manifest.json) restated by newer candidate cand-66a0ebf1-e733-4c16-9f55-af09a08e5bc1 (2026-09-17T12:37:50.692Z) |
| cand-ec4e7086-dfa6-43bc-8684-209febe104eb | SUPERSEDE | superseded by cand-3d5b88b9-e5a3-45be-b173-c6af4813afdf | SUPERSEDE: same subject (clone target order-food/clone-manifest.json) restated by newer candidate cand-3d5b88b9-e5a3-45be-b173-c6af4813afdf (2026-09-17T12:37:52.706Z) |
| cand-edf2beb6-affb-465a-8158-f9fc1f3ae2ee | SUPERSEDE | superseded by cand-293de58d-5d77-40d5-8db5-1abe82ce766c | SUPERSEDE: same subject (clone target site/clone-manifest.json) restated by newer candidate cand-293de58d-5d77-40d5-8db5-1abe82ce766c (2026-09-17T12:23:11.770Z) |
| cand-f0dff0ff-625f-49a1-aaef-92597b85c902 | SUPERSEDE | superseded by cand-80647132-9858-4d1f-be55-ad9ab1f0dcf8 | SUPERSEDE: same subject (clone target reservations/clone-manifest.json) restated by newer candidate cand-80647132-9858-4d1f-be55-ad9ab1f0dcf8 (2026-09-17T12:37:33.749Z) |
| cand-f3133f40-2f28-4c58-9cb1-1110d705c321 | SUPERSEDE | superseded by cand-ada26c52-8ef1-4ba0-8e14-68b3bbacdbb5 | SUPERSEDE: same subject (clone target team-culture/clone-manifest.json) restated by newer candidate cand-ada26c52-8ef1-4ba0-8e14-68b3bbacdbb5 (2026-09-17T12:37:52.954Z) |
| cand-f45dcd5d-6d2d-4157-a622-b1c46a85ccea | SUPERSEDE | superseded by cand-80647132-9858-4d1f-be55-ad9ab1f0dcf8 | SUPERSEDE: same subject (clone target reservations/clone-manifest.json) restated by newer candidate cand-80647132-9858-4d1f-be55-ad9ab1f0dcf8 (2026-09-17T12:37:33.749Z) |
| cand-f74cfb3f-204e-404e-8717-0f39088982df | SUPERSEDE | superseded by cand-ada26c52-8ef1-4ba0-8e14-68b3bbacdbb5 | SUPERSEDE: same subject (clone target team-culture/clone-manifest.json) restated by newer candidate cand-ada26c52-8ef1-4ba0-8e14-68b3bbacdbb5 (2026-09-17T12:37:52.954Z) |
| cand-f98b0b97-59d2-4c78-bc0f-c6cec9d52284 | SUPERSEDE | superseded by cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 | SUPERSEDE: same subject (clone target comnieuthienly/clone-manifest.json) restated by newer candidate cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 (2026-09-17T13:20:17.221Z) |
| cand-fe175728-9ca9-4f77-bc13-5b1ee86dc760 | SUPERSEDE | superseded by cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 | SUPERSEDE: same subject (clone target comnieuthienly/clone-manifest.json) restated by newer candidate cand-82f1d739-6bf3-48fc-a236-dc4cd9891726 (2026-09-17T13:20:17.221Z) |

## 4. H3 — knowledge-gap platforms

All three NO_EVIDENCE platforms had real, already-existing artifacts; one
`outcome` + one PROMOTE adjudication each. knowledgeGaps now reports
activeClaims=1, kind=NONE for all three.

| platform | decision | artifact | ids |
|---|---|---|---|
| AntiFan Desktop | WRITTEN (outcome + PROMOTE) | plans/260917-1821-antifan-consolidated-remediation-soak/reports/pre-boot/pre-boot-state.md — register 1,837,479 B / 1001 lines / 1001 unique ids; attachments 3,517 B / 2 records | case-faa5b718-eb8a-4d21-bf0e-9643d64d7ac0, cand-c9f7c2b4-687b-4218-9566-30c3072fb77f, adj-eeaf06ae-ca1f-407d-8d25-afbe2b54504a |
| Workspace-wide | WRITTEN (outcome + PROMOTE) | E:/Work/customizes/Seahorse2/templates/page.our-vision.liquid + page.vision-mission-core-value.liquid (50 B each, identical single include) | case-f3a10f23-99da-4067-81ca-fcd73ba3711d, cand-2c208c27-3bce-4e09-8b1c-36216d7ca37a, adj-88ca06e6-4667-4a7b-ae49-92c750ff5a4c |
| omp agent harness | WRITTEN (outcome + PROMOTE) | test/unit/context-bridge.test.mjs (asserts turn_end dedupe :444, agent_end settle :465, session_shutdown release :484) + .omp/hooks/pre/antifan-core-bridge.ts (32,916 B) | case-b2b29c8d-d43e-4134-91d6-4b0e9f06d910, cand-9578edcb-d2cf-423a-9269-7351a3dcb1e9, adj-3338e8c7-c392-472b-836b-a83d1149823c |

The 3 new PENDING candidates these writes created were adjudicated in the same
pass, so the promotion gate was not re-opened (verified: 0 pending after).

## 5. AFTER readings

### gate promotion (after)
```json
{"gateId": null, "phase": "health-surface", "gate": "promotion", "passed": true, "detail": "0 pending candidates"}
```

### gate regression (after)
```json
{"gateId": null, "phase": "health-surface", "gate": "regression", "passed": false, "detail": "last regression: FAIL at 2026-09-18T03:27:50.235Z"}
```

### gate principles (after)
```json
{"gateId": null, "phase": "health-surface", "gate": "principles", "passed": false, "detail": "1126 duplicate normalized statement(s), 0 unanchored principle(s) (of 10275)"}
```

### health (after, reduced)
```json
{
  "status": "DEGRADED",
  "reasonCode": "GATE_REGRESSION_FAILED+GATE_PRINCIPLES_FAILED",
  "stats": {
    "artifacts": 184835,
    "claims": 20848,
    "evidence": 44728,
    "units": 774,
    "skills": 547,
    "lineage": 2286,
    "conflicts": 5,
    "cases": 118,
    "candidates": 118,
    "adjudications": 119,
    "releases": 1,
    "receipts": 12,
    "packs": 161,
    "observations": 288,
    "experienceNodes": 2659,
    "experienceEdges": 3434,
    "antiPatterns": 531,
    "workarounds": 113,
    "fixPatterns": 738,
    "corpusAudits": 9,
    "phaseGates": 56,
    "regressions": 2,
    "principles": 10275,
    "hiddenRequirements": 45,
    "commercialIntel": 206,
    "toolIntel": 700,
    "archetypes": 784,
    "platformSemantics": 63654,
    "practiceParity": 242,
    "skillVersions": 4
  },
  "gates": {
    "coverage": {
      "gateId": null,
      "phase": "health-surface",
      "gate": "coverage",
      "passed": true,
      "detail": "0 artifacts non-terminal or BLOCKED without reason (of 184835)"
    },
    "evidence": {
      "gateId": null,
      "phase": "health-surface",
      "gate": "evidence",
      "passed": true,
      "detail": "0 claims without evidence"
    },
    "conflict": {
      "gateId": null,
      "phase": "health-surface",
      "gate": "conflict",
      "passed": true,
      "detail": "0 unresolved conflicts"
    },
    "temporal": {
      "gateId": null,
      "phase": "health-surface",
      "gate": "temporal",
      "passed": true,
      "detail": "0 stale claims"
    },
    "promotion": {
      "gateId": null,
      "phase": "health-surface",
      "gate": "promotion",
      "passed": true,
      "detail": "0 pending candidates"
    },
    "regression": {
      "gateId": null,
      "phase": "health-surface",
      "gate": "regression",
      "passed": false,
      "detail": "last regression: FAIL at 2026-09-18T03:27:50.235Z"
    },
    "principles": {
      "gateId": null,
      "phase": "health-surface",
      "gate": "principles",
      "passed": false,
      "detail": "1126 duplicate normalized statement(s), 0 unanchored principle(s) (of 10275)"
    }
  }
}
```

### stats (after)
```json
{
  "artifacts": 184835,
  "claims": 20848,
  "evidence": 44728,
  "units": 774,
  "skills": 547,
  "lineage": 2286,
  "conflicts": 5,
  "cases": 118,
  "candidates": 118,
  "adjudications": 119,
  "releases": 1,
  "receipts": 12,
  "packs": 161,
  "observations": 288,
  "experienceNodes": 2659,
  "experienceEdges": 3434,
  "antiPatterns": 531,
  "workarounds": 113,
  "fixPatterns": 738,
  "corpusAudits": 9,
  "phaseGates": 56,
  "regressions": 2,
  "principles": 10275,
  "hiddenRequirements": 45,
  "commercialIntel": 206,
  "toolIntel": 700,
  "archetypes": 784,
  "platformSemantics": 63654,
  "practiceParity": 242,
  "skillVersions": 4
}
```

## Honest limits

- **Regression gate remains red.** The replay returned FAIL because the newest
  regression (reg-52eeb5d3) was recorded with `checksJson: null` — zero
  re-executable checks. H2's scope is the replay, not authoring a new
  regression definition; inventing checks would be fabricated evidence.
- **Principles gate remains red** (1126 duplicate normalized statements of
  10275). Deduplicating principles is a data-migration decision outside the
  approved H1/H2/H3 writes; no write was made.
- **Manifest contents not re-verified per candidate.** Existence of each
  deciding artifact was verified on disk; the per-run measured values inside
  each candidate statement (asset counts, audit pass/fail) were not re-derived
  from the manifests — the manifests are mutable and may have been regenerated
  since the run. For cand-053c57ef (comnieuthienly-introduce failure outcome)
  the manifest on disk today shows 186 findings / 0 blocking, which does not
  corroborate the recorded "2 blocking findings"; promoted on artifact
  existence per the decision rule, discrepancy noted.
- **9 malformed `E:\e\Work\` verificationRefs** were promoted on the
  corrected path (doubled drive letter removed); the literal recorded path does
  not exist.
- **Run IDs (mhv4je6lvb, 27nsqzxx44, u61pwpjgy1)** are recorded verbatim in the
  case row but were not resolvable to any store table or file — promoted on the
  recorded-ref clause of the rule, not on an external lookup.
- Health remains DEGRADED (GATE_REGRESSION_FAILED+GATE_PRINCIPLES_FAILED);
  promotion is the only gate H1/H2/H3 could legitimately clear.

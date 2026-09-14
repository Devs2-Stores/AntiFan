# Acceptance Matrix — C1–C8 (frozen before evaluation)

| Contract | Acceptance signal | Threshold (frozen) | Evidence artifact |
|---|---|---|---|
| C1 complete corpus | reconciled ledger | D=E+X+R+G exact; frontier EMPTY; 0 unknown regions; every eligible unit imported | reports/completion-ledger.json, core-coverage.json |
| C2 local-first identity/provenance | restart+idempotency+trace | close/reopen preserves counts; re-import adds 0 duplicates; every claim resolves to entryId+revision+anchor | test: restart.test, idempotent.test |
| C3 platform/temporal/conflict | no leakage, visible conflicts | wrong-platform query returns 0; conflict rows keep UNRESOLVED state; no majority promotion | test: platform.test, conflict.test |
| C4 experience/domain intelligence | real queries or explicit gaps | every P1 domain view returns rows or INSUFFICIENT_EVIDENCE; no stub | test: domains.test |
| C5 retrieval/context/receipt | baseline + abstention | FTS5 top-10 hit for known term; no-match abstains; Context Pack carries permission scope; Receipt binds revisions | test: retrieval.test, receipt.test |
| C6 AntiFan/OMP integration | real task interaction | `core.*` MCP tools callable; `antifan core` CLI works; unrelated project isolated; no permission escalation | test: integration.test (isolated workspace) |
| C7 verified learning/recovery | no self-promotion; restore proof | outcome→case→candidate PENDING; adjudication needs authority; rollback restores release; revocation removes access | test: learning.test, recovery.test |
| C8 regression + e2e | all receipts pass | full import regression green; restart/restore pass; docs complete | reports/goal-acceptance.md |

Thresholds are frozen here before any evaluation output is seen. They are not lowered to pass.

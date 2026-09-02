---
phase: 4
title: "Runtime Security & Isolation Assertion Probes"
status: pending
priority: P0
effort: "45m"
dependencies: [3]
---

# Phase 4: Runtime Security & Isolation Assertion Probes

## 1. Overview
To promote `CODE-INSPECTED` invariants to `OBSERVED: PASS` without relying solely on static code inspection and typechecking, this phase executes concrete runtime assertion probes covering the 4 critical security & durability boundaries:
1. **NTFS Reparse Point & Device Name Guard:** Probe traversal attempts with Windows reserved names (`CON`, `PRN`, `NUL`) and junction escapes.
2. **Invocation Ledger Bit-Rot & Quarantine:** Probe corrupted JSONL record detection and `.quarantine-ts` isolation.
3. **Process Tree Teardown:** Probe clean process termination without leaking child processes.
4. **Context Isolation:** Probe that untrusted web content in renderer has zero access to Electron `ipcRenderer` or Node.js primitives.

## 2. Requirements
- Execute existing unit/integration test suites for:
  - `test/main/security-policy.test.ts`
  - `test/main/semantic-ref-contract-characterization.test.ts`
  - `test/main/capability-catalogue.test.ts`
- Verify that every probe assertion passes with live runtime telemetry.

## 3. Architecture & Probe Matrix
```text
Live Runtime Probes
  ├─ Probe 1: Path & Reparse Guard ──► Rejects traversal & reserved device names
  ├─ Probe 2: Ledger Durability    ──► Quarantines corrupted checksum lines fail-closed
  ├─ Probe 3: Terminal Teardown    ──► Verifies taskkill /T /F process tree elimination
  └─ Probe 4: Context Isolation    ──► Confirms window.__antifan is unprivileged
```

## 4. Related Code Files
- Inspect/Execute: `test/main/security-policy.test.ts`
- Inspect/Execute: `test/main/capability-catalogue.test.ts`
- Inspect/Execute: `test/main/semantic-ref-registry.test.ts`
- Inspect/Execute: `test/unit/safe-slice.test.ts`

## 5. Implementation Steps
1. Run `node --test .compiled/test/main/security-policy.test.js`.
2. Run `node --test .compiled/test/main/capability-catalogue.test.js`.
3. Run `node --test .compiled/test/main/semantic-ref-registry.test.js`.
4. Run `node --test .compiled/test/unit/**/*.test.js`.
5. Record telemetry outputs and promote corresponding gates to `OBSERVED: PASS`.

## 6. Success Criteria & Verification
- [ ] All security and ledger probe tests pass with 100% green status.
- [ ] P0.2, P0.3, P0.4, P0.5, P0.6, P0.7 promoted to `OBSERVED: PASS` with live test traces.

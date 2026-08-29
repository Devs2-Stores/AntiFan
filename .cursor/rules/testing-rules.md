<!-- .cursor/rules/testing-rules.md -->
<!-- INTERFACE: child-rule-contract-v1 -->
# Extends: AGENTS.md (Root Contract v1.2.0 Hardened)
# Domain: Automated Testing, Quality Assurance & Verification
# Precedence: ROOT_AGENTS_MD (L0) > THIS_RULE (L1) > AD-HOC_PROMPT (L2)

## 1. Domain Invariants (Testing Standards)
- **Deterministic Tests:** Tests MUST be deterministic, isolated, and side-effect free. Never add artificial sleep delays (`setTimeout`, `time.sleep`) to patch race conditions.
- **Assertion Rigor:** Test real behavior, boundaries, and error transitions. Do not write tests that only check trivial types or source text.
- **Test Suite Integrity:** `NEVER` delete, skip (`test.skip`), or weaken assertions in existing test files to make a pipeline green.
- **No Mock Hallucinations:** Mocks are permitted ONLY for external third-party network APIs or payment gateways. Internal core logic MUST run against real instances.

## 2. Specialized Tool Gating
- **Pre-Test Check:** Before running the entire test suite, agent SHOULD run the single narrowest test file corresponding to the modified code to minimize token/time overhead.
- **Failure Diagnostics:** When a test fails, agent MUST inspect the exact assertion error line and actual vs expected values before proposing any code change.

## 3. Verification & Proof Protocols
- **Test Evidence Requirement:** Any claim that "tests pass" MUST be accompanied by the raw terminal stdout showing:
  - Test runner name (e.g. `vitest`, `jest`, `pytest`, `cargo test`).
  - Total tests executed, passed, failed count.
- **Regression Proof:** When adding a new test for a bug, the test MUST fail on the unfixed codebase and pass on the fixed codebase.

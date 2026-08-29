<!-- .cursor/rules/development-rules.md -->
<!-- INTERFACE: child-rule-contract-v1 -->
# Extends: AGENTS.md (Root Contract v1.2.0 Hardened)
# Domain: Software Engineering, Architecture & Coding
# Precedence: ROOT_AGENTS_MD (L0) > THIS_RULE (L1) > AD-HOC_PROMPT (L2)

## 1. Domain Invariants (Stricter Specializations)
- **Principle Order:** YAGNI > KISS > DRY. Refuse premature abstractions and weightless code.
- **Real Implementations Only:** Implement real, production-ready logic. Never introduce temporary shims, artificial timeouts, or fake data to bypass checks. ALWAYS implement complete concrete code.
- **Strict Scope Boundaries:** Modifications MUST be tightly scoped to the requested feature or defect. Do not refactor untouched files without explicit instruction.
- **Exported Symbol Integrity:** Before modifying any exported function, interface, or schema, agent MUST check callsites and references to prevent breakage.

## 2. Specialized Tool Gating (Pre-conditions & Post-conditions)
- **Pre-Edit Inspection:** Agent MUST run `read` on the exact target line range to acquire accurate line numbers and context before invoking `edit` or `write`.
- **Multi-File Batch Refactoring:** When changing 2 or more mutually dependent files, complete all planned file edits in a coordinated batch before triggering compiler/typecheck verification.
- **Type/Build Gating:** For TypeScript / Rust / Go / Python changes, run the appropriate compiler/typechecker immediately after editing.
- **Formatters:** Do not manually reformat or restyle unedited code; rely on the project's native formatter when available.

## 3. Verification & Proof Protocols
- **Bug Fixes:**
  1. Prove reproduction: Run command/test showing the failing state before fixing.
  2. Apply fix.
  3. Prove resolution: Re-run reproduction command showing clean pass.
- **New Features / Refactors:**
  1. Verify zero regression in existing test suite.
  2. Run targeted smoke test or behavioral check covering the new contract.
- **Delivery Format:** Every delivery turn MUST provide:
  - Exact modified file paths.
  - Attached terminal execution output (build/test logs).
  - Explicit outcome status: `VERIFIED_COMPLETE` or `BLOCKED`.

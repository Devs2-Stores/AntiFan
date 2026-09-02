---
phase: 3
title: "Decouple HS Rules & Freeze Core Raw Scanners"
status: pending
priority: P1
effort: "45m"
dependencies: [2]
---

# Phase 3: Decouple HS Rules & Freeze Core Raw Scanners

## 1. Overview
Hardcoded e-commerce business compliance rules (such as Sapo HS-01 through HS-26, Haravan form targets, and casing rules in `src/main/qa/rules/hs-gate-rules.ts`) represent mutable domain heuristics that evolve across platform updates. Keeping them embedded in Electron Main forces full desktop recompilation on every checklist update.

This phase enforces clean separation:
1. **Core Substrate (Frozen):** Only provides deterministic **Raw Diagnostic Scanners** (`LiquidErrorScanner`, `ServerCrashScanner`, `BrokenAssetScanner`, `LayoutOverflowEngine`).
2. **OMP Agent Skills (Evolving):** All 26 HS rules, Haravan/Sapo template checks, and auto-fix logic reside in `skill://theme-qa-az`.

## 2. Requirements
- Audit `src/main/qa/scanners/` to ensure all raw scanners output structured telemetry without hardcoding domain-specific auto-fail logic.
- Verify `theme.debug_bundle` and `theme.qa_validate` expose raw DOM/network/crash evidence to OMP without requiring Core code edits for new platform rules.
- Confirm `src/main/security/security-policy.ts` retains strict `contextIsolation: true` and `sandbox: true` invariants.

## 3. Architecture & Scanners Separation
```text
┌─────────────────────────────────────────────────────────────┐
│                 OMP SKILL (skill://theme-qa-az)             │
│  ├─ HS-01: Cart variantId AST Validation                    │
│  ├─ HS-02: /postcontact Form Submission Check               │
│  ├─ HS-03: article_comments Author/Email/Body Casing        │
│  └─ Auto-Fix & Liquid Code Modification Loops               │
└──────────────────────────────┬──────────────────────────────┘
                               │ (Consumes Raw Telemetry via MCP)
┌──────────────────────────────▼──────────────────────────────┐
│           ANTIFAN CORE SCANNERS (RAW TELEMETRY ONLY)        │
│  ├─ LiquidErrorScanner: Raw Liquid syntax & runtime dumps   │
│  ├─ ServerCrashScanner: HTTP 500/502/520 main-frame status  │
│  ├─ BrokenAssetScanner: DOM 404/CDP network correlation     │
│  └─ LayoutOverflowEngine: ClientRect horizontal overflow     │
└─────────────────────────────────────────────────────────────┘
```

## 4. Related Code Files
- Inspect: `src/main/qa/scanners/*.ts`
- Inspect: `src/main/qa/rules/hs-gate-rules.ts`
- Inspect: `src/main/security/security-policy.ts`

## 5. Implementation Steps
1. Verify raw scanners export unadulterated diagnostic arrays.
2. Confirm `theme.debug_bundle` tool output delivers raw diagnostic tokens directly to MCP clients.
3. Validate that no e-commerce-specific string mutations or AST rewrites are performed inside Electron Main.

## 6. Success Criteria & Verification
- [ ] Core raw scanners operate deterministically across all web platforms.
- [ ] Zero business logic churn in Core when Sapo or Haravan alters review guidelines.
- [ ] OMP Skill `theme-qa-az` receives complete raw telemetry bundles.

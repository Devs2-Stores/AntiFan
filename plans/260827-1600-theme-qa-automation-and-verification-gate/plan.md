---
plan: "260827-1600-theme-qa-automation-and-verification-gate"
title: "Automated Theme QA & Verification Gate Engine (Haravan / Sapo / Shopify)"
status: completed
created: "2026-08-27T16:00:00Z"
author: "AntiFan Control Plane Team & KongMing Advisory"
target_persona: "Haravan / Sapo / Shopify Theme Developer"
strategy: "Hybrid Dual-Layer Control Plane Engine (Candidate C + A/E Synthesis)"
phases:
  - id: "01"
    name: "Core Scanners & Platform Context Detection"
    status: completed
    file: "phase-01-core-scanners-and-platform-detection.md"
  - id: "02"
    name: "Layout Overflow Engine & Culprit Attribution"
    status: completed
    file: "phase-02-layout-overflow-engine-and-culprit-attribution.md"
  - id: "03"
    name: "HS Rules (HS-01–HS-06 implemented) & ThemeQaWorkflow Integration"
    status: completed
    file: "phase-03-hs-gate-rules-and-workflow-integration.md"
  - id: "04"
    name: "MCP Stdio Capability Gateway & UI Status"
    status: completed
    file: "phase-04-mcp-capability-gateway-and-ui-status.md"
  - id: "05"
    name: "Release Verification & Smoke Suite"
    status: completed
    file: "phase-05-release-verification-and-smoke-suite.md"
---

# Plan: Automated Theme QA & Verification Gate Engine
## Specialized Control Plane Verification for Haravan / Sapo / Shopify Themes

## 1. Executive Summary
Transform AntiFan's existing `ThemeQaWorkflow` into an automated, deterministic verification gate specifically tailored for Haravan, Sapo, and Shopify theme developers. The system detects runtime Liquid errors, translation omissions, responsive layout overflows with pinpoint DOM element attribution, broken CDN/image assets, and marketplace submission gates (HS1–HS26), generating structured, auditable evidence artifacts for human review and connected AI agents (OMP, Codex, Claude Code).

## 2. Core Architecture: Hybrid Dual-Layer Verification
```text
AntiFan Control Plane (Host Browser)
├── Layer 1: Static Workspace Gatekeeper (Node.js fast preflight)
│   ├── PlatformDetector (Haravan vs Sapo vs Shopify)
│   └── Static File & Naming Invariants
└── Layer 2: Runtime Storefront Engine (CDP & In-Browser Instrumentation)
    ├── Zero-Liquid Error Scanner (DOM text/attribute pattern matcher with RTE exclusion)
    ├── Layout Overflow Engine (Fast Active Viewport + On-Demand 3-Breakpoint Sweep)
    ├── Broken CDN/Asset Telemetry (DOM Image + CDP Network 4xx/5xx)
    └── HS1-HS26 Storefront Rules (Tiered: Critical = Error, Best-practice = Warning)
└── ArtifactStore: Immutable PII-Sanitized JSON Report + Visual Evidence Bounding Boxes
└── MCP Server: anti_theme_qa_validate / browser.debug_bundle
```

## 3. Phase Breakdown

| Phase | Title | Priority | Effort | Key Deliverable |
| :---: | :--- | :---: | :---: | :--- |
| **01** | Core Scanners & Platform Context Detection | P1 | 3h | `PlatformDetector`, `LiquidErrorScanner`, `BrokenAssetScanner` |
| **02** | Layout Overflow Engine & Culprit Attribution | P1 | 3h | Responsive $\Delta x$ calculator with CSS selector + bounding box attribution |
| **03** | HS1–HS26 Rules & ThemeQaWorkflow Integration | P1 | 4h | `HsGateRules` matrix and upgraded `ThemeQaWorkflow.validate()` |
| **04** | MCP Stdio Capability Gateway & UI Status | P2 | 2h | `anti_theme_qa_validate` MCP tool & Toolbar QA status badge |
| **05** | Release Verification & Smoke Suite | P1 | 2h | E2E smoke test `smoke-theme-qa-gate.cjs` & documentation update |

## 4. Non-Goals & Stop Rules
- AntiFan is strictly a Control Plane. It does NOT contain AI reasoning loops, prompt generators, or code autofix engines.
- No in-app IDE or full Chrome DevTools rebuild.
- Zero cross-platform rule leakage (Sapo rules never run on Haravan/Shopify).

---

## 5. Debate Synthesis (Candidates A, C, E)

- **Candidates Evaluated:**
  - `Candidate A`: Atomic Evidence Envelope (`browser.theme_debug_bundle`, `browser.storefront_assert`) with bounded ring buffers.
  - `Candidate C (Winner)`: Hybrid Dual-Layer Verification Engine (Static Preflight + Runtime CDP Storefront QA).
  - `Candidate E`: Lean Control Plane Boundaries & Stop Rule Enforcement.
- **Agreements:**
  - All candidates agree AntiFan must remain a lightweight Control Plane, strictly avoiding embedded agent loops or IDE features.
  - All candidates agree on the necessity of Zero-Liquid error detection and Layout Overflow element attribution.
- **Disagreements & Resolutions:**
  - *Debate 1: Monolithic vs Atomic MCP Tools* → Resolved in favor of Candidate A's `theme.debug_bundle` and `theme.qa_validate` composite envelopes over 10+ micro-tools.
  - *Debate 2: Pure Static vs Hybrid Runtime* → Resolved in favor of Candidate C's Hybrid model (static preflight + live CDP/DOM inspection).
- **Rejected Alternatives:**
  - Monolithic in-renderer Cypress/Playwright test runner (Rejected due to high memory bloat $>200\text{MB}$ and slow startup).
  - Client-side only `evalJs` without CDP telemetry (Rejected because it misses font/CSS 404s and network failures).

---

## 6. Red Team Review (6 Findings Adjudicated)

| Finding ID | Severity | Threat / Failure Mode | Disposition | Codebase Evidence & Mitigation |
| :---: | :---: | :--- | :---: | :--- |
| **RT-01** | **HIGH** | Injected scripts in untrusted merchant pages causing prototype pollution or execution errors. | **ACCEPT** | `native-tab-host.ts:340`. Use isolated world IIFE without global variable pollution. |
| **RT-02** | **MEDIUM** | Customer PII (emails in forms, checkout tokens) leaking into staged `ArtifactStore` reports. | **ACCEPT** | `artifact-store.ts:40`. Redact all email, phone, and auth tokens before staging `ThemeQaReport`. |
| **RT-03** | **HIGH** | Multi-breakpoint resizing freezing UI thread or disrupting developer carousel states. | **ACCEPT** | `native-tab-host.ts:480`. Adopt **Active Viewport Fast Mode** as default ($<200\text{ms}$), making 3-breakpoint sweep on-demand. |
| **RT-04** | **MEDIUM** | DOM TreeWalker on $>5000$ node pages blocking renderer event loop. | **ACCEPT** | Limit search depth to top-level containers (`main > *`, `header`, `section`), diving into children only when bounding box exceeds viewport. |
| **RT-05** | **HIGH** | False positives on "Liquid error" when written inside merchant blog post or RTE text. | **ACCEPT** | Exclude elements matching `.rte, .article__content, [data-user-content], textarea, input`. |
| **RT-06** | **MEDIUM** | Sub-pixel display scaling on Windows ($125\%/150\%$) causing fractional overflow false alarms. | **ACCEPT** | Enforce strict $1.0\text{px} \times \text{DPR}$ deadband threshold: `Math.ceil(scrollWidth - clientWidth) > 1`. |

---

## 7. Validation Log (User Decisions)

- **Session Date:** 2026-08-27
- **Verification Results:** 228/228 existing tests passing, 0 broken contracts.
- **Key Decisions:**
  1. `overflow_scan_mode`: **Active Viewport Fast + On-demand Multi-Breakpoint** (Prevents UI screen flicker during everyday theme editing; full sweep available via button/MCP).
  2. `cart_assertion_mode`: **Passive Contract & Network Spy** (Monitors real `/cart/add.js` submissions and form attributes without polluting cart with synthetic items).
  3. `hs_strictness`: **Tiered (Critical = Error, Best-practice = Warning)** (Ensures critical form/cart bugs block QA, while style/noPS guidelines provide non-blocking warnings).

---

## 8. Whole-Plan Consistency Sweep

- [X] All phase files (01–05) reflect the Hybrid Dual-Layer architecture and the 6 Red Team mitigations.
- [X] Deadband $1.0\text{px}$ and RTE exclusion rules incorporated into Phase 01 & Phase 02.
- [X] Tiered HS1-HS26 severity levels incorporated into Phase 03.
- [X] Zero unresolved contradictions across `plan.md` and `phase-01` through `phase-05`.
---

## 9. Deployment Status (2026-08-27)

- **Deployed:** `feat(qa)` `c70419f` + `fix(qa)` `999e71e` pushed to `origin/main` (commit `cd88b72..999e71e`).
- **Verification:** `npm run verify` → **255 tests / 58 suites / 0 fail**, typecheck pass, working tree clean.
- **Implemented HS scope:** HS-01..HS-06 (cart variant contract, contact endpoint + email, Sapo comment casing, deleteAddress handler, featured-image CDN, analytics/noPS guard). HS-07..HS-26 **not yet implemented** — phạm vi mở rộng theo lỗi thực tế từ pilot, không phải full matrix.
- **Open gates (honest):**
  - Independent code-review delegation **blocked by infra** — runtime reject schema trên mọi reviewer-agent (6 lần: 4 lỗi schema + 1 rate-limit + 1 schema); không có independent review evidence. Thay thế: main-agent review (Fable Full) + 255 tests.
  - HS-04 runtime behaviour trên store Sapo thật chưa xác nhận qua live eval — cần pilot.
  - Release framing: **Internal Preview (RC1)**, chưa phải public production release.

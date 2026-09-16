# AntiFan Documentation Hub

Index of engineering specifications, security models, operational runbooks, research records, and platform knowledge bases for AntiFan Browser Desktop.

---

## 1. Core Architecture & System Specifications

| Document | Purpose |
|---|---|
| [`ui-architecture.md`](ui-architecture.md) | Authoritative visual hierarchy, layout boundaries, Multi-WebContentsView surface model, split-review coordination, and cutover contracts. |
| [`security-model.md`](security-model.md) | Comprehensive trust boundaries, process isolation, profile partitions, lease authorization, and MCP capability risk gating. |
| [`operations.md`](operations.md) | Operational runbook for MCP control plane tools, Theme QA verification gates, Super Core local evidence store, and physical device adapters. |
| [`mcp-advertised-schema-enforcement.md`](mcp-advertised-schema-enforcement.md) | Technical rationale, boundary enforcement sites, and verification evidence preventing silent argument fabrication on advertised schemas. |

---

## 2. Research Records & Architectural Spikes

Dated research records preserved for architectural provenance and technical decision context:

| Document | Purpose |
|---|---|
| [`research-9router-auth.md`](research-9router-auth.md) | Direct OAuth authentication spike against upstream Google Code Assist endpoints, eliminating MITM proxy latency. |
| [`research-browser-agent-seamless-execution.md`](research-browser-agent-seamless-execution.md) | Comparative evaluation of leading AI browser agent architectures covering action batching, Bézier kinematics, and continuous streaming. |
| [`research-mobile-device-parity-chrome-sync.md`](research-mobile-device-parity-chrome-sync.md) | Hardware-fidelity iPhone 13 emulation blueprint using CDP native primitives (Retina DPR 3, platform string, viewport geometry, touch). |

---

## 3. Haravan Platform Knowledge Base (`docs/haravan/`)

Comprehensive platform wiki and evidence ledger for Haravan e-commerce theme architecture:

| Document | Purpose |
|---|---|
| [`haravan/README.md`](haravan/README.md) | Knowledge base index, epistemic hierarchy rules, evidence ledger sources, and open blocking questions. |
| [`haravan/base-theme-contract.md`](haravan/base-theme-contract.md) | Canonical primitives, flat directory structure, extension points, and performance standards for Universal Haravan Base Theme. |
| [`haravan/pattern-mining.md`](haravan/pattern-mining.md) | Empirical analysis of 30 production customer themes establishing common practices, flat structure invariants, and include vs render metrics. |
| [`haravan/platform-topology-and-settings.md`](haravan/platform-topology-and-settings.md) | Flat directory layout, legacy `settings.html`, modern `settings_schema.json`, and F1GENZ visual editor DOM binding rules. |
| [`haravan/liquid-objects-filters-tags.md`](haravan/liquid-objects-filters-tags.md) | Verified Liquid runtime specifications for global/resource objects, supported vs unsupported filters, and DotLiquid behavior. |
| [`haravan/routes-and-handles.md`](haravan/routes-and-handles.md) | Storefront URL routing, canonical template dispatch, handle mechanics, and mandatory `?themeid=` preview parameter targeting. |
| [`haravan/admin-merchant-workflows.md`](haravan/admin-merchant-workflows.md) | Merchant administrative workflows: theme import/export/publish, customizer persistence, and shared catalog implications. |
| [`haravan/api-capabilities-and-scopes.md`](haravan/api-capabilities-and-scopes.md) | Haraweb vs Commerce REST APIs, Bearer token lifecycles, leaky-bucket rate limits, webhooks, and documented API gaps. |
| [`haravan/cli-operations-and-guards.md`](haravan/cli-operations-and-guards.md) | `@f1genz/haravan-cli` command inventory, watcher synchronization, local state tracking, and fail-closed production guards. |
| [`haravan/data-lifecycle-and-storefront-behavior.md`](haravan/data-lifecycle-and-storefront-behavior.md) | Shared catalog lifecycle, entity reuse contracts, client-side Ajax cart endpoints, and storefront rendering pagination limits. |

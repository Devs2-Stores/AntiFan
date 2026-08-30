---
title: "Chrome Native Messaging Host Auto-Pairing & Scoped Cookie Synchronization Engine"
description: "Production-grade implementation plan for Chrome Extension Native Messaging host registration, zero-touch IPC auto-handshake, domain-scoped cookie sync, and capsule partition isolation in AntiFan Browser Desktop."
status: planned
priority: P1
effort: "2d"
tags: [native-messaging, chrome-extension, cookie-sync, auto-pairing, partition-isolation, security]
created: 2026-08-30
candidate: "Plan E (Comprehensive Synthesis)"
---

# Chrome Native Messaging Host Auto-Pairing & Scoped Cookie Synchronization Engine (Candidate Plan E)

## Executive Summary
Candidate Plan E delivers a comprehensive, production-grade synthesis for seamless cookie synchronization between Google Chrome / Edge / Brave and AntiFan Browser Desktop on Windows (win32-x64). It completely eliminates manual user token copying via a **Zero-Touch Local IPC Handshake** over Windows Named Pipes, provides **automated Native Messaging Host registry setup (`HKCU`)**, replaces indiscriminate 3,000-cookie dumps with **domain-scoped eTLD+1 filtering and debounced delta-sync**, and enforces **strict capsule partition isolation** with RFC 6265bis compliance.

## Storage Scope & Boundary Matrix (In-Scope vs Non-Goals)

| Storage Category | Support Status | Replicated? | Technical Rationale & Security Boundary |
| :--- | :---: | :---: | :--- |
| **HTTP / Session Cookies** | **IN-SCOPE** |  **YES** | **Primary Authentication Medium**. Extracted via Chrome's official `chrome.cookies` API, filtered by domain (eTLD+1), sanitized (RFC 6265bis `__Host-` / `sameSite`), and injected directly into target capsule session partition. |
| **Partitioned Cookies (CHIPS)** | **NON-GOAL** | ❌ **NO** | Electron 43's `CookiesSetDetails` API lacks `partitionKey` support (`node_modules/electron/electron.d.ts`), so partitioned 3rd-party cookies are intentionally excluded from the injection payload. |
| **HTTP Cache (CSS, JS, Images)** | **NON-GOAL** | ❌ **NO** | Static assets are fetched directly on-demand by AntiFan's Blink engine; copying megabytes of disk cache files is redundant and causes stale-asset corruption. |
| **LocalStorage / SessionStorage** | **NON-GOAL** | ❌ **NO** | Protected by browser Same-Origin Policy (SOP). Modern web platforms (Google, Shopify, Haravan, Sapo) automatically re-hydrate client storage upon receiving valid session cookies. Exporting cross-origin storage would require invasive script injection across all user tabs. |
| **IndexedDB / Service Workers** | **NON-GOAL** | ❌ **NO** | Site-internal structured databases and offline caches are origin-bound and re-instantiated automatically by storefront web applications. |

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                           CHROME / BRAVE / EDGE                                │
│                                                                                │
│  ┌───────────────────────────┐          ┌───────────────────────────────────┐  │
│  │   Active Browser Tab      │          │  Extension Background Worker      │  │
│  │ (Google, Haravan, Shopify)│          │  - chrome.cookies.onChanged       │  │
│  └─────────────┬─────────────┘          │  - Debounce Queue (300ms)         │  │
│                │                        │  - Domain Scoper (eTLD+1)         │  │
│                ▼                        └─────────────────┬─────────────────┘  │
│  ┌───────────────────────────┐                            │                    │
│  │ 1-Click Popup UI          │                            │ chrome.runtime     │
│  │ (Zero-Touch Status / Sync)│                            │ .connectNative()   │
│  └─────────────┬─────────────┘                            │                    │
└────────────────┼──────────────────────────────────────────┼────────────────────┘
                 │                                          │
                 │              Stdio Framing Protocol      │
                 │       (32-bit LE length-prefixed JSON)   ▼
                 │        ┌───────────────────────────────────────────────────┐
                 │        │      Native Messaging Host Bridge                 │
                 │        │      (com.antifan.bridge / Node/Binary)           │
                 │        └─────────────────────────┬─────────────────────────┘
                 │                                  │
                 │                                  │ Local Named Pipe (Windows win32-x64)
                 │                                  │ (Zero-Touch Launch Nonce Handshake)
                 ▼                                  ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│                         ANTIFAN BROWSER DESKTOP                                │
│                                                                                │
│  ┌──────────────────────────────────────────────────────────────────────────┐  │
│  │  BridgeServer & Local IPC Controller (Port 20129 / Named Pipe)           │  │
│  │  - Zero-Touch Token Issuer & Nonce Negotiator                            │  │
│  │  - RFC 6265bis Cookie Transformation & Sanitization                      │  │
│  └────────────────────────────────────┬─────────────────────────────────────┘  │
│                                       │                                        │
│          ┌────────────────────────────┴────────────────────────────┐           │
│          ▼                                                         ▼           │
│  ┌──────────────────────────────┐          ┌──────────────────────────────┐    │
│  │ Capsule A Partition Session  │          │ Capsule B Partition Session  │    │
│  │ (persist:capsule-shop-1)     │          │ (persist:capsule-shop-2)     │    │
│  │ - Isolated Cookie Jar        │          │ - Isolated Cookie Jar        │    │
│  │ - Dedicated WebContentsView  │          │ - Dedicated WebContentsView  │    │
│  └──────────────────────────────┘          └──────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────────────────┘
```

## Goals & Strategic Objectives

| # | Objective | Description | Priority |
|---|-----------|-------------|----------|
| 1 | **Windows Host Registration** | Automate Native Messaging Host manifest generation and registry setup for Chrome, Edge, and Brave on Windows (`HKCU\Software\...`). | P1 |
| 2 | **Zero-Touch Auto-Handshake** | Establish seamless, zero-friction mutual authentication between Native Host and AntiFan Desktop via Windows Named Pipe (`\\.\pipe\antifan-bridge-ipc-<UUID>`), generating ephemeral scoped tokens without clipboard pasting. | P1 |
| 3 | **Domain-Scoped & Delta Cookie Sync** | Replace bulk cookie dumping with intelligent domain filters (Google Auth, E-Commerce platforms like Haravan/Shopify/Sapo, and Active Tab eTLD+1), paired with a debounced `chrome.cookies.onChanged` delta engine. | P1 |
| 4 | **Capsule Partition Isolation** | Ingest cookies strictly into target capsule partitions (`persist:capsule-<id>`) or active tab sessions, enforcing RFC 6265bis rules (`__Host-`, `sameSite`, expiry) and preventing cross-capsule data pollution. | P1 |
| 5 | **Comprehensive Verification Suite** | Implement 100% automated test coverage across framing parsers, registry installers, domain matchers, and partitioned cookie injection. | P1 |

## Implementation Roadmap (4 Phases)

| Phase | Title | Scope Summary | Target Effort | Status |
|---|---|---|---|---|
| **Phase 1** | [Windows Native Messaging Host Protocol & Registry Subsystem](./phase-01-native-messaging-host-and-registration.md) | 32-bit length-prefixed stdio framing engine, manifest generator, Windows registry installer, packaged host shim (`antifan-bridge-host.exe`). | 4h | Ready |
| **Phase 2** | [Zero-Touch Local Named Pipe IPC & Mutual Authentication Layer](./phase-02-zero-touch-ipc-and-handshake.md) | Local Named Pipe server (`\\.\pipe\antifan-bridge-ipc-<UUID>`), `launchNonce` secret auth, auto-handshake protocol, MV3 service worker resilience. | 4h | Ready |
| **Phase 3** | [Extension Domain-Scoped Cookie Watcher & Delta Sync Engine](./phase-03-domain-scoped-cookie-watcher-and-delta-sync.md) | Domain scoping engine (Google, E-Commerce, active eTLD+1), debounced `chrome.cookies.onChanged` service worker, 1-Click active-site sync, popup UI status indicator. | 4h | Ready |
| **Phase 4** | [Capsule Partition Ingestion, Isolation & Full Verification Suite](./phase-04-partition-ingestion-and-verification.md) | Partition routing in BridgeServer, RFC 6265bis transform, explicit capsule binding, packaged artifact smoke test (`scripts/smoke-native-messaging-packaged.mjs`), and comprehensive regression suite. | 4h | Ready |

## Key Architectural Principles (KISS & DRY)
1. **Single Source of Truth for Cookie Transforms**: Reuse `extensionCookieImportSetDetails` in `chrome-profile-sync.ts` across all ingestion channels (CDP, SQLite, Bridge HTTP, and Native Messaging IPC).
2. **Fail-Closed Security Model**: Native host only communicates over authenticated local IPC; tokens are stored in `chrome.storage.session` (memory-only); manifests are scoped strictly to the extension's explicit ID.
3. **Zero Native Dependencies**: Stdio framing and local IPC use pure Node.js `net`, `crypto`, and `buffer` primitives without requiring native C++ addons (`node-gyp`).
4. **Idempotent Installation**: Registration subsystem checks existing registry keys / filesystem manifests and performs atomic updates or clean uninstallation.

## Success Criteria & Verification Gates
- [ ] Native Messaging Host manifest generated and registered in Windows HKCU registry for Google Chrome, Microsoft Edge, and Brave.
- [ ] Chrome extension connects via `chrome.runtime.connectNative` and successfully executes zero-touch handshake without manual token input.
- [ ] Domain-scoped sync transfers <50 targeted cookies in <50ms instead of 3,000 cookies (>10MB).
- [ ] Ingested session cookies appear immediately in active capsule partition `persist:capsule-<id>` without affecting other tabs or default session.
- [ ] All unit, integration, E2E, and packaged smoke tests pass (`npm test`).
<!-- slug: chrome-native-messaging-bridge -->

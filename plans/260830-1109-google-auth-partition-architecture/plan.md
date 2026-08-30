---
title: "Google Authentication & Partition Architecture for AntiFan Browser Desktop"
description: "Implementation plan for session partition configurator, tab ownership migration, per-capsule session isolation, and Chrome profile sync."
status: completed
priority: P1
effort: "1d"
tags: [auth, google, partition, sessions, chrome-sync]
created: 2026-08-30
---

# Google Authentication & Partition Architecture for AntiFan Browser Desktop

## Overview
Implement an evidence-grounded session partition architecture in AntiFan Browser Desktop. Establish a dedicated `browser-session-partition.ts` configurator managing `userAgentMode: "native" | "clean"` per partition before view construction. Migrate tab state to persist `capsuleId` and `userAgentMode` so creation, restore, and split-view paths construct `WebContentsView` with deterministic isolated partitions. The `native` mode enforces zero UA/header laundering for direct Google authentication, while `clean` mode preserves Cloudflare/WAF compatibility for storefront QA.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Create `browser-session-partition.ts` to configure partitions on first resolution before view construction, removing global `defaultSession` interceptors in `index.ts` | P1 |
| 2 | Migrate `AntiFanTab` state to persist `capsuleId` and `userAgentMode`, passing them into `createTab`, `restoreTabs`, and split-view creation | P1 |
| 3 | Support `userAgentMode: "native"` (zero UA/header tampering) and `userAgentMode: "clean"` (desktop Chrome UA) per partition | P1 |
| 4 | Support targeted Chrome Profile Sync (Live CDP + DPAPI Shadow Copy) directly into active capsule partitions | P2 |
| 5 | Validate the implementation across the verification matrix against current repository test suite baseline | P1 |

## Phases

| # | Phase | Status |
| 1 | [Phase 1: Partition Configurator & UserAgentMode](./phase-01-start.md) | Completed |
| 2 | [Phase 2: Tab Ownership Migration & Partition Routing](./phase-02-per-capsule-partition-registry.md) | Completed |
| 3 | [Phase 3: Chrome Profile Sync Enhancement](./phase-03-chrome-profile-sync-enhancement.md) | Completed |
| 4 | [Phase 4: Verification & Smoke Matrix](./phase-04-verification-and-smoke-matrix.md) | Completed |

## Success Criteria

- [X] Partition configurator installs `clean` or `native` policy on first partition resolution before `WebContentsView` construction
- [X] Global `defaultSession` in `index.ts` has zero header laundering interceptors
- [X] Tab creation, tab restore (`restoreTabs`), and split-view creation construct views with their deterministic capsule partition
- [X] A session partition configured with `userAgentMode: "native"` passes Google email submission and renders password challenge (`hasPassword: true`, `hasInsecureBrowser: false`)
- [X] Session partitions with `userAgentMode: "clean"` maintain Cloudflare Turnstile compatibility on merchant storefronts
- [X] Full repository test suite (`npm test`) passes with 0 failures against the test baseline

<!-- slug: google-auth-partition-architecture -->

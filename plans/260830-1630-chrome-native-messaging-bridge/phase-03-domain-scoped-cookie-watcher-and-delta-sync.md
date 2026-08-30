---
phase: 3
title: "Extension Domain-Scoped Cookie Watcher & Delta Sync Engine"
status: ready
priority: P1
effort: "4h"
dependencies: ["2"]
---

# Phase 3: Extension Domain-Scoped Cookie Watcher & Delta Sync Engine

## Overview
Phase 3 replaces indiscriminate 3,000-cookie dumps with an intelligent, domain-scoped filtering engine and a real-time, debounced delta-sync pipeline. By listening to `chrome.cookies.onChanged` within the Extension Background Service Worker, cookie modifications for targeted domains (Google Auth, Haravan/Shopify/Sapo E-Commerce, and Active Tab eTLD+1) are coalesced and transmitted incrementally in milliseconds.

---

## Requirements

1. **Domain Scoping & Matching Engine**:
   - **Google Authentication Profile**: Matches `*.google.com`, `*.youtube.com`, `*.googleusercontent.com`, `accounts.google.com`, `myaccount.google.com`.
   - **E-Commerce Platform Profile**: Matches `*.haravan.com`, `*.myshopify.com`, `*.shopify.com`, `*.sapo.vn`, `*.bizweb.vn`.
   - **Active Tab eTLD+1 Profile**: Dynamically extracts effective top-level domain plus one (eTLD+1) for the current active tab (e.g. `https://my-store.admin.haravan.com` -> `.haravan.com`, `my-store.admin.haravan.com`).
   - Custom filter capability matching explicit user-selected domains.
2. **High-Performance Event Debouncing**:
   - Sliding window debounce (300ms window, 1000ms max delay) on `chrome.cookies.onChanged`.
   - Coalesces rapid bursts (e.g. OAuth multi-redirects setting 10–20 cookies within 200ms) into a single atomic sync batch.
   - De-duplicates redundant intermediate value updates for the same `(domain, path, name)` tuple.
3. **Delta Sync Protocol (Upserts & Deletions)**:
   - Supports both additions/updates (`upserted: ExtensionCookieInput[]`) and explicit removals (`removed: Array<{ name, domain, path, storeId }>`):
     - When a cookie is removed in Chrome, the corresponding cookie in the target AntiFan partition is removed via `session.cookies.remove(url, name)`.
4. **Dual Sync Interaction Modes**:
   - **Mode A: 1-Click Active Site Sync**: User opens extension popup or clicks toolbar button -> extracts only active tab cookies (<20 cookies, <30ms latency) and injects into the active tab partition.
   - **Mode B: Background Real-Time Delta-Sync**: Automatic continuous synchronization of tracked domain profiles with visual status telemetry.

---

## Architecture & Debouncing Pipeline

```
┌────────────────────────────────────────────────────────────────────────┐
│                        CHROME COOKIES EVENT STREAM                     │
│                        (chrome.cookies.onChanged)                      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                  Domain Scope Filter (domain-scoper.js)                │
│                                                                        │
│  Is domain in [Google, E-Commerce, ActiveTab eTLD+1, Custom]?          │
│  ├─ NO  ──> Ignore & Drop Event (Zero Overhead)                        │
│  └─ YES ──> Pass to Sliding Window Debouncer                           │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│            Sliding Window Debouncer & Coalescing Engine                │
│                                                                        │
│  - Collect events over 300ms sliding window                            │
│  - Coalesce: Map<cookieKey, { type: 'upsert'|'remove', cookie }>       │
│  - Flush when timer expires -> Create atomic delta batch               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│          HTTP / WebSocket Dispatcher to BridgeServer                   │
│          POST /api/cookies/import (with Delta & Ephemeral Token)       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Related Code Files

| Action | Path | Purpose |
|---|---|---|
| **Modify** | `package.json` | Add `tldts` & `esbuild` dependencies and `build:extension` npm script. |
| **Create** | `scripts/build-extension.mjs` | Compiles and bundles all extension TypeScript sources (`src/extension/*`) + `tldts` into single IIFE `extension/background.js`. |
| **Create** | `src/extension/domain-scoper.ts` | TypeScript domain matcher for eTLD+1 extraction, wildcard matching, and PSL filtering. |
| **Create** | `src/extension/cookie-debouncer.ts` | Sliding-window debounce accumulator and delta batcher. |
| **Create** | `src/extension/background.ts` | Extension service worker entry point wiring `chrome.cookies.onChanged` into the scoper pipeline. |
| **Output** | `extension/background.js` | Deterministically generated single-file classic bundle (zero runtime imports). |
| **Modify** | `extension/manifest.json` | Declare `"service_worker": "background.js"` and `"nativeMessaging"` permissions. |
| **Modify** | `extension/popup.html` | UI for Active-Site 1-Click Sync, profile selection toggles, and live sync badge. |
| **Modify** | `extension/popup.js` | Logic for active tab detection, 1-click sync dispatch, and delta-sync toggling. |
| **Create** | `test/main/domain-scoper.test.ts` | Unit tests for domain matching, eTLD+1 extraction, and wildcard resolution. |
| **Create** | `test/main/extension-bundle.test.ts` | Validates MV3 extension bundle syntax, zero-import execution, and manifest compatibility. |

## Implementation Steps

### 1. Robust Public Suffix List (PSL) & eTLD+1 Scoper (`src/extension/domain-scoper.ts`)
```typescript
import { getDomain } from 'tldts';
const SCOPE_PROFILES = {
  google: [
    /(^|\.)google\.com$/,
    /(^|\.)youtube\.com$/,
    /(^|\.)googleusercontent\.com$/,
    /(^|\.)accounts\.google\.com$/,
  ],
  ecommerce: [
    /(^|\.)haravan\.com$/,
    /(^|\.)myshopify\.com$/,
    /(^|\.)shopify\.com$/,
    /(^|\.)sapo\.vn$/,
    /(^|\.)bizweb\.vn$/,
  ],
};

export function extractEtldPlusOne(hostname) {
  if (!hostname) return null;
  const cleanHost = hostname.trim().toLowerCase().replace(/^\[|\]$/g, ''); // Strip IPv6 brackets

  // Special case: localhost & loopback IP addresses
  if (cleanHost === 'localhost' || cleanHost === '127.0.0.1' || cleanHost === '::1') {
    return cleanHost;
  }
  // Check IP addresses (IPv4 / IPv6)
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(cleanHost) || cleanHost.includes(':')) {
    return cleanHost;
  }

  // Standard Public Suffix List matching (handles .co.uk, .gov.vn, .myshopify.com, Punycode IDN)
  const rootDomain = getDomain(cleanHost, { allowPrivateDomains: true });
  return rootDomain || cleanHost;
}

export function isCookieInScope(cookie, enabledProfiles = ['google', 'ecommerce'], activeTabHostname = null) {
  const rawDomain = (cookie.domain || '').replace(/^\./, '').trim().toLowerCase();
  if (!rawDomain) return false;

  // 1. Active Tab eTLD+1 Isolation
  if (activeTabHostname) {
    const activeRoot = extractEtldPlusOne(activeTabHostname);
    const cookieRoot = extractEtldPlusOne(rawDomain);
    if (activeRoot && cookieRoot && (activeRoot === cookieRoot || rawDomain === activeRoot || rawDomain.endsWith('.' + activeRoot))) {
      return true;
    }
  }

  // 2. Pre-configured Domain Profiles (Google, E-Commerce platforms)
  for (const profile of enabledProfiles) {
    const patterns = SCOPE_PROFILES[profile];
    if (patterns && patterns.some(pattern => pattern.test(rawDomain))) {
      return true;
    }
  }

  return false;
}
```

### 2. Cookie Debouncer & Delta Batcher (`extension/cookie-debouncer.js`)
```javascript
class CookieDebouncer {
  constructor(flushCallback, delayMs = 300, maxWaitMs = 1000) {
    this.flushCallback = flushCallback;
    this.delayMs = delayMs;
    this.maxWaitMs = maxWaitMs;
    this.queue = new Map();
    this.timer = null;
    this.firstEventTime = null;
  }

  addChange(changeInfo) {
    const { cookie, removed } = changeInfo;
    const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
    
    this.queue.set(key, {
      type: removed ? 'remove' : 'upsert',
      cookie,
      timestamp: Date.now(),
    });

    if (!this.firstEventTime) {
      this.firstEventTime = Date.now();
    }

    const elapsed = Date.now() - this.firstEventTime;
    if (elapsed >= this.maxWaitMs) {
      this.flush();
    } else {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), this.delayMs);
    }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.firstEventTime = null;

    if (this.queue.size === 0) return;

    const upserted = [];
    const removed = [];

    for (const item of this.queue.values()) {
      if (item.type === 'upsert') {
        upserted.push(item.cookie);
      } else {
        removed.push({
          name: item.cookie.name,
          domain: item.cookie.domain,
          path: item.cookie.path,
          secure: item.cookie.secure,
        });
      }
    }

    this.queue.clear();
    this.flushCallback({ upserted, removed });
  }
}
```

---

## Success Criteria & Test Plan

- [ ] **Domain Scoper Unit Tests** (`test/main/domain-scoper.test.ts`):
  - Google profile correctly matches `.google.com`, `accounts.google.com`, `youtube.com`.
  - E-Commerce profile correctly matches `my-shop.myharavan.com`, `admin.shopify.com`, `store.sapo.vn`.
  - Active Tab eTLD+1 extraction correctly isolates `app.custom-domain.com` without leaking unrelated domains.
  - Rejects untracked origins (e.g. `random-news-site.com`).
- [ ] **Debouncer & Coalescing Tests**:
  - 20 rapid cookie change events within 100ms trigger exactly 1 debounced flush.
  - Updating value 5 times for same key sends only the final state.
  - Upsert followed by deletion in same window correctly yields removal.
- [ ] **1-Click Active Site Sync Verification**:
  - Clicking "Sync Active Site" transfers strictly cookies matching active tab in <30ms.

---

## Risk Assessment & Mitigation
- **Risk**: High-frequency cookie writes from tracker scripts causing excessive debouncer load.
  - **Mitigation**: Domain Scoper filter runs synchronously *before* the debouncer queue, immediately dropping 95%+ of irrelevant cookie events.
- **Risk**: Expired cookies sent in delta stream.
  - **Mitigation**: Client checks `expirationDate <= now` before enqueueing and drops expired entries.

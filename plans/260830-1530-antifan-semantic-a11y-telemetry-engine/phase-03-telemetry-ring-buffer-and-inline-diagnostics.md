---
phase: 3
title: "Telemetry Ring Buffer & Inline Diagnostics"
status: superseded
priority: P2
effort: "4h"
dependencies: ["phase-01-cdp-a11y-serializer-and-ref-registry"]
---

# Phase 3: Telemetry Ring Buffer & Inline Diagnostics

## Overview
Implement an asynchronous, memory-bounded (max 2MB per tab) Telemetry Ring Buffer in AntiFan capturing real-time Console errors, uncaught exceptions, and Network 4xx/5xx failures, and automatically inject passive telemetry alert summaries into all AntiFan MCP tool responses.

## Requirements
- **Functional**:
  - Listen to CDP `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Log.entryAdded`, and `Network.responseReceived`.
  - Classify anomalies: `CRITICAL_EXCEPTION`, `HTTP_5XX_SERVER_ERROR`, `HTTP_4XX_CLIENT_ERROR`, `CORS_PREFLIGHT_FAIL`, `UNHANDLED_REJECTION`.
  - Deep Recursive Sanitizer: scrub OAuth tokens, HMAC secrets, passwords, Bearer tokens, cookies, and sensitive query/body parameters from all headers, URLs, and stack traces.
  - Prompt Injection Defense: escape and strip instruction delimiters (`<system-directive>`, `[IMPORTANT: ... ]`) from intercepted console error messages before buffering.
  - Eager V8 Memory Release: eagerly serialize CDP RemoteObjects to primitive JSON/strings and immediately invoke `Runtime.releaseObject` to prevent V8 heap exhaustion.
  - Retain last 200 console events and 100 failed network transactions per tab using circular FIFO buffers (strictly capped at 2MB per tab).
  - Automatically append `_telemetry: { errorCount, lastCriticalError }` to tool responses when active anomalies occur.
  - Expose dedicated query tool `anti.telemetry.drain` and integrate with `theme.debug_bundle`.
- **Non-Functional**:
  - Zero performance overhead on UI thread (< 2ms background processing).
  - Rate-limiting console capture to max 50 events/second per tab to prevent log spam floods.
## Architecture
```
CDP Event Stream (Runtime, Log, Network)
  └── TelemetrySniffer (Sanitize secrets, categorize severity)
        ├── CircularRingBuffer (Tab-isolated, fixed 2MB cap)
        └── PassiveAlertInjector -> Injected into all AntiFan MCP responses
```

## Related Code Files
- Create/Update: `src/main/telemetry/telemetry-buffer.service.ts`
- Create/Update: `src/main/telemetry/telemetry-sanitizer.ts`
- Create/Update: `src/mcp/handlers/telemetry.handler.ts`

## Implementation Steps
1. Implement `TelemetrySanitizer` with deep recursive regex scrubbing covering URLs, query strings, POST bodies, headers, and prompt injection neutralizers.
2. Build `TelemetryBufferService` with tab-keyed circular FIFO buffers and eager `Runtime.releaseObject` memory cleanup.
3. Attach CDP listeners on browser tab creation / navigation with rate-limiting throttling (max 50 events/sec).
4. Hook response pipeline to embed `_telemetry` summary object with length-clamped sanitized error messages.
5. Expose `anti.telemetry.drain` tool to fetch detailed stack traces and sanitized request payloads.

## Success Criteria
- [ ] 100% of 500 API errors and uncaught JS exceptions captured, sanitized, and surfaced immediately.
- [ ] Memory footprint strictly bounded under 2MB across 10,000 continuous console events with zero V8 heap leaks.
- [ ] All Authorization, token, cookie, and password payloads deeply redacted in logs.

## Risk Assessment & Mitigations
- **Risk**: V8 heap exhaustion via unreleased RemoteObjects or log flood spam.
- **Mitigation**: Immediate `Runtime.releaseObject` invocations + rate-limiting threshold of 50 events/sec per tab.

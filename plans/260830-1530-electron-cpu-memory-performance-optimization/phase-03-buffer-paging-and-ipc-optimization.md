---
phase: 3
title: "Terminal Buffer Paging & WebSocket JSON Optimization"
status: pending
priority: P1
effort: "45m"
dependencies: [2]
---

# Phase 03: Terminal Buffer Paging & WebSocket JSON Optimization

## Overview
Eliminates massive 4.5 MB+ JSON serialization overhead across Bridge Server WebSocket broadcasts. Implements a **Strict Global JSON-Bounded Wire Budget Allocation Strategy** capped at 40 KiB total across ALL base buffers and split buffers combined. By measuring and bounding the post-JSON-escaped byte length (`Buffer.byteLength(JSON.stringify(str), 'utf8')`), this strategy guarantees the handshake JSON message stays strictly `< 100 KB` regardless of session count, split panes, or dense 24-bit ANSI escape code expansion. Provides an on-demand RPC `terminal.getFullBuffer` for clients requesting complete historical logs.

## Requirements
- Functional:
  - Initial handshake and periodic status broadcasts must use strict global JSON-bounded wire allocation:
    - Total global JSON buffer budget: 40 KiB (40,960 bytes UTF-8 JSON wire cost).
    - All active/background base and split panes are enumerated as total pane slots (`totalPanes = baseCount + splitCount`).
    - Active pane slot (active session or active split): allocated 40% of budget (16 KiB JSON cost).
    - All remaining `totalPanes - 1` background pane slots: share the remaining 60% (24 KiB) divided equally (e.g. 9 background panes get ~2.6 KiB JSON cost each).
  - Truncation operates with `safeSliceTailJsonBounded()`: cuts on valid newline boundaries, prepends `\x1b[0m` to neutralize severed color codes, and guarantees the JSON-serialized byte cost stays under the allocated budget.
  - Add explicit RPC method `terminal.getFullBuffer` / `antifan.terminal.getFullBuffer` for clients needing full uncompressed history.
- Non-functional:
  - The complete handshake JSON payload verified via `Buffer.byteLength(JSON.stringify(handshakeMessage), 'utf8')` MUST stay `< 100 KB` (down from 4.5 MB) even with 10 split sessions filled with dense ANSI escape codes.
  - Main Process JSON serialization time during status broadcast drops from 30ms to < 0.5ms.
  - V8 heap allocation per broadcast drops from 10MB to < 120KB.
## Architecture & Code Changes

### Target: `src/main/browser/terminal-manager.ts`
1. Implement JSON-bounded UTF-8 tail slicing helper:
   ```typescript
   export function safeSliceTailJsonBounded(str: string, maxJsonBytes: number): string {
     if (!str) return '';
     // Initial coarse estimate (assuming worst-case 3x ANSI JSON escape expansion)
     let maxRawBytes = Math.max(128, Math.floor(maxJsonBytes / 3));
     let buf = Buffer.from(str, 'utf8');
     if (buf.length > maxRawBytes) {
       buf = buf.subarray(buf.length - maxRawBytes);
     }
     let decoded = buf.toString('utf8');
     const firstNl = decoded.indexOf('\n');
     let candidate = firstNl >= 0 ? `\x1b[0m${decoded.slice(firstNl + 1)}` : `\x1b[0m${decoded}`;

     // Precise JSON byte length verification loop
     while (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > maxJsonBytes && candidate.length > 32) {
       const nextNl = candidate.indexOf('\n', 5);
       if (nextNl >= 0) {
         candidate = `\x1b[0m${candidate.slice(nextNl + 1)}`;
       } else {
         candidate = `\x1b[0m${candidate.slice(Math.floor(candidate.length / 2))}`;
       }
     }
     return candidate;
   }
   ```
2. Update `listSessions()` with unified pane slot allocation:
   ```typescript
   export interface SessionSummary {
     id: string;
     name: string;
     cwd: string;
     active: boolean;
     buffer: string; // Tail buffer allocated within strict global JSON wire budget
     splitSessionId?: string;
     splitBuffer?: string;
     bufferLength: number; // Total raw byte count in memory
   }

   const GLOBAL_JSON_BUFFER_BUDGET_BYTES = 40 * 1024; // 40 KiB total JSON cost for all panes

   public listSessions(paged = true): SessionSummary[] {
     const baseSessions = [...this.sessions.values()].filter(s => !s.splitOf);
     if (!paged || baseSessions.length === 0) {
       return baseSessions.map(s => {
         const split = [...this.sessions.values()].find(x => x.splitOf === s.id);
         return {
           id: s.id,
           name: s.name,
           cwd: s.cwd,
           active: s.id === this.activeSessionId,
           buffer: s.buffer,
           splitSessionId: split?.id,
           splitBuffer: split?.buffer || '',
           bufferLength: Buffer.byteLength(s.buffer, 'utf8'),
         };
       });
     }

     // Count total panes across base and split sessions
     let totalPanes = 0;
     for (const s of baseSessions) {
       totalPanes += 1;
       if ([...this.sessions.values()].some(x => x.splitOf === s.id)) totalPanes += 1;
     }

     const activeBudget = Math.floor(GLOBAL_JSON_BUFFER_BUDGET_BYTES * 0.4);
     const bgBudget = totalPanes > 1
       ? Math.floor((GLOBAL_JSON_BUFFER_BUDGET_BYTES * 0.6) / (totalPanes - 1))
       : activeBudget;

     return baseSessions.map(s => {
       const isActive = s.id === this.activeSessionId;
       const split = [...this.sessions.values()].find(x => x.splitOf === s.id);
       const baseSlotBudget = isActive ? activeBudget : bgBudget;
       const splitSlotBudget = bgBudget;

       const buffer = safeSliceTailJsonBounded(s.buffer, baseSlotBudget);
       const splitBuffer = split ? safeSliceTailJsonBounded(split.buffer, splitSlotBudget) : '';

       return {
         id: s.id,
         name: s.name,
         cwd: s.cwd,
         active: isActive,
         buffer,
         splitSessionId: split?.id,
         splitBuffer,
         bufferLength: Buffer.byteLength(s.buffer, 'utf8'),
       };
     });
   }

   public getFullBuffer(sessionId: string): { sessionId: string; buffer: string; snapshotThroughSeq: number } {
     const s = this.sessions.get(sessionId);
     return {
       sessionId,
       buffer: s ? s.buffer : '',
       snapshotThroughSeq: s ? s.lastSeq : 0,
     };
   }
   ```
### Target: `src/main/bridge/bridge-server.ts`
1. Use paged session summaries in `getStatus()`, initial handshake, and `antifan:terminal:session` events.
2. Add RPC route in `handleRequest`:
   ```typescript
   case 'terminalGetFullBuffer':
   case 'antifan.terminalGetFullBuffer': {
     const tm = TerminalManager.getInstance();
     const targetId = p.sessionId || tm.getActiveSessionId();
     const snapshot = tm.getFullBuffer(targetId);
     respond(true, snapshot);
     break;
   }
   ```
## Related Code Files
- Modify: `src/main/browser/terminal-manager.ts`
- Modify: `src/main/bridge/bridge-server.ts`
- Modify: `src/shared/contracts.ts`

## Implementation Steps
1. Refactor `terminal-manager.ts` with `safeSliceTailJsonBounded` and strict multi-pane budget distribution.
2. Wire `antifan.terminalGetFullBuffer` RPC returning `{ sessionId, buffer, snapshotThroughSeq }` in `bridge-server.ts`.
3. Write adversarial unit test:
   - Create 5 base sessions + 5 split sessions (10 panes total), flood every buffer with 500KB of dense 24-bit ANSI color escape codes (`\x1b[38;2;255;128;0m`), serialize `handshakeMessage`, and assert `Buffer.byteLength(JSON.stringify(handshakeMessage), 'utf8') < 100 * 1024`.
   - Verify sequence tracking: emit live PTY data, assert `seq` increments monotonically, verify `getFullBuffer().snapshotThroughSeq` matches the exact PTY sequence count.

## Success Criteria
- [ ] Initial Bridge WebSocket welcome message size verified `< 100 KB` (`Buffer.byteLength(JSON.stringify(msg), 'utf8')`) in adversarial 10-split ANSI-heavy test.
- [ ] `antifan.terminalGetFullBuffer` returns complete historical logs and exact `snapshotThroughSeq` watermark.
- [ ] Zero JSON parse/stringify lag on V8 event loop (< 0.5ms).
- *Risk:* Agent expecting >32KB buffer on initial connect fails to see early boot logs.
- *Mitigation:* Agents use live streaming `antifan:terminal:data` for ongoing logs, and can call `getFullBuffer` if historical backfill is required.

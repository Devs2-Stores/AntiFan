---
phase: 1
title: "safeSliceTailJsonBounded Algorithm Optimization"
status: pending
priority: P0
effort: "45m"
dependencies: []
---

# Phase 1: safeSliceTailJsonBounded Algorithm Optimization

## Overview
Replaces the $O(N \log N)$ `Array.from` binary search implementation in `src/main/browser/terminal-manager.ts` with an $O(\text{budget})$ reverse tail scanner. This eliminates $\approx 50\text{MB}$ of transient heap allocations per session buffer during `listSessions()` and reduces execution time on 512KB buffers by $>95\%$ (from ~73ms to ~2ms).

## Requirements
- Functional:
  - Must return the largest trailing substring of `str` such that `Buffer.byteLength(JSON.stringify(result), 'utf8') <= maxJsonBytes`.
  - Must prefix the result with the ANSI color reset sequence `\x1b[0m` whenever non-empty.
  - If a newline exists in the candidate slice, must slice after the first newline (`rawSlice.slice(firstNl + 1)`) so log output starts on a fresh line.
  - Must handle UTF-16 surrogate pairs safely without splitting surrogate halves.
- Non-functional:
  - Zero allocation of multi-thousand element arrays (`Array.from(str)` is banned).
  - Execution time $\le 0.1\text{ms}$ per call for typical 40KB budget slices on 512KB inputs.

## Architecture
- Bounding Step: Since any valid JSON-encoded substring whose UTF-8 byte length $\le \text{maxJsonBytes}$ can contain at most $\text{maxJsonBytes}$ UTF-16 code units, immediately bound the search string:
  `tail = str.length > maxJsonBytes ? str.slice(-maxJsonBytes) : str;`
- Surrogate alignment: If `tail` begins with a low surrogate (`0xDC00 - 0xDFFF`), advance by 1 char.
- In-place Binary Search: Perform binary search on `tail` indices directly using native `String.prototype.slice()` and `Buffer.byteLength(JSON.stringify(candidate), 'utf8')`.

## Related Code Files
- Modify: `src/main/browser/terminal-manager.ts`
- Create: `test/main/safe-slice-tail.test.ts`

## Implementation Steps
1. Refactor `safeSliceTailJsonBounded` in `src/main/browser/terminal-manager.ts` to implement the tail-bounded binary search.
2. Create unit test suite `test/main/safe-slice-tail.test.ts` covering:
   - Empty strings, short strings ($< \text{budget}$), exact budget bounds.
   - Long strings (512KB) with ANSI color codes and rapid newlines.
   - Unicode emoji strings and multi-byte UTF-8 surrogate pair safety.
   - Strings with no newlines vs strings with only newlines.
   - Tight budgets ($< \text{resetPrefix byte size}$ returning `''`).
3. Run `node --test .compiled/test/main/safe-slice-tail.test.js` to verify 100% test coverage.

## Success Criteria
- [ ] `safeSliceTailJsonBounded` achieves $>30\times$ speedup on 512KB strings.
- [ ] Memory allocation per call drops from $\approx 50\text{MB}$ to zero large arrays.
- [ ] All new unit tests and all existing 521 tests pass with zero regressions.

## Risk Assessment
- Risk: Cutting surrogate pairs in half could cause Unicode replacement character (`\uFFFD`) corruption.
- Mitigation: Check `charCodeAt(sliceStart)` for low surrogates (`0xDC00 - 0xDFFF`) and increment index by 1 before slicing.

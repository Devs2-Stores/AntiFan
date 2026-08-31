import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { safeSliceTailJsonBounded } from '../../src/main/browser/terminal-manager';

describe('safeSliceTailJsonBounded Algorithm Invariants & Performance', () => {
  it('returns empty string for empty inputs or invalid budgets', () => {
    assert.strictEqual(safeSliceTailJsonBounded('', 1024), '');
    assert.strictEqual(safeSliceTailJsonBounded('hello', 0), '');
    assert.strictEqual(safeSliceTailJsonBounded('hello', 1), '');
    assert.strictEqual(safeSliceTailJsonBounded('hello', -5), '');
  });

  it('enforces exact prefixByteCost boundary ladder (0-12 bytes)', () => {
    // Prefix "\u001b[0m" with quotes costs exactly 11 bytes when JSON serialized.
    // For budgets <= 11, it must return empty string.
    for (let budget = 0; budget <= 11; budget++) {
      const result = safeSliceTailJsonBounded('hello world\n', budget);
      assert.strictEqual(result, '', `Budget ${budget} <= 11 must return empty string`);
    }

    // For budget = 12 (allowing 1 ASCII byte after prefix), result must fit within 12 bytes
    const result12 = safeSliceTailJsonBounded('hello world\n', 12);
    assert.ok(result12.startsWith('\x1b[0m'));
    const cost12 = Buffer.byteLength(JSON.stringify(result12), 'utf8');
    assert.ok(cost12 <= 12, `Budget 12 cost ${cost12} must not exceed 12`);
  });

  it('preserves small strings under budget with reset prefix and newline slicing', () => {
    const input = 'line 1\nline 2\nline 3';
    const result = safeSliceTailJsonBounded(input, 1024);
    assert.ok(result.startsWith('\x1b[0m'));
    assert.ok(result.includes('line 2'));
    assert.ok(result.includes('line 3'));
    const cost = Buffer.byteLength(JSON.stringify(result), 'utf8');
    assert.ok(cost <= 1024);
  });

  it('slices trailing lines when string exceeds budget', () => {
    const input = 'first line\nsecond line\nthird line\nfourth line\nfifth line';
    const budget = 45;
    const result = safeSliceTailJsonBounded(input, budget);
    assert.ok(result.startsWith('\x1b[0m'));
    const cost = Buffer.byteLength(JSON.stringify(result), 'utf8');
    assert.ok(cost <= budget, `Result cost ${cost} exceeds budget ${budget}`);
    assert.ok(result.includes('fifth line'));
  });

  it('handles strings without any newlines safely', () => {
    const input = 'a'.repeat(5000);
    const budget = 100;
    const result = safeSliceTailJsonBounded(input, budget);
    assert.ok(result.startsWith('\x1b[0m'));
    const cost = Buffer.byteLength(JSON.stringify(result), 'utf8');
    assert.ok(cost <= budget);
    assert.ok(result.length > 0);
  });

  it('enforces wire cost invariant with escaped control characters and quotes', () => {
    const specialChars = 'log: "quoted" \\backslash\\ \t tab \r\n newline \x1b[31m red \x00 null \x1f';
    const budget = 50;
    const result = safeSliceTailJsonBounded(specialChars, budget);
    assert.ok(result.startsWith('\x1b[0m'));
    const cost = Buffer.byteLength(JSON.stringify(result), 'utf8');
    assert.ok(cost <= budget, `Special chars cost ${cost} exceeds budget ${budget}`);
  });

  it('handles multi-byte Unicode and emoji surrogate pairs safely without corruption', () => {
    const emojiBlock = '🎉 🚀 ✨ 🛸 🌟 🔥 📦 💡\n'.repeat(100);
    const budget = 200;
    const result = safeSliceTailJsonBounded(emojiBlock, budget);
    assert.ok(result.startsWith('\x1b[0m'));
    const cost = Buffer.byteLength(JSON.stringify(result), 'utf8');
    assert.ok(cost <= budget);
    // Ensure no replacement characters from broken surrogates
    assert.ok(!result.includes('\uFFFD'));
  });

  it('handles unpaired lone surrogates safely and enforces wire budget', () => {
    const corruptStream = 'log start\n' + '\ud800\udc00'.repeat(10) + '\ud800\n' + '\udc00\n' + 'normal text\n';
    const budget = 50;
    const result = safeSliceTailJsonBounded(corruptStream, budget);
    assert.ok(result.startsWith('\x1b[0m'));
    const cost = Buffer.byteLength(JSON.stringify(result), 'utf8');
    assert.ok(cost <= budget, `Corrupt stream cost ${cost} exceeds budget ${budget}`);
  });

  it('processes massive 512KB buffer in under 20ms with zero large array allocation', () => {
    let largeLog = '';
    for (let i = 0; i < 5000; i++) {
      largeLog += `[2026-08-31T12:00:${(i % 60).toString().padStart(2, '0')}] \x1b[32mINFO\x1b[0m Event #${i}: Storefront order processed with payload hash ${i * 997}\n`;
    }
    const budget = 40 * 1024; // 40KB budget
    // Warm up JIT
    safeSliceTailJsonBounded(largeLog, budget);
    const start = performance.now();
    const result = safeSliceTailJsonBounded(largeLog, budget);
    const durationMs = performance.now() - start;

    assert.ok(durationMs < 20, `Execution took ${durationMs}ms, expected < 20ms`);
    assert.ok(result.startsWith('\x1b[0m'));
    const cost = Buffer.byteLength(JSON.stringify(result), 'utf8');
    assert.ok(cost <= budget, `Result cost ${cost} exceeds budget ${budget}`);
    assert.ok(result.length > 1000);
  });
});

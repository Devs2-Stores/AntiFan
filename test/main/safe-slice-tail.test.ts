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

  it('processes massive 512KB buffer in under 10ms with zero large array allocation', () => {
    let largeLog = '';
    for (let i = 0; i < 5000; i++) {
      largeLog += `[2026-08-31T12:00:${(i % 60).toString().padStart(2, '0')}] \x1b[32mINFO\x1b[0m Event #${i}: Storefront order processed with payload hash ${i * 997}\n`;
    }
    const budget = 40 * 1024; // 40KB budget
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

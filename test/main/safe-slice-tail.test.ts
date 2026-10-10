import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { safeSliceTail, safeSliceTailJsonBounded, SessionRecord } from '../../src/main/browser/terminal-manager';

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

  it('slices a 512KB buffer in under 5ms (best of 5) without per-character or rescanning work', () => {
    let largeLog = '';
    for (let i = 0; i < 5000; i++) {
      largeLog += `[2026-08-31T12:00:${(i % 60).toString().padStart(2, '0')}] \x1b[32mINFO\x1b[0m Event #${i}: Storefront order processed with payload hash ${i * 997}\n`;
    }
    const budget = 40 * 1024; // 40KB budget
    // Warm up JIT
    safeSliceTailJsonBounded(largeLog, budget);
    // Best of five: on a saturated lane one sample can absorb whole scheduler quanta
    // (measured up to 40 ms for a ~0.5 ms call), never all five. The minimum separates
    // cleanly: the shipped tail-bounded scan stays under 0.6 ms with every thread busy,
    // while per-character JSON.stringify over the input never drops below ~19 ms and a
    // stringify-per-line rescan takes seconds.
    let durationMs = Infinity;
    let result = '';
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      result = safeSliceTailJsonBounded(largeLog, budget);
      durationMs = Math.min(durationMs, performance.now() - start);
    }

    assert.ok(durationMs < 5, `Best of 5 took ${durationMs}ms, expected < 5ms`);
    assert.ok(result.startsWith('\x1b[0m'));
    const cost = Buffer.byteLength(JSON.stringify(result), 'utf8');
    assert.ok(cost <= budget, `Result cost ${cost} exceeds budget ${budget}`);
    assert.ok(result.length > 1000);
  });
});

describe('safeSliceTail on strings', () => {
  // The definition: the last maxBytes UTF-8 bytes of the whole string, moved
  // forward to a character boundary and then past a newline within 2KB.
  function byteTail(text: string, maxBytes: number): string {
    const buf = Buffer.from(text, 'utf8');
    if (buf.length <= maxBytes) return text;
    let cut = buf.length - maxBytes;
    while (cut < buf.length && (buf[cut]! & 0xc0) === 0x80) cut++;
    const nl = buf.indexOf(0x0a, cut);
    if (nl !== -1 && nl - cut < 2048) cut = nl + 1;
    return buf.subarray(cut).toString('utf8');
  }

  it('matches the whole-string byte tail across multibyte, surrogate and newline boundaries', () => {
    const pieces = ['a', '\n', 'é', '中', '😀', '\x1b[0m', '\ud800', '\udc00'];
    let seed = 7;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    for (let i = 0; i < 5000; i++) {
      let text = '';
      const len = rnd(300);
      for (let j = 0; j < len; j++) text += pieces[rnd(pieces.length)];
      const maxBytes = 1 + rnd(200);
      assert.strictEqual(safeSliceTail(text, maxBytes), byteTail(text, maxBytes), `case ${i} maxBytes ${maxBytes}`);
    }
  });
});

describe('SessionRecord.trimTail', () => {
  const record = () => new SessionRecord({ id: 'terminal-1', cwd: '.', capsuleId: 'c', sessionGeneration: 1 });

  it('keeps a suffix of the transcript within budget, cut on a character boundary', () => {
    const pieces = ['a', '\n', 'é', '中', '😀', '\x1b[0m'];
    let seed = 11;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    for (let i = 0; i < 2000; i++) {
      const s = record();
      let whole = '';
      const appends = 1 + rnd(40);
      for (let j = 0; j < appends; j++) {
        let text = '';
        const len = 1 + rnd(30);
        for (let k = 0; k < len; k++) text += pieces[rnd(pieces.length)];
        s.appendData(text);
        whole += text;
      }
      const maxBytes = 1 + rnd(400);
      s.trimTail(maxBytes);
      const kept = Buffer.concat(s.chunks);
      assert.strictEqual(s.bufferBytes, kept.length, `case ${i} byte count drifted`);
      assert.ok(kept.length <= maxBytes, `case ${i} over budget`);
      assert.ok(Buffer.from(whole, 'utf8').subarray(-kept.length || Infinity).equals(kept), `case ${i} not a suffix`);
      assert.ok(kept.length === 0 || (kept[0]! & 0xc0) !== 0x80, `case ${i} cut inside a character`);
    }
  });

  it('trims a transcript of tens of thousands of small PTY reads without per-chunk array copies', () => {
    const s = record();
    const line = 'y'.repeat(199) + '\n';
    const maxBytes = 4 * 1024 * 1024;
    while (s.bufferBytes <= maxBytes + 256 * 1024) s.appendData(line);
    const start = performance.now();
    s.trimTail(maxBytes);
    const durationMs = performance.now() - start;
    assert.ok(s.bufferBytes <= maxBytes);
    assert.ok(durationMs < 50, `trimTail over ${s.chunks.length} chunks took ${durationMs.toFixed(1)}ms`);
  });
});

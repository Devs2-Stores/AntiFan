import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { SessionDeliveryJournal } from '../../src/main/browser/terminal-manager';

describe('Phase T1.A: SessionDeliveryJournal & Bounded Eviction', () => {
  it('DELIVERY JOURNAL 1 (Basic Retrieval): appends and retrieves sequential delta correctly', () => {
    const journal = new SessionDeliveryJournal();
    const gen = 1;

    journal.append(gen, 1, 'chunk 1\n');
    journal.append(gen, 2, 'chunk 2\n');
    journal.append(gen, 3, 'chunk 3\n');

    // Retrieve from seq 2
    const delta = journal.getDelta(gen, 2);
    assert.strictEqual(delta.status, 'OK');
    if (delta.status === 'OK') {
      assert.strictEqual(delta.generation, 1);
      assert.strictEqual(delta.fromSeq, 2);
      assert.strictEqual(delta.throughSeq, 3);
      assert.strictEqual(delta.chunks.length, 2);
      assert.strictEqual(delta.chunks[0]?.seq, 2);
      assert.strictEqual(delta.chunks[0]?.data, 'chunk 2\n');
      assert.strictEqual(delta.chunks[1]?.seq, 3);
      assert.strictEqual(delta.chunks[1]?.data, 'chunk 3\n');
    }
  });

  it('DELIVERY JOURNAL 2 (Generation Mismatch): detects generation change and rejects query', () => {
    const journal = new SessionDeliveryJournal();
    journal.append(2, 1, 'gen 2 data');

    // Query asking for gen 1
    const delta = journal.getDelta(1, 1);
    assert.strictEqual(delta.status, 'GENERATION_MISMATCH');
    if (delta.status === 'GENERATION_MISMATCH') {
      assert.strictEqual(delta.currentGeneration, 2);
    }
  });

  it('DELIVERY JOURNAL 3 (Dual-bound Eviction by Chunks): retains maximum 4096 chunks', () => {
    const journal = new SessionDeliveryJournal();
    const gen = 1;
    const totalAppended = 5000;

    for (let i = 1; i <= totalAppended; i++) {
      journal.append(gen, i, `x`);
    }

    const range = journal.getRetainedRange();
    assert.ok(range.chunks <= 4096, `Retained chunks (${range.chunks}) must be <= 4096`);
    assert.strictEqual(range.throughSeq, 5000);
    // Since 5000 - 4096 + 1 = 905
    assert.strictEqual(range.fromSeq, 5000 - range.chunks + 1);

    // Asking for seq 1 must return DELTA_EXPIRED
    const expiredDelta = journal.getDelta(gen, 1);
    assert.strictEqual(expiredDelta.status, 'DELTA_EXPIRED');
    if (expiredDelta.status === 'DELTA_EXPIRED') {
      assert.strictEqual(expiredDelta.retainedFromSeq, range.fromSeq);
      assert.strictEqual(expiredDelta.retainedThroughSeq, 5000);
    }
  });

  it('DELIVERY JOURNAL 4 (Dual-bound Eviction by Bytes): caps buffer at 2 MiB', () => {
    const journal = new SessionDeliveryJournal();
    const gen = 1;
    // Append 3 chunks of 1 MiB each -> total 3 MiB, journal limit is 2 MiB
    const largeChunk = 'A'.repeat(1024 * 1024); // 1 MiB

    journal.append(gen, 1, largeChunk);
    journal.append(gen, 2, largeChunk);
    journal.append(gen, 3, largeChunk);

    const range = journal.getRetainedRange();
    assert.ok(range.bytes <= 2 * 1024 * 1024 + 1024, `Total bytes (${range.bytes}) must be <= 2 MiB`);
    // Chunk 1 should have been evicted
    assert.ok(range.fromSeq >= 2, `Evicted chunk 1, retained fromSeq should be >= 2`);

    const expired = journal.getDelta(gen, 1);
    assert.strictEqual(expired.status, 'DELTA_EXPIRED');
  });
});

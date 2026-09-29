import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutputBatcher } from '../../../src/main/terminal-daemon/output-batcher';
import type { TerminalDataPayload } from '../../../src/shared/contracts';

function harness() {
  let clock = 0;
  let pendingTimer: (() => void) | null = null;
  const out: TerminalDataPayload[] = [];
  const batcher = new OutputBatcher((p) => out.push(p), {
    flushMs: 8,
    maxChars: 10,
    now: () => clock,
    setTimer: (fn) => { pendingTimer = fn; return 1; },
    clearTimer: () => { pendingTimer = null; },
  });
  return {
    batcher,
    out,
    advance(ms: number) { clock += ms; },
    fire() { const fn = pendingTimer; pendingTimer = null; fn?.(); },
    timerArmed() { return pendingTimer !== null; },
  };
}

const chunk = (seq: number, data = 'x', generation = 1): TerminalDataPayload => ({ sessionId: 's1', data, seq, generation });

test('a chunk after a quiet flush window is emitted immediately so echo never waits', () => {
  const h = harness();
  h.batcher.push(chunk(1, 'a'));
  assert.deepEqual(h.out.map((p) => p.data), ['a']);
  h.advance(8);
  h.batcher.push(chunk(2, 'b'));
  assert.deepEqual(h.out.map((p) => p.data), ['a', 'b']);
  assert.equal(h.timerArmed(), false);
});

test('chunks inside the flush window coalesce into one payload with a contiguous seq range', () => {
  const h = harness();
  h.batcher.push(chunk(1, 'a'));
  h.advance(1);
  h.batcher.push(chunk(2, 'b'));
  h.batcher.push(chunk(3, 'c'));
  assert.equal(h.out.length, 1);
  h.fire();
  assert.deepEqual(h.out[1], { sessionId: 's1', data: 'bc', seq: 3, fromSeq: 2, throughSeq: 3, generation: 1 });
});

test('a batch reaching maxChars flushes without waiting for the timer', () => {
  const h = harness();
  h.batcher.push(chunk(1, 'a'));
  h.batcher.push(chunk(2, '12345'));
  h.batcher.push(chunk(3, '67890'));
  assert.equal(h.out.length, 2);
  assert.equal(h.out[1]?.data, '1234567890');
  assert.equal(h.out[1]?.throughSeq, 3);
});

test('a generation change emits the old batch first and never merges generations', () => {
  const h = harness();
  h.batcher.push(chunk(1, 'a', 1));
  h.batcher.push(chunk(2, 'b', 1));
  h.batcher.push(chunk(1, 'z', 2));
  h.fire();
  assert.deepEqual(h.out.slice(1).map((p) => [p.generation, p.fromSeq, p.throughSeq, p.data]), [[1, 2, 2, 'b'], [2, 1, 1, 'z']]);
});

test('already-coalesced input keeps its full range when merged', () => {
  const h = harness();
  h.batcher.push({ sessionId: 's1', data: 'ab', seq: 2, fromSeq: 1, throughSeq: 2, generation: 1 });
  h.batcher.push({ sessionId: 's1', data: 'cd', seq: 4, fromSeq: 3, throughSeq: 4, generation: 1 });
  h.batcher.push({ sessionId: 's1', data: 'ef', seq: 6, fromSeq: 5, throughSeq: 6, generation: 1 });
  h.fire();
  assert.deepEqual(h.out.map((p) => [p.fromSeq, p.throughSeq, p.seq, p.data]), [[1, 2, 2, 'ab'], [3, 6, 6, 'cdef']]);
});

test('sessions batch independently: a quiet session is not held behind a busy one', () => {
  const h = harness();
  h.batcher.push(chunk(1, 'a'));
  h.batcher.push(chunk(2, 'b'));
  h.batcher.push({ sessionId: 's2', data: 'k', seq: 1, generation: 1 });
  assert.deepEqual(h.out.map((p) => [p.sessionId, p.data]), [['s1', 'a'], ['s2', 'k']]);
});

test('flushSession and forget drain pending output before a lifecycle event without loss', () => {
  const h = harness();
  const sent = ['a', 'b', 'c', 'd'];
  sent.forEach((d, i) => h.batcher.push(chunk(i + 1, d)));
  h.batcher.flushSession('s1');
  assert.equal(h.out.map((p) => p.data).join(''), sent.join(''));
  assert.equal(h.out.at(-1)?.throughSeq, 4);
  assert.equal(h.timerArmed(), false);
  h.batcher.push(chunk(5, 'e'));
  h.batcher.forget('s1');
  assert.equal(h.out.map((p) => p.data).join(''), 'abcde');
  h.batcher.push(chunk(6, 'f'));
  assert.equal(h.out.at(-1)?.data, 'f', 'a forgotten session starts idle again');
});

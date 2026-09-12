/**
 * Phase T1.B: renderer gap state machine & bounded liveQueue.
 *
 * `src/renderer/standalone.js` is a plain renderer script, so these cases load it through the
 * shared vm harness (stubbed DOM, xterm, and preload bridge) and drive the shipped
 * `processIncomingChunk`. The transitions, queue bounds, delta requests, and pane writes
 * asserted here are the ones the renderer performs — no local re-implementation.
 *
 * The bounds are read back from the loaded script (`MAX_RECOVERY_QUEUE_BYTES`,
 * `MAX_RECOVERY_QUEUE_CHUNKS`), so a bound change in the renderer cannot silently pass.
 */
import { describe, it, before, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import { loadStandalone, createViewState, deltaChunks, FakeElement, FakeTerm, type StandaloneHarness, type Chunk, type DeltaResult } from './standalone-harness';

interface ViewState {
  id: string;
  term: FakeTerm;
  paneEl: FakeElement;
  lastRenderedSeq: number;
  sessionGeneration: number;
  liveQueue: Chunk[];
  syncState: string;
  isFetchingDelta: boolean;
  pendingWriteAckSeq: number;
  gapCount: number;
  resyncCount: number;
  degradedCount: number;
  activeHydratingEpoch: number | null;
}

describe('Phase T1.B: Renderer Gap State Machine & Bounded liveQueue', () => {
  let harness: StandaloneHarness;
  let processChunk: (viewState: ViewState, chunk: Chunk, isSplit: boolean) => Promise<void>;
  let deltaCalls: Array<{ sessionId: string; generation: number; fromSeq: number }>;

  const view = (overrides: Partial<ViewState> = {}): ViewState =>
    createViewState(overrides as Record<string, unknown>) as unknown as ViewState;

  before(() => {
    harness = loadStandalone();
    processChunk = harness.processIncomingChunk as unknown as typeof processChunk;
  });

  beforeEach(() => {
    deltaCalls = [];
    // The renderer captured the bridge object at load time; overrides land on the same instance.
    harness.api.getTerminalDelta = async () => null;
  });

  it('renders a contiguous stream without queueing', async () => {
    const viewState = view();
    await processChunk(viewState, { seq: 1, generation: 1, data: 'a' }, false);
    await processChunk(viewState, { seq: 2, generation: 1, data: 'b' }, false);
    await processChunk(viewState, { seq: 3, generation: 1, data: 'c' }, false);

    assert.strictEqual(viewState.lastRenderedSeq, 3);
    assert.strictEqual(viewState.pendingWriteAckSeq, 3);
    assert.strictEqual(viewState.syncState, 'READY');
    assert.strictEqual(viewState.gapCount, 0);
    assert.strictEqual(viewState.liveQueue.length, 0);
    assert.deepStrictEqual(viewState.term.writes, ['a', 'b', 'c']);
    assert.strictEqual(viewState.term.resetCount, 0);
  });

  it('drops duplicate and already-rendered sequences', async () => {
    const viewState = view();
    await processChunk(viewState, { seq: 1, generation: 1, data: 'a' }, false);
    await processChunk(viewState, { seq: 2, generation: 1, data: 'b' }, false);
    await processChunk(viewState, { seq: 2, generation: 1, data: 'b-replayed' }, false);
    await processChunk(viewState, { seq: 1, generation: 1, data: 'a-replayed' }, false);

    assert.deepStrictEqual(viewState.term.writes, ['a', 'b']);
    assert.strictEqual(viewState.lastRenderedSeq, 2);
    assert.strictEqual(viewState.gapCount, 0);
  });

  it('buffers every chunk while a hydration epoch is active and renders none of them', async () => {
    const viewState = view({ activeHydratingEpoch: 1 });
    await processChunk(viewState, { seq: 1, generation: 1, data: 'a' }, false);
    await processChunk(viewState, { seq: 2, generation: 1, data: 'b' }, false);

    assert.strictEqual(viewState.term.writes.length, 0);
    assert.strictEqual(viewState.liveQueue.length, 2);
    assert.strictEqual(viewState.lastRenderedSeq, 0);
  });

  it('resets the pane and clears the queue when the PTY generation leaps', async () => {
    const viewState = view({ lastRenderedSeq: 7, syncState: 'DEGRADED' });
    viewState.liveQueue.push({ seq: 99, generation: 1, data: 'stale' });
    viewState.paneEl.appendChild(new FakeElement('div')).className = 'terminal-degraded-banner';

    await processChunk(viewState, { seq: 1, generation: 2, data: 'new shell' }, false);

    assert.strictEqual(viewState.sessionGeneration, 2);
    assert.strictEqual(viewState.lastRenderedSeq, 1);
    assert.strictEqual(viewState.syncState, 'READY');
    assert.strictEqual(viewState.liveQueue.length, 0);
    assert.strictEqual(viewState.term.resetCount, 1, 'the stale transcript must be cleared from the pane');
    assert.deepStrictEqual(viewState.term.writes, ['new shell']);
    assert.strictEqual(
      viewState.paneEl.querySelectorAll('.terminal-degraded-banner').length,
      0,
      'a recovered pane must not keep the degraded banner',
    );
  });

  it('recovers a sequence gap through the delta API and drains the buffered chunk in order', async () => {
    const viewState = view({ sessionGeneration: 3, lastRenderedSeq: 100 });
    harness.api.getTerminalDelta = async (sessionId, generation, fromSeq) => {
      deltaCalls.push({ sessionId, generation, fromSeq });
      return { status: 'OK', chunks: deltaChunks(101, 150) };
    };

    await processChunk(viewState, { seq: 150, generation: 3, data: 'delta-150' }, false);

    assert.deepStrictEqual(deltaCalls, [{ sessionId: 'test-s1', generation: 3, fromSeq: 101 }]);
    assert.strictEqual(viewState.gapCount, 1);
    assert.strictEqual(viewState.resyncCount, 1);
    assert.strictEqual(viewState.syncState, 'READY');
    assert.strictEqual(viewState.lastRenderedSeq, 150);
    assert.strictEqual(viewState.liveQueue.length, 0);
    assert.strictEqual(viewState.term.writes[0], 'delta-101');
    assert.strictEqual(viewState.term.writes[viewState.term.writes.length - 1], 'delta-150');
    assert.strictEqual(viewState.term.writes.length, 50);
  });

  it('reaches the preload bridge for a gap without mutating global active-session state', async () => {
    deltaCalls.length = 0;
    const viewState = view({ lastRenderedSeq: 100 });

    harness.apiCalls.length = 0;
    await processChunk(viewState, { seq: 140, generation: 1, data: 'gap-140' }, false);

    assert.ok(
      harness.apiCalls.includes('getTerminalDelta'),
      `a gap must ask the bridge for the missing range, got: ${harness.apiCalls.join(', ')}`
    );
    // The singleton active tab must not be repointed by a popout renderer's own traffic.
    assert.strictEqual(harness.apiCalls.includes('setActiveTerminalSession'), false);
  });

  it('issues a single delta fetch and queues a repeated gap chunk once', async () => {
    const viewState = view({ lastRenderedSeq: 100 });

    const deltaGate = Promise.withResolvers<DeltaResult>();
    harness.api.getTerminalDelta = () => {
      deltaCalls.push({ sessionId: 'test-s1', generation: 1, fromSeq: 101 });
      return deltaGate.promise;
    };

    const pending = processChunk(viewState, { seq: 150, generation: 1, data: 'delta-150' }, false);
    await processChunk(viewState, { seq: 150, generation: 1, data: 'delta-150' }, false);

    assert.strictEqual(deltaCalls.length, 1, 'a chunk arriving during a fetch must not start a second fetch');
    assert.strictEqual(viewState.liveQueue.length, 1, 'the same sequence must not be queued twice');
    assert.strictEqual(viewState.gapCount, 2);

    deltaGate.resolve({ status: 'OK', chunks: deltaChunks(101, 150) });
    await pending;
    assert.strictEqual(viewState.liveQueue.length, 0);
    assert.strictEqual(viewState.lastRenderedSeq, 150);
    assert.strictEqual(viewState.syncState, 'READY');
  });

  it('halts rendering and reports DEGRADED when a gap chunk exceeds the queue bound', async () => {
    const viewState = view({ lastRenderedSeq: 100 });
    const oversized = 'x'.repeat(harness.maxQueueBytes + 1);

    let deltaFetches = 0;
    harness.api.getTerminalDelta = async () => {
      deltaFetches += 1;
      return null;
    };

    await processChunk(viewState, { seq: 150, generation: 1, data: oversized }, false);

    assert.strictEqual(viewState.syncState, 'DEGRADED');
    assert.strictEqual(viewState.degradedCount, 1);
    assert.strictEqual(viewState.liveQueue.length, 0);
    assert.strictEqual(viewState.term.writes.length, 0, 'a degraded pane renders nothing');
    assert.strictEqual(deltaFetches, 0, 'an oversized chunk must not trigger a delta fetch');
    assert.strictEqual(
      viewState.paneEl.querySelectorAll('.terminal-degraded-banner').length,
      1,
      'the pane must surface exactly one degraded banner',
    );

    await processChunk(viewState, { seq: 151, generation: 1, data: 'later' }, false);
    assert.strictEqual(viewState.liveQueue.length, 0);
    assert.strictEqual(viewState.term.writes.length, 0);
  });

  it('drains the buffer when no delta is available instead of degrading', async () => {
    const viewState = view();
    await processChunk(viewState, { seq: 5, generation: 1, data: 'chunk-5' }, false);

    assert.strictEqual(viewState.syncState, 'READY');
    assert.strictEqual(viewState.degradedCount, 0);
    assert.strictEqual(viewState.lastRenderedSeq, 5);
    assert.deepStrictEqual(viewState.term.writes, ['chunk-5']);
  });

  it('adopts the authoritative generation on GENERATION_MISMATCH and degrades on DELTA_EXPIRED', async () => {
    const mismatchState = view({ lastRenderedSeq: 100 });
    harness.api.getTerminalDelta = async () => ({ status: 'GENERATION_MISMATCH', currentGeneration: 9 });

    await processChunk(mismatchState, { seq: 150, generation: 1, data: 'gap' }, false);

    assert.strictEqual(mismatchState.sessionGeneration, 9);
    assert.strictEqual(mismatchState.lastRenderedSeq, 0);
    assert.strictEqual(mismatchState.syncState, 'READY');
    assert.strictEqual(mismatchState.liveQueue.length, 0);

    const expiredState = view({ lastRenderedSeq: 100 });
    harness.api.getTerminalDelta = async () => ({ status: 'DELTA_EXPIRED' });

    await processChunk(expiredState, { seq: 150, generation: 1, data: 'gap' }, false);

    assert.strictEqual(expiredState.syncState, 'DEGRADED');
    assert.strictEqual(expiredState.degradedCount, 1);
    assert.strictEqual(expiredState.liveQueue.length, 0);
  });
});

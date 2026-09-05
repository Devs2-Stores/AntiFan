import { describe, it } from 'node:test';
import * as assert from 'node:assert';

describe('Phase T1.B: Renderer Gap State Machine & Bounded liveQueue', () => {
  const MAX_RECOVERY_QUEUE_BYTES = 1024 * 1024; // 1 MiB
  const MAX_RECOVERY_QUEUE_CHUNKS = 2048;

  interface MockViewState {
    id: string;
    lastRenderedSeq: number;
    sessionGeneration: number;
    syncState: 'READY' | 'GAPPED' | 'RESYNCING' | 'DEGRADED';
    liveQueue: Array<{ seq: number; generation: number; data: string }>;
    gapCount: number;
    resyncCount: number;
    degradedCount: number;
    renderedChunks: string[];
    isFetchingDelta: boolean;
    pendingWriteAckSeq: number;
  }

  function createMockViewState(sessionId = 'test-s1'): MockViewState {
    return {
      id: sessionId,
      lastRenderedSeq: 0,
      sessionGeneration: 1,
      syncState: 'READY',
      liveQueue: [],
      gapCount: 0,
      resyncCount: 0,
      degradedCount: 0,
      renderedChunks: [],
      isFetchingDelta: false,
      pendingWriteAckSeq: 0,
    };
  }

  async function processChunkSim(
    viewState: MockViewState,
    chunk: { seq: number; generation: number; data: string },
    deltaProvider: (fromSeq: number) => Promise<Array<{ seq: number; data: string }> | null>
  ) {
    const chunkSeq = chunk.seq;
    const chunkData = chunk.data;

    if (viewState.syncState === 'DEGRADED') {
      return;
    }

    // Dedup
    if (chunkSeq > 0 && chunkSeq <= viewState.lastRenderedSeq) {
      return;
    }

    // In-order contiguous (next sequential chunk, or first chunk of fresh view)
    if (chunkSeq === viewState.lastRenderedSeq + 1 || (viewState.lastRenderedSeq === 0 && chunkSeq === 1)) {
      viewState.lastRenderedSeq = chunkSeq;
      viewState.pendingWriteAckSeq = chunkSeq;
      viewState.renderedChunks.push(chunkData);
      return;
    }

    // Gap detected
    viewState.gapCount++;
    const chunkBytes = Buffer.byteLength(chunkData, 'utf8');
    const currentQueueBytes = viewState.liveQueue.reduce((acc, c) => acc + Buffer.byteLength(c.data, 'utf8'), 0);

    if (
      currentQueueBytes + chunkBytes > MAX_RECOVERY_QUEUE_BYTES ||
      viewState.liveQueue.length >= MAX_RECOVERY_QUEUE_CHUNKS
    ) {
      viewState.syncState = 'DEGRADED';
      viewState.degradedCount++;
      viewState.liveQueue = [];
      return;
    }

    viewState.liveQueue.push(chunk);

    if (viewState.isFetchingDelta) {
      return;
    }

    viewState.isFetchingDelta = true;
    viewState.syncState = 'GAPPED';

    try {
      const fromSeq = viewState.lastRenderedSeq + 1;
      const deltaChunks = await deltaProvider(fromSeq);
      if (deltaChunks === null) {
        viewState.syncState = 'DEGRADED';
        viewState.degradedCount++;
        viewState.liveQueue = [];
        return;
      }

      viewState.syncState = 'RESYNCING';
      for (const dc of deltaChunks) {
        if (dc.seq === viewState.lastRenderedSeq + 1) {
          viewState.lastRenderedSeq = dc.seq;
          viewState.pendingWriteAckSeq = dc.seq;
          viewState.renderedChunks.push(dc.data);
        }
      }

      // Drain liveQueue
      viewState.liveQueue.sort((a, b) => a.seq - b.seq);
      while (viewState.liveQueue.length > 0) {
        const next = viewState.liveQueue[0];
        if (next && next.seq <= viewState.lastRenderedSeq) {
          viewState.liveQueue.shift();
        } else if (next && next.seq === viewState.lastRenderedSeq + 1) {
          viewState.liveQueue.shift();
          viewState.lastRenderedSeq = next.seq;
          viewState.pendingWriteAckSeq = next.seq;
          viewState.renderedChunks.push(next.data);
        } else {
          break;
        }
      }

      if (viewState.liveQueue.length === 0) {
        viewState.syncState = 'READY';
        viewState.resyncCount++;
      }
    } finally {
      viewState.isFetchingDelta = false;
    }
  }

  it('COMMIT 5 (Contiguous Stream): renders without gaps or queueing', async () => {
    const view = createMockViewState();
    const provider = async () => [];

    await processChunkSim(view, { seq: 1, generation: 1, data: 'line 1\n' }, provider);
    await processChunkSim(view, { seq: 2, generation: 1, data: 'line 2\n' }, provider);
    await processChunkSim(view, { seq: 3, generation: 1, data: 'line 3\n' }, provider);

    assert.strictEqual(view.lastRenderedSeq, 3);
    assert.strictEqual(view.syncState, 'READY');
    assert.strictEqual(view.gapCount, 0);
    assert.strictEqual(view.renderedChunks.length, 3);
  });

  it('COMMIT 5 (Sequence Jump & Delta Recovery): recovers from seq 100 to 150 gap', async () => {
    const view = createMockViewState();
    view.lastRenderedSeq = 100;

    // Simulate journal providing chunks 101 through 149
    const missingChunks: Array<{ seq: number; data: string }> = [];
    for (let i = 101; i <= 149; i++) {
      missingChunks.push({ seq: i, data: `recovered ${i}\n` });
    }

    const provider = async (fromSeq: number) => {
      return missingChunks.filter(c => c.seq >= fromSeq);
    };

    // Arrives chunk 150 -> triggers gap detection and resolution
    await processChunkSim(view, { seq: 150, generation: 1, data: 'live 150\n' }, provider);

    assert.strictEqual(view.lastRenderedSeq, 150);
    assert.strictEqual(view.syncState, 'READY');
    assert.strictEqual(view.gapCount, 1);
    assert.strictEqual(view.resyncCount, 1);
    // All 49 recovered + 1 live chunk = 50 chunks rendered in exact sequential order
    assert.strictEqual(view.renderedChunks.length, 50);
    assert.strictEqual(view.renderedChunks[0], 'recovered 101\n');
    assert.strictEqual(view.renderedChunks[48], 'recovered 149\n');
    assert.strictEqual(view.renderedChunks[49], 'live 150\n');
  });

  it('COMMIT 5 (Bounded Queue Overflow): rapid flood beyond 1 MiB halts queue and transitions to DEGRADED', async () => {
    const view = createMockViewState();
    view.lastRenderedSeq = 10;

    // Delta provider hangs or is disabled
    const provider = async () => null;

    // Send a 1.2 MiB burst chunk with seq gap (seq 20)
    const largeChunkData = 'B'.repeat(1024 * 1024 + 2048);
    await processChunkSim(view, { seq: 20, generation: 1, data: largeChunkData }, provider);

    assert.strictEqual(view.syncState, 'DEGRADED');
    assert.strictEqual(view.degradedCount, 1);
    assert.strictEqual(view.liveQueue.length, 0, 'Buffer must be cleared to prevent OOM');
  });

  it('COMMIT 5 (Cold Start Gap): fresh view (lastRenderedSeq=0) receiving chunk 5 heals gap 1..4 via delta and settles at 5', async () => {
    const view = createMockViewState();
    view.lastRenderedSeq = 0;

    const missingChunks = [
      { seq: 1, data: 'cold 1\n' },
      { seq: 2, data: 'cold 2\n' },
      { seq: 3, data: 'cold 3\n' },
      { seq: 4, data: 'cold 4\n' },
    ];

    const provider = async (fromSeq: number) => missingChunks.filter(c => c.seq >= fromSeq);

    // Arrives chunk 5 directly on fresh view
    await processChunkSim(view, { seq: 5, generation: 1, data: 'live 5\n' }, provider);

    assert.strictEqual(view.lastRenderedSeq, 5);
    assert.strictEqual(view.syncState, 'READY');
    assert.strictEqual(view.gapCount, 1);
    assert.strictEqual(view.renderedChunks.length, 5);
    assert.strictEqual(view.renderedChunks[0], 'cold 1\n');
    assert.strictEqual(view.renderedChunks[3], 'cold 4\n');
    assert.strictEqual(view.renderedChunks[4], 'live 5\n');
  });
});

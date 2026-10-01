/**
 * Degraded hydration + bounded gap recovery (Renderer).
 *
 * Regression coverage for "nội dung chat ngắn ngủn, không scroll lên được":
 *
 * - A hydration whose getFullBuffer fetch fails must NOT reset() a pane that
 *   already holds rendered content, must NOT touch lastRenderedSeq, and must
 *   keep every queued chunk live — the preview tail cannot replace real
 *   scrollback. The pane marks DEGRADED so the reader sees a resync path.
 * - A fresh pane (no rendered content) may still take the preview tail so it
 *   is not blank.
 * - A pane whose getTerminalDelta fails permanently must not retry the fetch
 *   forever — after the bound it degrades with its queue intact so an
 *   authoritative resync still owns recovery.
 * - forceResyncPane with a failed fetch must not reset() either.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  createViewState,
  FakeTerm,
  loadStandalone,
  type DeltaResult,
  type StandaloneHarness,
} from './standalone-harness';

const flush = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

/**
 * The view-state fields these tests touch. `createViewState` returns a plain
 * record; describing the shape once here keeps every read checked.
 */
interface PaneViewState {
  id: string;
  term: FakeTerm & { buffer?: { active: ContentfulBuffer } };
  paneEl: { querySelector: (selector: string) => unknown };
  liveQueue: unknown[];
  syncState: string;
  lastRenderedSeq: number;
  degradedCount: number;
  sessionGeneration: number;
  hydrationEpoch: number;
  activeHydratingEpoch: number | null;
}

interface ContentfulBuffer {
  length: number;
  viewportY: number;
  baseY: number;
  getLine: () => { translateToString: () => string };
}

/** Marker buffer reporting "this pane holds rendered content". */
const CONTENTFUL_BUFFER: ContentfulBuffer = {
  length: 40,
  viewportY: 0,
  baseY: 10,
  getLine: () => ({ translateToString: () => 'rendered transcript line' }),
};

function makePane(): PaneViewState {
  const record = createViewState({ term: new FakeTerm() });
  return record as unknown as PaneViewState;
}

const MANAGER_STATE = {
  projectWindow: { owner: { kind: 'unassigned' }, title: 'Unassigned' },
  terminalTabPrefs: { layout: 'sidebar', sidebarWidth: 240 },
};

async function loadManager(): Promise<StandaloneHarness> {
  const harness = loadStandalone({ initialState: MANAGER_STATE });
  await flush();
  return harness;
}

type HydrateFn = (item: PaneViewState, sessionId: string, snapshot?: string, seq?: number) => Promise<void>;
type GapFn = (viewState: PaneViewState, chunk: unknown, isSplit: boolean) => Promise<void>;
type ResyncFn = (viewState: PaneViewState, sessionId: string) => Promise<void>;

describe('degraded hydration keeps scrollback', () => {
  it('refuses to reset a contentful pane when getFullBuffer fails, and keeps liveQueue', async () => {
    const harness = await loadManager();
    const atomicHydratePane = harness.read<HydrateFn>('atomicHydratePane');

    const item = makePane();
    item.term.writes.push('existing history');
    item.term.buffer = { active: CONTENTFUL_BUFFER };

    const queued = { seq: 7, fromSeq: 7, throughSeq: 7, generation: 1, data: 'queued-bytes' };
    item.liveQueue.push(queued);

    harness.api.getFullBuffer = async () => {
      throw new Error('CHROME_SESSION_OUT_OF_SCOPE');
    };

    await atomicHydratePane(item, 'test-s1');

    assert.strictEqual(item.term.resetCount, 0, 'a preview-only hydrate must never reset a pane with history');
    assert.strictEqual(item.lastRenderedSeq, 0, 'lastRenderedSeq stays owned by the last authoritative sync');
    assert.strictEqual(item.liveQueue.length, 1, 'queued chunks survive for the next authoritative sync');
    assert.strictEqual(item.syncState, 'DEGRADED');
    assert.strictEqual(item.term.writes.length, 1, 'no preview tail is appended over history');
  });

  it('still hydrates a fresh pane from the preview tail when getFullBuffer fails', async () => {
    const harness = await loadManager();
    const atomicHydratePane = harness.read<HydrateFn>('atomicHydratePane');

    const item = makePane();
    harness.api.getFullBuffer = async () => {
      throw new Error('refused');
    };

    await atomicHydratePane(item, 'test-s1', 'preview-tail-text', 9);

    assert.ok(
      item.term.writes.some((w) => w.includes('preview-tail-text')),
      'an empty pane shows the preview tail rather than staying blank',
    );
    assert.strictEqual(item.lastRenderedSeq, 9, 'the preview seq owns the rendered edge');
    assert.strictEqual(item.syncState, 'READY', 'a fresh pane has nothing to lose — no degradation needed');
  });

  it('an authoritative hydrate resets and applies snapshotThroughSeq', async () => {
    const harness = await loadManager();
    const atomicHydratePane = harness.read<HydrateFn>('atomicHydratePane');

    const item = makePane();
    item.term.writes.push('existing history');
    item.term.buffer = { active: CONTENTFUL_BUFFER };

    harness.api.getFullBuffer = async () => ({
      buffer: 'full transcript content',
      snapshotThroughSeq: 42,
    });

    await atomicHydratePane(item, 'test-s1');

    assert.strictEqual(item.term.resetCount, 1, 'authoritative snapshot replaces the buffer');
    assert.ok(item.term.writes.some((w) => w.includes('full transcript content')));
    assert.strictEqual(item.lastRenderedSeq, 42);
  });

  it('bounds the gap-retry loop: a permanently failing delta fetch degrades with its queue intact', async () => {
    const harness = await loadManager();
    const handleSequenceGap = harness.read<GapFn>('handleSequenceGap');

    const viewState = makePane();
    harness.api.getTerminalDelta = async () => {
      throw new Error('scope refused');
    };
    // Sink retry timers: the bound is driven synchronously below, and real
    // timers would keep firing against this harness after the test ends.
    harness.assign("globalThis.__origSetTimeout = setTimeout; setTimeout = (fn) => 0;");

    try {
      // One real gap: chunk seq 3 while the rendered edge is 0.
      await handleSequenceGap(viewState, { seq: 3, generation: 1, data: 'gap-chunk' }, false);
      // assert.ok keeps syncState un-narrowed; strictEqual pins the 'GAPPED'
      // literal and breaks the loop condition's comparison type below.
      const gapState = viewState.syncState;
      assert.ok(gapState === 'GAPPED' || gapState === 'RESYNCING');
      assert.strictEqual(viewState.liveQueue.length, 1);

      // Drive the retry body directly (the timer tail re-enters this same
      // function); after the bound the pane must degrade, not spin.
      for (let i = 0; i < 30 && viewState.syncState !== 'DEGRADED'; i += 1) {
        await handleSequenceGap(viewState, null, false);
      }

      const boundState = viewState.syncState;
      assert.ok(boundState === 'DEGRADED', 'unanswered retries degrade instead of looping forever');
      assert.strictEqual(viewState.liveQueue.length, 1, 'the queued chunk is still owed to the reader');
      assert.ok(viewState.degradedCount >= 1);
    } finally {
      harness.assign("setTimeout = globalThis.__origSetTimeout;");
    }
  });

  it('clears the stale-generation queue and resets retries on GENERATION_MISMATCH', async () => {
    const harness = await loadManager();
    const handleSequenceGap = harness.read<GapFn>('handleSequenceGap');

    const viewState = makePane();
    harness.api.getTerminalDelta = async () => ({
      status: 'GENERATION_MISMATCH',
      currentGeneration: 2,
    });

    await handleSequenceGap(viewState, { seq: 5, generation: 1, data: 'stale-gen-chunk' }, false);

    assert.strictEqual(viewState.sessionGeneration, 2, 'the pane adopts the live generation');
    assert.strictEqual(viewState.liveQueue.length, 0, 'stale-generation chunks are dropped, never replayed');
    assert.strictEqual(viewState.lastRenderedSeq, 0);
    assert.strictEqual(viewState.syncState, 'READY');
  });

  it('recovers fully on the next authoritative resync after a degraded gap', async () => {
    const harness = await loadManager();
    const handleSequenceGap = harness.read<GapFn>('handleSequenceGap');
    const forceResyncPane = harness.read<ResyncFn>('forceResyncPane');

    const viewState = makePane();
    viewState.term.buffer = { active: CONTENTFUL_BUFFER };

    harness.api.getTerminalDelta = async () => {
      throw new Error('refused');
    };
    harness.api.getFullBuffer = async () => ({
      buffer: 'recovered transcript',
      snapshotThroughSeq: 30,
    });
    // Sink retry timers: retries are driven synchronously; real timers would
    // keep firing against this harness after the test ends.
    harness.assign("globalThis.__origSetTimeout = setTimeout; setTimeout = (fn) => 0;");

    try {
      await handleSequenceGap(viewState, { seq: 5, generation: 1, data: 'x' }, false);
      for (let i = 0; i < 30 && viewState.syncState !== 'DEGRADED'; i += 1) {
        await handleSequenceGap(viewState, null, false);
      }
      const degradedState = viewState.syncState;
      assert.ok(degradedState === 'DEGRADED');
      assert.ok(viewState.paneEl.querySelector('.terminal-degraded-banner'), 'the degraded banner is visible while the pane is degraded');

      await forceResyncPane(viewState, 'test-s1');

      assert.strictEqual(viewState.term.resetCount, 1);
      assert.ok(viewState.term.writes.some((w) => w.includes('recovered transcript')));
      assert.strictEqual(viewState.lastRenderedSeq, 30);
      const readyState = viewState.syncState;
      assert.ok(readyState === 'READY');
      assert.strictEqual(viewState.liveQueue.length, 0);
      assert.strictEqual(viewState.paneEl.querySelector('.terminal-degraded-banner'), null, 'a successful resync removes the degraded banner');
    } finally {
      harness.assign("setTimeout = globalThis.__origSetTimeout;");
    }
  });

  it('forceResyncPane with a failed fetch keeps the buffer and the banner', async () => {
    const harness = await loadManager();
    const forceResyncPane = harness.read<ResyncFn>('forceResyncPane');

    const viewState = makePane();
    viewState.term.writes.push('current content');
    viewState.syncState = 'DEGRADED';

    harness.api.getFullBuffer = async () => {
      throw new Error('still refused');
    };

    await forceResyncPane(viewState, 'test-s1');

    assert.strictEqual(viewState.term.resetCount, 0, 'a failed resync must not wipe the pane');
    assert.ok(viewState.term.writes.every((w) => w === 'current content'), 'no partial write landed');
    const stillDegraded: string = viewState.syncState;
    assert.strictEqual(stillDegraded, 'DEGRADED', 'stays degraded so the retry affordance remains');
  });

  it('a successful hydrate keeps transcripts far beyond the old 256 KiB window', async () => {
    const harness = await loadManager();
    const atomicHydratePane = harness.read<HydrateFn>('atomicHydratePane');

    const item = makePane();
    item.term.writes.push('existing');
    item.term.buffer = { active: CONTENTFUL_BUFFER };

    // ~600 KiB of transcript: comfortably past the old 256 KiB slice but cheap
    // to write in one go through the fake term.
    const line = 'x'.repeat(512) + '\n';
    const transcript = line.repeat(1200);

    harness.api.getFullBuffer = async () => ({ buffer: transcript, snapshotThroughSeq: 1200 });

    await atomicHydratePane(item, 'test-s1');

    assert.strictEqual(item.term.resetCount, 1, 'authoritative hydrate still rebuilds the pane');
    const written = item.term.writes.join('');
    assert.ok(written.includes(line.repeat(5).trimEnd()), 'written snapshot is the full tail, not a tiny preview');
    assert.ok(written.length >= transcript.length, 'no 256 KiB truncation on the hydration path');
    const readyState: string = item.syncState;
    assert.strictEqual(readyState, 'READY');
    assert.strictEqual(item.lastRenderedSeq, 1200);
  });

  it('a stale gap-retry timer cannot flip a resynced pane back to GAPPED', async () => {
    const harness = await loadManager();
    const handleSequenceGap = harness.read<GapFn>('handleSequenceGap');
    const forceResyncPane = harness.read<ResyncFn>('forceResyncPane');

    // Capture the retry timer instead of letting a real clock run: deterministic,
    // and we fire it explicitly after the resync has already recovered the pane.
    harness.assign("globalThis.__gapTimer = null; globalThis.__origSetTimeout = setTimeout; setTimeout = (fn) => { globalThis.__gapTimer = fn; return 0; };");

    const viewState = makePane();
    viewState.lastRenderedSeq = 5;

    try {
      harness.api.getTerminalDelta = async () => {
        throw new Error('refused');
      };
      await handleSequenceGap(viewState, { seq: 7, fromSeq: 7, throughSeq: 7, generation: 1, data: 'x' }, false);
      const gappedState: string = viewState.syncState;
      assert.strictEqual(gappedState, 'GAPPED');
      const timer = harness.read<(() => void) | null>('globalThis.__gapTimer');
      assert.ok(timer, 'a failed gap fetch must schedule the bounded retry timer');

      // Authoritative resync covers through seq 7 before the timer fires.
      harness.api.getFullBuffer = async () => ({ buffer: 'snapshot covering gap', snapshotThroughSeq: 7 });
      await forceResyncPane(viewState, 'test-s1');
      const recovered: string = viewState.syncState;
      assert.strictEqual(recovered, 'READY');

      let deltaCalls = 0;
      harness.api.getTerminalDelta = async () => {
        deltaCalls += 1;
        return null;
      };
      timer();

      const finalState: string = viewState.syncState;
      assert.strictEqual(finalState, 'READY', 'stale timer must not demote a recovered pane');
      assert.strictEqual(deltaCalls, 0, 'stale timer must not fire another delta fetch');
    } finally {
      harness.assign("setTimeout = globalThis.__origSetTimeout; globalThis.__gapTimer = null;");
    }
  });

  it('a delta fetch resolved after a resync commits nothing onto the new snapshot', async () => {
    const harness = await loadManager();
    const handleSequenceGap = harness.read<GapFn>('handleSequenceGap');
    const forceResyncPane = harness.read<ResyncFn>('forceResyncPane');

    const viewState = makePane();
    viewState.lastRenderedSeq = 5;

    // Hold the delta fetch open: resync lands while the old-cursor fetch is in
    // flight, so its late answer must not advance the cursor or write chunks.
    const gate = Promise.withResolvers<DeltaResult | null>();
    harness.api.getTerminalDelta = async () => gate.promise;
    const gapPromise = handleSequenceGap(viewState, { seq: 7, fromSeq: 7, throughSeq: 7, generation: 1, data: 'x' }, false);

    harness.api.getFullBuffer = async () => ({ buffer: 'authoritative snapshot', snapshotThroughSeq: 7 });
    await forceResyncPane(viewState, 'test-s1');
    assert.strictEqual(viewState.lastRenderedSeq, 7, 'resync owns the cursor now');

    // The stale fetch resolves afterwards. seq 8 is lastRenderedSeq+1 post-resync,
    // so the seq gate alone would accept it — only the epoch guard stops the write.
    gate.resolve({ status: 'OK', chunks: [{ seq: 8, data: 'stale-delta' }] });
    await gapPromise;

    assert.strictEqual(viewState.lastRenderedSeq, 7, 'stale delta must not advance the cursor past the snapshot');
    assert.ok(viewState.term.writes.every((w) => !w.includes('stale-delta')), 'stale delta must not write onto the new snapshot');
    const finalState: string = viewState.syncState;
    assert.strictEqual(finalState, 'READY', 'stale fetch must not demote or repend the pane');
  });

  it('a live chunk arriving during the resync fetch is replayed, not silently lost', async () => {
    const harness = await loadManager();
    const forceResyncPane = harness.read<ResyncFn>('forceResyncPane');
    const processIncomingChunk = harness.read<(vs: PaneViewState, chunk: unknown, isSplit: boolean) => Promise<void>>('processIncomingChunk');

    const viewState = makePane();
    viewState.term.buffer = { active: CONTENTFUL_BUFFER };
    viewState.syncState = 'DEGRADED';
    viewState.lastRenderedSeq = 5;
    viewState.sessionGeneration = 1;

    // getFullBuffer stays open; the live chunk seq 9 arrives mid-fetch with a
    // gap (6,7,8 never delivered). The snapshot covers through 7, leaving 8 and
    // 9 outstanding: 9 must stay queued for delta recovery, not dropped.
    const gate = Promise.withResolvers<unknown>();
    harness.api.getFullBuffer = async () => gate.promise;
    // The post-resync reconcile fires handleSequenceGap; hold its delta fetch
    // open so the queue/cursor assertions below are deterministic.
    const deltaGate = Promise.withResolvers<DeltaResult | null>();
    harness.api.getTerminalDelta = async () => deltaGate.promise;
    // Sink the retry that the reconcile may schedule — no real timer leaks.
    harness.assign("globalThis.__origSetTimeout = setTimeout; setTimeout = (fn) => 0;");
    try {
      const resyncPromise = forceResyncPane(viewState, 'test-s1');

      await processIncomingChunk(viewState, { seq: 9, generation: 1, data: 'live-during-resync' }, false);

      gate.resolve({ buffer: 'authoritative snapshot', snapshotThroughSeq: 7 });
      await resyncPromise;

      assert.strictEqual(viewState.lastRenderedSeq, 7);
      const retained = viewState.liveQueue.some((e) => (e as { seq?: number }).seq === 9);
      assert.ok(retained, 'the live chunk beyond snapshotThroughSeq must survive the queue filter');
      assert.ok(viewState.term.writes.every((w) => !w.includes('live-during-resync')), 'not yet rendered — gap at seq 8 still open');
      const finalState: string = viewState.syncState;
      assert.strictEqual(finalState, 'GAPPED', 'outstanding queue keeps the pane in gap recovery, not fake READY');
    } finally {
      harness.assign("setTimeout = globalThis.__origSetTimeout;");
      deltaGate.resolve(null);
    }
  });
});
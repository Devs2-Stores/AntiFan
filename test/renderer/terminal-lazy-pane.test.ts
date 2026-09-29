/**
 * Phase 7 — Renderer lazy xterm.
 *
 * Drives the real shipped `src/renderer/standalone.js` inside the shared vm
 * harness. Asserts the phase contract: output for a session with no pane costs
 * activity-indicator + ack only (zero xterm materialization), the lightweight
 * activity channel behaves identically, and activating a background session
 * hydrates the authoritative transcript then keeps applying live deltas.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { loadStandalone, type StandaloneHarness } from './standalone-harness';

const flush = async (times = 4): Promise<void> => {
  for (let i = 0; i < times; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
};

const ackCallsFor = (harness: StandaloneHarness, sessionId: string) =>
  harness.apiCallArgs.filter((call) => call.name === 'ackTerminalChunk' && (call.args[0] as { sessionId?: string })?.sessionId === sessionId);

/**
 * The renderer's ack queue flushes immediately at TERMINAL_ACK_FLUSH_COUNT (64)
 * pending chunks, so 64 chunks produce a deterministic synchronous ack — no
 * timer needed.
 */
const BURST = 64;

const makeSessions = (count: number, withBuffer = true) =>
  Array.from({ length: count }, (_v, i) => ({
    id: `bg-${i + 1}`,
    name: `Background ${i + 1}`,
    state: 'running',
    buffer: withBuffer ? `restored-tail-${i + 1}\n` : '',
    snapshotThroughSeq: 1,
  }));

describe('Renderer lazy xterm', () => {
  it('20 background sessions bursting on the data channel materialize zero panes', async () => {
    const harness = loadStandalone();
    await flush();

    const sessions = [{ id: 's-active', name: 'Active', state: 'running', buffer: 'active\n', snapshotThroughSeq: 1 }, ...makeSessions(20)];
    harness.setSessions(sessions);
    harness.setActiveId('s-active');
    harness.emitSession({ sessions, activeSessionId: 's-active' });
    await flush();

    const baseline = harness.terminals.length;

    for (let i = 1; i <= 20; i++) {
      for (let seq = 2; seq <= BURST + 1; seq++) {
        harness.emitData({ sessionId: `bg-${i}`, data: `burst ${i}.${seq}\n`, seq, generation: 1 });
      }
    }
    await flush();

    assert.strictEqual(
      harness.terminals.length,
      baseline,
      'a chunk for a session with no pane must never create an xterm',
    );

    const ackedSessions = new Set(
      harness.apiCallArgs
        .filter((c) => c.name === 'ackTerminalChunk')
        .map((c) => (c.args[0] as { sessionId?: string })?.sessionId),
    );
    for (let i = 1; i <= 20; i++) {
      assert.ok(ackedSessions.has(`bg-${i}`), `bg-${i} must keep acking so its subscriber row is not pruned`);
    }
  });

  it('the activity channel drives the tab indicator and ack without a pane', async () => {
    const harness = loadStandalone();
    await flush();

    const sessions = [
      { id: 's-active', name: 'Active', state: 'running', buffer: 'active\n', snapshotThroughSeq: 1 },
      { id: 'bg-1', name: 'Background', state: 'running', buffer: 'tail\n', snapshotThroughSeq: 1 },
    ];
    harness.setSessions(sessions);
    harness.setActiveId('s-active');
    harness.emitSession({ sessions, activeSessionId: 's-active' });
    await flush();
    const baseline = harness.terminals.length;

    for (let seq = 2; seq <= BURST + 1; seq++) {
      harness.emitActivity({ sessionId: 'bg-1', data: 'Claude: still working…\n', seq, generation: 1 });
    }
    await flush();

    assert.strictEqual(harness.terminals.length, baseline, 'activity must not materialize a pane');
    const wrap = harness.tabsRoot.querySelector('.terminal-tab-wrap[data-session-id="bg-1"]');
    assert.ok(wrap, 'tab wrap for bg-1 must exist');
    assert.strictEqual(wrap.classList.contains('is-streaming'), true, 'activity channel keeps the streaming indicator alive');

    assert.ok(ackCallsFor(harness, 'bg-1').length > 0, 'activity chunks still ack');
  });

  it('activating a background session hydrates the full transcript then applies live deltas', async () => {
    const fullBuffer = 'line-1\nline-2\nline-3\nauthoritative-tail\n';
    const harness = loadStandalone();
    await flush();
    // The authoritative transcript lives in main: getFullBuffer answers it.
    (harness.api as unknown as { getFullBuffer: unknown }).getFullBuffer = async () => ({
      buffer: fullBuffer,
      snapshotThroughSeq: 5,
    });

    const sessions = [
      { id: 's-active', name: 'Active', state: 'running', buffer: 'active\n', snapshotThroughSeq: 1 },
      { id: 'bg-1', name: 'Background', state: 'running', buffer: 'stale-slice\n', snapshotThroughSeq: 3 },
    ];
    harness.setSessions(sessions);
    harness.setActiveId('s-active');
    harness.emitSession({ sessions, activeSessionId: 's-active' });
    await flush();

    // Output accrues while no pane exists.
    for (let seq = 4; seq <= 5; seq++) {
      harness.emitData({ sessionId: 'bg-1', data: `while-hidden-${seq}\n`, seq, generation: 1 });
    }
    const paneCountBefore = harness.terminals.length;

    // User clicks the tab: main pushes the projection making bg-1 active.
    harness.emitSession({ sessions, activeSessionId: 'bg-1' });
    await flush(8);

    assert.strictEqual(harness.terminals.length, paneCountBefore + 1, 'activation materializes exactly one pane');
    const pane = harness.terminals[harness.terminals.length - 1]!;
    assert.strictEqual(
      pane.writes.join(''),
      fullBuffer,
      'opened pane must show the authoritative transcript, not the stale session slice',
    );

    // A live chunk after hydration appends by seq, not by re-hydrating.
    const writesAfterHydrate = pane.writes.length;
    harness.emitData({ sessionId: 'bg-1', data: 'live-delta\n', seq: 6, generation: 1 });
    await flush(8);
    assert.strictEqual(
      pane.writes.join(''),
      `${fullBuffer}live-delta\n`,
      'post-hydration output must append as a seq delta',
    );
    assert.ok(pane.writes.length <= writesAfterHydrate + 1, 'no transcript rewrite for a contiguous delta');
  });

  it('a broadcast row carrying only a preview tail hydrates through getFullBuffer', async () => {
    // Phase-6 wire shape: session rows in the broadcast are preview-only. The pane
    // must open with the authoritative transcript from the RPC channel, and the
    // preview must never appear on screen as if it were the whole buffer.
    const authoritative = `HEAD-OF-TRANSCRIPT\n${'mid-line\n'.repeat(40)}authoritative-tail\n`;
    const previewOnly = 'authoritative-tail\n'; // what a pruned row can carry
    const harness = loadStandalone();
    await flush();
    const fullBufferCalls: string[] = [];
    (harness.api as unknown as { getFullBuffer: unknown }).getFullBuffer = async (sessionId: string) => {
      fullBufferCalls.push(sessionId);
      return { buffer: authoritative, snapshotThroughSeq: 9 };
    };

    const sessions = [
      { id: 's-active', name: 'Active', state: 'running', buffer: 'active\n', snapshotThroughSeq: 1 },
      { id: 'bg-1', name: 'Background', state: 'running', buffer: previewOnly, bufferLength: authoritative.length, snapshotThroughSeq: 9, sessionGeneration: 1 },
    ];
    harness.setSessions(sessions);
    harness.setActiveId('s-active');
    harness.emitSession({ sessions, activeSessionId: 's-active' });
    await flush();

    harness.emitSession({ sessions, activeSessionId: 'bg-1' });
    await flush(8);

    assert.ok(fullBufferCalls.includes('bg-1'), 'activation must hydrate the pane from getFullBuffer');
    const pane = harness.terminals[harness.terminals.length - 1]!;
    const written = pane.writes.join('');
    assert.ok(written.includes('HEAD-OF-TRANSCRIPT'), 'the pane must show transcript content the broadcast no longer carries');
    assert.ok(written.includes('authoritative-tail'));
    assert.strictEqual(written, authoritative, 'the pane must write exactly the authoritative transcript — no preview doubling');
  });


  it('a known session that never got a pane still acks and does not create one on data', async () => {
    const harness = loadStandalone();
    await flush();

    const sessions = [
      { id: 's-active', name: 'Active', state: 'running', buffer: 'active\n', snapshotThroughSeq: 1 },
      { id: 'bg-1', name: 'Background', state: 'running', buffer: 'tail\n', snapshotThroughSeq: 1 },
    ];
    harness.setSessions(sessions);
    harness.setActiveId('s-active');
    harness.emitSession({ sessions, activeSessionId: 's-active' });
    await flush();
    const baseline = harness.terminals.length;

    for (let seq = 2; seq <= BURST + 1; seq++) {
      harness.emitData({ sessionId: 'bg-1', data: 'keystroke-echo\n', seq, generation: 1 });
    }
    await flush();

    assert.strictEqual(harness.terminals.length, baseline);
    assert.ok(ackCallsFor(harness, 'bg-1').length > 0);
  });
});

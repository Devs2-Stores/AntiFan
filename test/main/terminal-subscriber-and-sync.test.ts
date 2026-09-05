import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { TerminalManager } from '../../src/main/browser/terminal-manager';

describe('Phase T1.A & T1.B: Subscriber Registry, ACK Coalescing, and Sync View Handshake', () => {
  let tm: TerminalManager;

  before(() => {
    tm = TerminalManager.getInstance();
  });

  it('COMMIT 4 (Subscriber Registry & ACK): records subscriber ack and tracks watermark', () => {
    const rendererInstanceId = 'renderer-test-123';
    const sessionId = 'session-test-ack';

    tm.recordSubscriberAck({
      rendererInstanceId,
      sessionId,
      generation: 1,
      seq: 10,
      role: 'DOCK',
    });

    let subs = tm.getSubscribers();
    let found = subs.find(s => s.rendererInstanceId === rendererInstanceId && s.sessionId === sessionId);
    assert.ok(found, 'Subscriber must be registered');
    assert.strictEqual(found.lastAckedSeq, 10);
    assert.strictEqual(found.role, 'DOCK');

    // Watermark monotonic advance
    tm.recordSubscriberAck({
      rendererInstanceId,
      sessionId,
      generation: 1,
      seq: 25,
      role: 'DOCK',
    });

    subs = tm.getSubscribers();
    found = subs.find(s => s.rendererInstanceId === rendererInstanceId && s.sessionId === sessionId);
    assert.ok(found);
    assert.strictEqual(found.lastAckedSeq, 25);

    // Stale ACK (seq <= lastAckedSeq) must not regress watermark
    tm.recordSubscriberAck({
      rendererInstanceId,
      sessionId,
      generation: 1,
      seq: 15,
      role: 'DOCK',
    });

    subs = tm.getSubscribers();
    found = subs.find(s => s.rendererInstanceId === rendererInstanceId && s.sessionId === sessionId);
    assert.ok(found);
    assert.strictEqual(found.lastAckedSeq, 25, 'Watermark must not regress on delayed/stale ACK');
  });

  it('COMMIT 4 (Dead Subscriber Pruning): purges subscribers inactive for > maxAgeMs', () => {
    const rendererInstanceId = 'renderer-stale-999';
    const sessionId = 'session-stale';

    tm.recordSubscriberAck({
      rendererInstanceId,
      sessionId,
      generation: 1,
      seq: 5,
      role: 'POPOUT',
    });

    let subs = tm.getSubscribers();
    assert.ok(subs.some(s => s.rendererInstanceId === rendererInstanceId));

    // Fast-forward lastHeartbeatAt of this subscriber to 60s in the past
    const key = `${rendererInstanceId}:${sessionId}`;
    const privates = tm as unknown as { subscribers: Map<string, { lastHeartbeatAt: number }> };
    const sub = privates.subscribers.get(key);
    if (sub) {
      sub.lastHeartbeatAt = Date.now() - 60000;
    }

    // Now pruning with default maxAgeMs (30s) must evict this subscriber
    subs = tm.getSubscribers();
    assert.ok(!subs.some(s => s.rendererInstanceId === rendererInstanceId), 'Stale subscriber must be purged');
  });

  it('COMMIT 6 (Sync View Handshake): UP_TO_DATE when renderer is already caught up', () => {
    const sessionId = 'session-sync-uptodate';
    // Access private sessions to simulate state without spawning full node-pty
    const privates = tm as unknown as {
      sessions: Map<string, unknown>;
      sessionGenerations: Map<string, number>;
    };

    const mockSession = {
      id: sessionId,
      name: 'Test',
      cwd: 'E:\\Work',
      buffer: '',
      lastSeq: 50,
      sessionGeneration: 1,
      state: 'running',
      deliveryJournal: {
        getDelta: () => ({ status: 'OK', generation: 1, fromSeq: 51, throughSeq: 50, chunks: [] }),
      },
    };
    privates.sessions.set(sessionId, mockSession);

    const res = tm.syncTerminalView({
      sessionId,
      knownGeneration: 1,
      lastAppliedSeq: 50,
    });

    assert.strictEqual(res.status, 'UP_TO_DATE');
    if (res.status === 'UP_TO_DATE') {
      assert.strictEqual(res.generation, 1);
      assert.strictEqual(res.lastSeq, 50);
    }
  });

  it('COMMIT 6 (Sync View Handshake): DELTA returns missing chunks when behind', () => {
    const sessionId = 'session-sync-behind';
    const privates = tm as unknown as {
      sessions: Map<string, unknown>;
      sessionGenerations: Map<string, number>;
    };

    const mockSession = {
      id: sessionId,
      name: 'Test',
      cwd: 'E:\\Work',
      buffer: '',
      lastSeq: 55,
      sessionGeneration: 1,
      state: 'running',
      deliveryJournal: {
        getDelta: (_gen: number, fromSeq: number) => ({
          status: 'OK',
          generation: 1,
          fromSeq,
          throughSeq: 55,
          chunks: [
            { seq: 51, data: 'line 51\n' },
            { seq: 52, data: 'line 52\n' },
          ],
        }),
      },
    };
    privates.sessions.set(sessionId, mockSession);

    const res = tm.syncTerminalView({
      sessionId,
      knownGeneration: 1,
      lastAppliedSeq: 50,
    });

    assert.strictEqual(res.status, 'DELTA');
    if (res.status === 'DELTA') {
      assert.strictEqual(res.chunks.length, 2);
      assert.strictEqual(res.chunks[0]?.seq, 51);
    }
  });

  it('COMMIT 6 (Sync View Handshake): DELTA_EXPIRED when renderer applied seq was evicted', () => {
    const sessionId = 'session-sync-expired';
    const privates = tm as unknown as {
      sessions: Map<string, unknown>;
    };

    const mockSession = {
      id: sessionId,
      name: 'Test',
      cwd: 'E:\\Work',
      buffer: '',
      lastSeq: 5000,
      sessionGeneration: 1,
      state: 'running',
      deliveryJournal: {
        getDelta: () => ({
          status: 'DELTA_EXPIRED',
          generation: 1,
          retainedFromSeq: 2000,
          retainedThroughSeq: 5000,
        }),
      },
    };
    privates.sessions.set(sessionId, mockSession);

    const res = tm.syncTerminalView({
      sessionId,
      knownGeneration: 1,
      lastAppliedSeq: 500,
    });

    assert.strictEqual(res.status, 'DELTA_EXPIRED');
    if (res.status === 'DELTA_EXPIRED') {
      assert.strictEqual(res.retainedFromSeq, 2000);
      assert.strictEqual(res.retainedThroughSeq, 5000);
    }
  });

  it('COMMIT 6 (Sync View Handshake): GENERATION_CHANGED when session respawned', () => {
    const sessionId = 'session-sync-gen-change';
    const privates = tm as unknown as {
      sessions: Map<string, unknown>;
    };

    const mockSession = {
      id: sessionId,
      name: 'Test',
      cwd: 'E:\\Work',
      buffer: '',
      lastSeq: 10,
      sessionGeneration: 3,
      state: 'running',
      deliveryJournal: {
        getDelta: () => ({ status: 'OK', generation: 3, fromSeq: 1, throughSeq: 10, chunks: [] }),
      },
    };
    privates.sessions.set(sessionId, mockSession);

    const res = tm.syncTerminalView({
      sessionId,
      knownGeneration: 2, // Renderer thinks it is gen 2
      lastAppliedSeq: 5,
    });

    assert.strictEqual(res.status, 'GENERATION_CHANGED');
    if (res.status === 'GENERATION_CHANGED') {
      assert.strictEqual(res.currentGeneration, 3);
    }
  });

  after(() => {
    const privates = tm as unknown as {
      subscribers: Map<string, unknown>;
      sessions: Map<string, unknown>;
    };
    privates.subscribers.clear();
    privates.sessions.delete('session-test-ack');
    privates.sessions.delete('session-sync-1');
    privates.sessions.delete('session-sync-2');
    privates.sessions.delete('session-sync-3');
    privates.sessions.delete('session-sync-4');
  });
});

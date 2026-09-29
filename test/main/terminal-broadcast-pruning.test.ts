/**
 * Session Broadcast Pruning — the `'session'` projection and every session-list
 * answer carry preview tails (GLOBAL_JSON_BUFFER_BUDGET_BYTES, 16 KiB), never the
 * ≤160 KiB transcript slice the old wire budget allowed. Transcript content still
 * reaches consumers through the RPC channels that already own it: getFullBuffer,
 * getTerminalDelta, syncTerminalView, and the unpaged listSessions(false).
 *
 * Constructing SessionRecord rows directly keeps the test off the PTY path:
 * getSessionState()/listSessions() only read record fields.
 */
import { describe, it, after } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  TerminalManager,
  SessionRecord,
  GLOBAL_JSON_BUFFER_BUDGET_BYTES,
  ACTIVE_SNAPSHOT_BUDGET_BYTES,
} from '../../src/main/browser/terminal-manager';

const BIG_MARKER_HEAD = 'HEAD-MARKER-PRUNING';
const BIG_MARKER_TAIL = 'TAIL-MARKER-PRUNING';

/** A transcript comfortably larger than the entire preview wire budget. */
const BIG_TRANSCRIPT =
  `${BIG_MARKER_HEAD}\r\n` +
  'x'.repeat(GLOBAL_JSON_BUFFER_BUDGET_BYTES * 4) +
  `\r\n${BIG_MARKER_TAIL}\r\n`;

type ManagerInternals = {
  sessions: Map<string, SessionRecord>;
  activeSessionId: string;
};

function seedSession(tm: TerminalManager, id: string, transcript: string, seq: number): SessionRecord {
  const internals = tm as unknown as ManagerInternals;
  const record = new SessionRecord({
    id,
    cwd: 'E:/Work/project',
    capsuleId: 'capsule-test',
    sessionGeneration: 1,
    name: `Terminal ${id}`,
  });
  record.buffer = transcript;
  // Mirror the PTY data path, which journals every emitted chunk under its own
  // seq: splitting the transcript keeps the retention window starting at seq 1
  // so a pane resyncing from an early cursor is served, not expired.
  const mid = Math.floor(transcript.length / 2);
  record.lastSeq = seq;
  record.deliveryJournal.append(record.sessionGeneration, 1, transcript.slice(0, mid));
  record.deliveryJournal.append(record.sessionGeneration, seq, transcript.slice(mid));
  internals.sessions.set(id, record);
  return record;
}

describe('Session broadcast pruning', () => {
  const tm = TerminalManager.getInstance();

  after(async () => {
    await tm.dispose();
  });

  it('keeps the session projection under the preview wire budget while preserving seq cursors', () => {
    const internals = tm as unknown as ManagerInternals;
    const first = seedSession(tm, 'terminal-p1', BIG_TRANSCRIPT, 41);
    seedSession(tm, 'terminal-p2', 'small background tail\r\n', 3);
    seedSession(tm, 'terminal-p3', BIG_TRANSCRIPT, 87);
    internals.activeSessionId = 'terminal-p1';

    const state = tm.getSessionState();
    const wireBytes = Buffer.byteLength(JSON.stringify(state), 'utf8');

    // Roughly ten times less than the pre-pruning payload (160 KiB of tails plus
    // the same metadata) — and bounded even as sessions grow.
    assert.ok(wireBytes < 20 * 1024, `broadcast payload must stay under 20 KiB, got ${wireBytes}`);

    const activeRow = state.sessions.find((s) => s.id === 'terminal-p1');
    assert.ok(activeRow, 'the active session row must survive pruning');
    assert.ok(Buffer.byteLength(activeRow!.buffer, 'utf8') <= ACTIVE_SNAPSHOT_BUDGET_BYTES + 32,
      'the active preview is capped by the active snapshot budget');
    // The preview is a TAIL: the newest output stays visible (sleep preview,
    // hydration fallback) while the bulk of the transcript is served by RPC.
    assert.ok(activeRow!.buffer.includes(BIG_MARKER_TAIL), 'the preview must carry the newest output');
    assert.ok(!activeRow!.buffer.includes(BIG_MARKER_HEAD), 'the preview must not carry the full transcript');

    for (const row of state.sessions) {
      assert.ok(row.buffer.length <= GLOBAL_JSON_BUFFER_BUDGET_BYTES, `row ${row.id} exceeds the whole preview budget`);
      assert.ok(row.snapshotThroughSeq !== undefined && row.snapshotThroughSeq > 0,
        `row ${row.id} must keep its seq cursor so consumers can delta-resync`);
      assert.ok(row.bufferLength >= Buffer.byteLength(row.buffer, 'utf8') - 5,
        `row ${row.id} must declare its full retained length (the preview may prepend a 5-byte reset sequence)`);
    }
    assert.strictEqual(state.snapshotThroughSeq, first.lastSeq, 'the active seq cursor survives');
    assert.ok(state.snapshot.length <= GLOBAL_JSON_BUFFER_BUDGET_BYTES, 'the snapshot is a preview, not a full tail');
  });

  it('serves the content the broadcast no longer carries through the existing RPCs', () => {
    const internals = tm as unknown as ManagerInternals;
    const record = seedSession(tm, 'terminal-rpc', BIG_TRANSCRIPT, 9);
    internals.activeSessionId = 'terminal-rpc';

    // getFullBuffer: the authoritative transcript, head and tail intact.
    const full = tm.getFullBuffer('terminal-rpc');
    assert.ok(full.buffer.includes(BIG_MARKER_HEAD), 'getFullBuffer must return the whole transcript');
    assert.ok(full.buffer.includes(BIG_MARKER_TAIL));
    // getDelta: the same bytes a pane would resync from its seq cursor.
    const delta = tm.getTerminalDelta('terminal-rpc', record.sessionGeneration, 1);
    assert.strictEqual(delta.status, 'OK');
    const deltaText = ((delta.chunks || []) as Array<{ seq: number; data: string }>).map((c) => c.data).join('');
    assert.ok(deltaText.includes(BIG_MARKER_HEAD), 'getDelta must serve the retained bytes');
    assert.ok(deltaText.includes(BIG_MARKER_TAIL));

    // syncTerminalView: the renderer's hydration loop lands a DELTA, not a stub.
    const view = tm.syncTerminalView({
      sessionId: 'terminal-rpc',
      knownGeneration: record.sessionGeneration,
      lastAppliedSeq: 0,
    });
    assert.strictEqual(view.status, 'DELTA');
    const viewChunks = ((view as { chunks?: Array<{ seq: number; data: string }> }).chunks || []);
    const viewText = viewChunks.map((c) => c.data).join('');
    assert.ok(viewText.includes(BIG_MARKER_HEAD), 'syncTerminalView must stream the retained transcript');

    // The explicit non-paged listing still answers full transcripts for
    // main-process consumers (mobile never used it; the daemon facade cannot).
    const unpaged = tm.listSessions(false).find((s) => s.id === 'terminal-rpc');
    assert.ok(unpaged?.buffer.includes(BIG_MARKER_HEAD), 'listSessions(false) keeps the full transcript');
  });
});

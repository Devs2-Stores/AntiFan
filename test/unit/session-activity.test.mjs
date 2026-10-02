/**
 * SessionActivityTracker — the shared main/renderer state machine behind the
 * terminal tab strip and the session pet. Pins the classifier transitions and
 * the daemon-liveness hydration (`noteSleeping`/`noteRunning`) that rows from
 * pre-boot sessions depend on.
 *
 * Runs against the compiled module (`npm run compile` emits `.compiled/`),
 * this repo's convention for `.mjs` unit tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionActivityTracker,
  sessionActivityLevel,
} from '../../.compiled/src/shared/session-activity.js';

const WAIT_ON = '\x1b]777;antifan;wait=1';
const WAIT_OFF = '\x1b]777;antifan;wait=0';

function makeTracker() {
  const changes = [];
  const tracker = new SessionActivityTracker((id) => changes.push(id));
  return { tracker, changes };
}

describe('SessionActivityTracker', () => {
  it('classifies plain output as streaming, then completed after idle', async () => {
    const { tracker } = makeTracker();
    tracker.ingest('s1', 'building project...\n');
    assert.equal(sessionActivityLevel(tracker.sessions.get('s1')), 'streaming');

    await new Promise((r) => setTimeout(r, 5200)); // IDLE_MS = 5000
    assert.equal(sessionActivityLevel(tracker.sessions.get('s1')), 'completed');

    await new Promise((r) => setTimeout(r, 2200)); // DONE_HOLD_MS = 2000
    assert.equal(sessionActivityLevel(tracker.sessions.get('s1')), 'idle');
    tracker.dispose();
  });

  it('wait-alert OSC beats heuristics; wait-off clears it', () => {
    const { tracker, changes } = makeTracker();
    tracker.ingest('s1', WAIT_ON);
    assert.equal(sessionActivityLevel(tracker.sessions.get('s1')), 'waiting');
    tracker.ingest('s1', 'more output ' + WAIT_OFF);
    assert.equal(sessionActivityLevel(tracker.sessions.get('s1')), 'idle');
    assert.ok(changes.length >= 2);
    tracker.dispose();
  });

  it('noteExited settles a quiet session as completed', () => {
    const { tracker } = makeTracker();
    tracker.noteRunning('s1');
    tracker.noteExited('s1');
    assert.equal(sessionActivityLevel(tracker.sessions.get('s1')), 'completed');
    tracker.dispose();
  });

  it('sleeping is a presence level: weaker than streaming, cleared by output', () => {
    const { tracker } = makeTracker();
    tracker.noteSleeping('s1');
    assert.equal(sessionActivityLevel(tracker.sessions.get('s1')), 'sleeping');

    // Output revokes the flag and the chunk classifies normally.
    tracker.ingest('s1', 'Claude is Thinking...\n');
    const act = tracker.sessions.get('s1');
    assert.equal(act.isSleeping, false);
    assert.equal(sessionActivityLevel(act), 'streaming');
    tracker.dispose();
  });

  it('noteRunning creates an idle presence row and wakes sleepers', () => {
    const { tracker } = makeTracker();
    tracker.noteRunning('s1');
    assert.equal(sessionActivityLevel(tracker.sessions.get('s1')), 'idle');

    tracker.noteSleeping('s1');
    tracker.noteRunning('s1');
    assert.equal(sessionActivityLevel(tracker.sessions.get('s1')), 'idle');
    tracker.dispose();
  });

  it('noteClosed removes the row and its timers', () => {
    const { tracker } = makeTracker();
    tracker.ingest('s1', 'x\n');
    tracker.noteClosed('s1');
    assert.equal(tracker.sessions.has('s1'), false);
    tracker.dispose();
  });

  it('waiting outranks sleeping and completed in level order', () => {
    const { tracker } = makeTracker();
    tracker.noteSleeping('s1');
    tracker.ingest('s1', WAIT_ON);
    assert.equal(sessionActivityLevel(tracker.sessions.get('s1')), 'waiting');
    tracker.dispose();
  });

  it('noteWaiting marks a silent session waiting (authoritative run-card path)', () => {
    const { tracker, changes } = makeTracker();
    // Zero PTY output: the session only exists because a run card said so —
    // the ask-TUI case that output heuristics structurally miss.
    tracker.noteWaiting('s2', true);
    assert.equal(sessionActivityLevel(tracker.sessions.get('s2')), 'waiting');
    assert.deepEqual(changes, ['s2']);

    // Card back to running: the flag clears without inventing a row transition.
    tracker.noteWaiting('s2', false);
    assert.equal(tracker.sessions.get('s2').isWaiting, false);
    tracker.dispose();
  });

  it('a run card still waiting overrules a quiet AI tail the timer would call thinking', async () => {
    const { tracker } = makeTracker();
    tracker.ingest('s3', 'Claude is Thinking...\nSelect an option · ↑↓ move');
    // Output went quiet — the classifier would soon settle thinking/completed.
    // The authoritative card says the agent is parked on a question instead.
    tracker.noteWaiting('s3', true);
    assert.equal(sessionActivityLevel(tracker.sessions.get('s3')), 'waiting');
    tracker.dispose();
  });
});
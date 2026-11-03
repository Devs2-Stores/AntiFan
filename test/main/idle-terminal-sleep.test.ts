/**
 * Idle terminal sleep: sleeping kills the agent process, so only a finished agent that has been
 * silent for the whole period may be picked, never one that is working, waiting for an answer,
 * coordinating workers, or about to receive the next round from a live Leader.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  IDLE_SLEEP_AFTER_MS,
  selectIdleTerminals,
  type IdleSleepFacts,
  type IdleSleepRun,
  type IdleSleepSession,
} from '../../src/main/run/idle-terminal-sleep';

const NOW = 10 * IDLE_SLEEP_AFTER_MS;
const LONG_AGO = NOW - IDLE_SLEEP_AFTER_MS;
const RECENT = NOW - IDLE_SLEEP_AFTER_MS + 1;

function facts(overrides: Partial<IdleSleepFacts> & { sessions: IdleSleepSession[]; runs?: IdleSleepRun[] }): IdleSleepFacts {
  return {
    now: NOW,
    runs: [],
    lastOutputAt: () => LONG_AGO,
    isLeader: () => false,
    drivenByLiveLeader: () => false,
    ...overrides,
  };
}

const idleRun = (id: string, lastEventAt = LONG_AGO): IdleSleepRun => ({ terminalSessionId: id, state: 'idle', stale: false, lastEventAt });
const base = (id: string, extra: Partial<IdleSleepSession> = {}): IdleSleepSession => ({ id, state: 'running', ...extra });
const ids = (f: IdleSleepFacts) => selectIdleTerminals(f).map((p) => p.id);

describe('selectIdleTerminals', () => {
  it('picks a finished agent exactly at the idle threshold and reports how long it idled', () => {
    const picked = selectIdleTerminals(facts({ sessions: [base('t1')], runs: [idleRun('t1')] }));
    assert.deepEqual(picked, [{ id: 't1', idleMs: IDLE_SLEEP_AFTER_MS }]);
  });

  it('leaves an agent whose last event or last output is one millisecond short of the threshold', () => {
    assert.deepEqual(ids(facts({ sessions: [base('t1')], runs: [idleRun('t1', RECENT)] })), []);
    assert.deepEqual(ids(facts({ sessions: [base('t1')], runs: [idleRun('t1')], lastOutputAt: () => RECENT })), []);
  });

  it('never picks a running turn, an unanswered question, an ended or a dead agent', () => {
    for (const state of ['running', 'waiting_user', 'ended']) {
      const run = { ...idleRun('t1'), state };
      assert.deepEqual(ids(facts({ sessions: [base('t1')], runs: [run] })), [], state);
    }
    assert.deepEqual(ids(facts({ sessions: [base('t1')], runs: [{ ...idleRun('t1'), stale: true }] })), [], 'stale');
    assert.deepEqual(ids(facts({ sessions: [base('t1')], runs: [{ ...idleRun('t1'), lastEventAt: undefined }] })), [], 'no event time');
  });

  it('never touches a plain shell, a sleeping or exited terminal, or a split by itself', () => {
    assert.deepEqual(ids(facts({ sessions: [base('shell')] })), []);
    assert.deepEqual(ids(facts({ sessions: [base('t1', { state: 'sleeping' })], runs: [idleRun('t1')] })), []);
    assert.deepEqual(ids(facts({ sessions: [base('t1', { state: 'exited' })], runs: [idleRun('t1')] })), []);
    assert.deepEqual(ids(facts({ sessions: [base('t1'), base('p1', { splitOf: 't1' })], runs: [idleRun('p1')] })), []);
  });

  it('keeps Leaders and workers of a live Leader, but frees a worker whose Leader is gone', () => {
    const sessions = [base('lead'), base('worker'), base('orphan')];
    const runs = [idleRun('lead'), idleRun('worker'), idleRun('orphan')];
    const picked = ids(facts({
      sessions,
      runs,
      isLeader: (id) => id === 'lead',
      drivenByLiveLeader: (id) => id === 'worker',
    }));
    assert.deepEqual(picked, ['orphan']);
  });

  it('keeps a tab whose running pane is busy, is a watcher, runs no agent, or runs an agent that is not idle', () => {
    const sessions = [base('t1'), base('p1', { splitOf: 't1' })];
    assert.deepEqual(ids(facts({ sessions, runs: [idleRun('t1')], lastOutputAt: (id) => (id === 'p1' ? RECENT : LONG_AGO) })), [], 'pane output');
    assert.deepEqual(ids(facts({ sessions: [base('t1'), base('p1', { splitOf: 't1', idlePolicy: 'never' })], runs: [idleRun('t1')] })), [], 'watcher pane');
    assert.deepEqual(ids(facts({ sessions, runs: [idleRun('t1'), { ...idleRun('p1'), state: 'running' }] })), [], 'busy pane agent');
    assert.deepEqual(ids(facts({ sessions, runs: [idleRun('t1')] })), [], 'a quiet pane without an agent may be a silent dev server');
    assert.deepEqual(ids(facts({ sessions, runs: [idleRun('t1'), idleRun('p1')] })), ['t1'], 'a pane whose own agent is idle goes with its tab');
    assert.deepEqual(ids(facts({ sessions: [base('t1'), base('p1', { splitOf: 't1', state: 'exited' })], runs: [idleRun('t1')], lastOutputAt: (id) => (id === 'p1' ? RECENT : LONG_AGO) })), ['t1'], 'an exited pane does not hold the tab');
  });

  it('keeps a watcher base terminal', () => {
    assert.deepEqual(ids(facts({ sessions: [base('t1', { idlePolicy: 'never' })], runs: [idleRun('t1')] })), []);
  });
});

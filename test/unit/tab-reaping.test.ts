import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldReapAgentTab, AGENT_TAB_IDLE_MS } from '../../src/main/browser/tab-reaping';

const NOW = 10_000_000;
const OLD = NOW - AGENT_TAB_IDLE_MS - 1;
const tab = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  id: 't1',
  state: { offscreen: true, ...over } as never,
  lastActiveAt: OLD,
  ...extra,
});
const ctx = (over: Record<string, unknown> = {}) => ({ claimedTabIds: new Set<string>(), now: NOW, ...over });

test('unclaimed idle offscreen tab is reaped', () => {
  assert.deepEqual(shouldReapAgentTab(tab(), ctx()), { reap: true });
});

test('visible (non-offscreen) tab is never reaped, even ephemeral', () => {
  const d = shouldReapAgentTab(tab({ offscreen: false, ephemeral: true }), ctx());
  assert.deepEqual(d, { reap: false, reason: 'not-agent-plane' });
});

test('claimed tab is protected', () => {
  const d = shouldReapAgentTab(tab(), ctx({ claimedTabIds: new Set(['t1']) }));
  assert.deepEqual(d, { reap: false, reason: 'claimed' });
});

test('in-flight agent work and close reservation veto', () => {
  assert.deepEqual(shouldReapAgentTab(tab(), ctx({ agentWorkingTabIds: new Set(['t1']) })), { reap: false, reason: 'agent-working' });
  assert.deepEqual(shouldReapAgentTab(tab(), ctx({ reservedForCloseTabIds: new Set(['t1']) })), { reap: false, reason: 'reserved-for-close' });
});

test('recent agent activity keeps an unclaimed tab alive even when mint time is old', () => {
  const d = shouldReapAgentTab(tab({}, { agentActivityAt: NOW - 1000 }), ctx());
  assert.deepEqual(d, { reap: false, reason: 'not-idle' });
});

test('freshly minted tab is inside the bind grace window', () => {
  const d = shouldReapAgentTab(tab({}, { lastActiveAt: NOW - 1000 }), ctx());
  assert.deepEqual(d, { reap: false, reason: 'not-idle' });
});

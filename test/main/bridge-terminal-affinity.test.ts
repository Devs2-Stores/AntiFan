/**
 * Bridge mint-host resolver — the per-project-window routing truth table.
 *
 * `createBridgeMintHostResolver` (src/main/index.ts) is the factory the shipping
 * bridge installs: every mint an agent asks for routes through it. The routing
 * contract, pinned here over injected deps:
 *
 *   boundTabId (live)            -> that tab's own host and capsule
 *   terminalSessionId:
 *     project:<id> owner key     -> that project's window (reopened once when closed)
 *     project window unreachable -> TERMINAL_SCOPE_UNRESOLVED, never the ambient window
 *     malformed owner key        -> TERMINAL_SCOPE_UNRESOLVED
 *     unassigned / unclaimed     -> the ambient window (TARGET_REQUIRED when several are live)
 *   projectId (fresh provision)  -> that project's window (reopened once) or a typed refusal
 *   no claim                     -> the ambient window
 *
 * The behaviour this file exists to protect: a `project:` claim whose window cannot be
 * reached never lands in another project's window.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { installElectronStub } from '../support/electron-stub';
installElectronStub();

import { CapabilityError } from '../../src/shared/control-plane-contracts';
import { DEFAULT_TERMINAL_CAPSULE_ID } from '../../src/main/browser/terminal-manager';
import {
  createBridgeMintHostResolver,
  type BridgeMintResolverDeps,
} from '../../src/main/index';
import type { BridgeMintTargetRequest } from '../../src/main/bridge/bridge-server';
import type { NativeTabHost } from '../../src/main/browser/native-tab-host';

/** A sentinel host — only `getTabCapsuleId` is ever read, on the bound-tab arm. */
function fakeHost(name: string, capsuleByTab: Record<string, string> = {}): NativeTabHost {
  return {
    name,
    getTabCapsuleId: (tabId?: string | null) => (tabId ? capsuleByTab[tabId] : undefined),
  } as unknown as NativeTabHost;
}

/**
 * The world the resolver reads: `hosts` keys are owner keys ('project:x'); `tabHosts` maps
 * tab ids on the bound-tab arm; `capsules` is the live capsule store; `projectCapsules` is
 * each project's validated claim; `reopenable` is the hosts a reopen attempt can produce.
 */
function makeResolver(opts: {
  hosts?: Record<string, NativeTabHost>;
  tabHosts?: Record<string, NativeTabHost>;
  ownerKeys?: Record<string, string | undefined>;
  capsules?: Record<string, string | undefined>;
  capsuleProjects?: Record<string, string | undefined>;
  liveCapsules?: readonly string[];
  projectCapsules?: Record<string, string | undefined>;
  reopenable?: Record<string, NativeTabHost>;
  reopenThrows?: Record<string, string>;
  ambient?: NativeTabHost | CapabilityError;
}) {
  const hosts = opts.hosts ?? {};
  const state = { reopens: [] as string[], ambientAsks: 0 };
  const deps: BridgeMintResolverDeps = {
    hostForTab: (tabId) => (opts.tabHosts ?? {})[tabId] ?? null,
    hostForOwnerKey: (ownerKeyValue) => hosts[ownerKeyValue] ?? null,
    sessionCapsuleId: (id) => (opts.capsules ?? {})[id],
    sessionOwnerKey: (id) => (opts.ownerKeys ?? {})[id],
    capsuleExists: (capsuleId) => (opts.liveCapsules ?? []).includes(capsuleId),
    projectCapsuleId: (projectId) => (opts.projectCapsules ?? {})[projectId],
    capsuleProjectId: (capsuleId) => (opts.capsuleProjects ?? {})[capsuleId],
    ensureProjectHost: async (projectId) => {
      state.reopens.push(projectId);
      const failure = (opts.reopenThrows ?? {})[projectId];
      if (failure) throw new Error(failure);
      const host = (opts.reopenable ?? {})[projectId] ?? null;
      if (host) hosts[`project:${projectId}`] = host;
      return host;
    },
    ambientHost: () => {
      state.ambientAsks += 1;
      const ambient = opts.ambient ?? fakeHost('ambient');
      if (ambient instanceof CapabilityError) throw ambient;
      return ambient;
    },
  };
  return { resolve: createBridgeMintHostResolver(deps), hosts, state };
}

async function assertUnresolved(fn: () => Promise<unknown>, match: RegExp | string): Promise<CapabilityError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof CapabilityError, `expected CapabilityError, got ${String(err)}`);
    assert.equal(err.code, 'TERMINAL_SCOPE_UNRESOLVED', `unexpected refusal code: ${String(err.message)}`);
    if (match instanceof RegExp) assert.match(err.message, match);
    else assert.ok(err.message.includes(match), `message did not contain ${JSON.stringify(match)}: ${err.message}`);
    return err;
  }
  assert.fail('the mint was not refused');
}

describe('bridge mint resolver — terminal arm', () => {
  const ambient = fakeHost('ambient');
  const projectHost = fakeHost('project-window');

  it('routes a bound tab to the host that owns it, capsule included', async () => {
    const tabbed = fakeHost('tab-owner', { 'tab-1': 'capsule-tab' });
    const { resolve } = makeResolver({ tabHosts: { 'tab-1': tabbed } });
    const out = await resolve({ boundTabId: 'tab-1', terminalSessionId: 'term-ignored' });
    assert.equal(out?.host, tabbed);
    assert.equal(out?.capsuleId, 'capsule-tab');
  });

  it('stamps a bound-tab mint with the project of the tab\'s capsule', async () => {
    const tabbed = fakeHost('tab-owner', { 'tab-1': 'capsule-united' });
    const { resolve } = makeResolver({ tabHosts: { 'tab-1': tabbed }, capsuleProjects: { 'capsule-united': 'p-united' } });
    const out = await resolve({ boundTabId: 'tab-1' });
    assert.equal(out?.host, tabbed);
    assert.equal(out?.projectId, 'p-united');
  });

  it('routes a project-owned terminal to its live window, pinned to the stamped live capsule', async () => {
    const { resolve, state } = makeResolver({
      hosts: { 'project:p-1': projectHost },
      ownerKeys: { 'term-1': 'project:p-1' },
      capsules: { 'term-1': 'capsule-live' },
      liveCapsules: ['capsule-live'],
      projectCapsules: { 'p-1': 'capsule-p1' },
      ambient,
    });
    const out = await resolve({ terminalSessionId: 'term-1' });
    assert.equal(out?.host, projectHost);
    assert.equal(out?.capsuleId, 'capsule-live', 'the stamped live capsule did not win');
    assert.deepEqual(state.reopens, [], 'a live window was reopened');
    assert.equal(state.ambientAsks, 0, 'a project claim consulted the ambient window');
  });

  it('pins a project-owned terminal to the project capsule when it carries no stamp', async () => {
    const { resolve } = makeResolver({
      hosts: { 'project:p-1': projectHost },
      ownerKeys: { 'term-1': 'project:p-1' },
      projectCapsules: { 'p-1': 'capsule-p1' },
    });
    const out = await resolve({ terminalSessionId: 'term-1' });
    assert.equal(out?.host, projectHost);
    assert.equal(out?.capsuleId, 'capsule-p1');
  });

  it('stamps the mint with the terminal\'s own project', async () => {
    const { resolve } = makeResolver({
      hosts: { 'project:p-united': projectHost },
      ownerKeys: { 'term-9': 'project:p-united' },
      projectCapsules: { 'p-united': 'capsule-united' },
      capsuleProjects: { 'capsule-united': 'p-united' },
    });
    const out = await resolve({ terminalSessionId: 'term-9' });
    assert.equal(out?.host, projectHost);
    assert.equal(out?.projectId, 'p-united');
  });

  it('stamps a capsule-pinned terminal that no project claims with the capsule\'s project', async () => {
    const { resolve } = makeResolver({
      ownerKeys: { 'term-un': 'unassigned' },
      capsules: { 'term-un': 'capsule-united' },
      liveCapsules: ['capsule-united'],
      capsuleProjects: { 'capsule-united': 'p-united' },
      ambient,
    });
    const out = await resolve({ terminalSessionId: 'term-un' });
    assert.equal(out?.host, ambient);
    assert.equal(out?.capsuleId, 'capsule-united');
    assert.equal(out?.projectId, 'p-united');
  });

  it('stamps nothing when no project can be proven', async () => {
    const { resolve } = makeResolver({ ownerKeys: { 'term-un': 'unassigned' }, ambient });
    const out = await resolve({ terminalSessionId: 'term-un' });
    assert.equal(out?.host, ambient);
    assert.equal('projectId' in (out ?? {}), false);
  });

  it('drops the default sentinel stamp and re-pins the project capsule', async () => {
    const { resolve } = makeResolver({
      hosts: { 'project:p-s': projectHost },
      ownerKeys: { 'term-sentinel': 'project:p-s' },
      capsules: { 'term-sentinel': DEFAULT_TERMINAL_CAPSULE_ID },
      liveCapsules: [DEFAULT_TERMINAL_CAPSULE_ID, 'capsule-ps'],
      projectCapsules: { 'p-s': 'capsule-ps' },
    });
    const out = await resolve({ terminalSessionId: 'term-sentinel' });
    assert.equal(out?.host, projectHost);
    assert.equal(out?.capsuleId, 'capsule-ps', 'the sentinel survived as a capsule pin');
  });

  it('drops a stale stamped capsule no live store carries, then re-pins the project capsule', async () => {
    const { resolve } = makeResolver({
      hosts: { 'project:p-stale': projectHost },
      ownerKeys: { 'term-stale': 'project:p-stale' },
      capsules: { 'term-stale': 'capsule-that-died' },
      projectCapsules: { 'p-stale': 'capsule-pstale' },
    });
    const out = await resolve({ terminalSessionId: 'term-stale' });
    assert.equal(out?.host, projectHost);
    assert.equal(out?.capsuleId, 'capsule-pstale');
  });

  it('reopens a closed project window once and mints on it', async () => {
    const reopened = fakeHost('reopened');
    const { resolve, state } = makeResolver({
      ownerKeys: { 'term-1': 'project:p-closed' },
      projectCapsules: { 'p-closed': 'capsule-pclosed' },
      capsuleProjects: { 'capsule-pclosed': 'p-closed' },
      reopenable: { 'p-closed': reopened },
      ambient,
    });
    const out = await resolve({ terminalSessionId: 'term-1' });
    assert.deepEqual(state.reopens, ['p-closed']);
    assert.equal(out?.host, reopened);
    assert.equal(out?.capsuleId, 'capsule-pclosed');
    assert.equal(out?.projectId, 'p-closed');
    assert.equal(state.ambientAsks, 0, 'a reopened mint re-homed onto the ambient window');
  });

  it('refuses with a not-admitted reason when the reopen declines, never borrowing the ambient window', async () => {
    const { resolve, state } = makeResolver({
      ownerKeys: { 'term-1': 'project:p-gone' },
      ambient,
    });
    const err = await assertUnresolved(() => resolve({ terminalSessionId: 'term-1' }), 'no window owns that claim');
    const details = err.details as Record<string, unknown>;
    assert.equal(details.reason, 'not-admitted');
    assert.equal(typeof details.recovery, 'string');
    assert.equal(details.projectId, 'p-gone');
    assert.equal(state.ambientAsks, 0);
  });

  it('turns a throwing reopen into a typed refusal carrying the cause', async () => {
    const { resolve } = makeResolver({
      ownerKeys: { 'term-1': 'project:p-gone' },
      reopenThrows: { 'p-gone': 'window manager is not up yet' },
    });
    const err = await assertUnresolved(() => resolve({ terminalSessionId: 'term-1' }), 'no window owns that claim');
    const details = err.details as Record<string, unknown>;
    assert.equal(details.reason, 'restore-failed');
    assert.equal(details.cause, 'window manager is not up yet');
  });

  it('never reopens a window for a project whose window is live', async () => {
    const { resolve, state } = makeResolver({
      hosts: { 'project:p-live': projectHost },
      ownerKeys: { 'term-live': 'project:p-live' },
    });
    const out = await resolve({ terminalSessionId: 'term-live' });
    assert.equal(out?.host, projectHost);
    assert.deepEqual(state.reopens, []);
  });

  it('refuses a malformed owner key instead of minting into the ambient window', async () => {
    const { resolve, state } = makeResolver({ ownerKeys: { 'term-bad': 'project:' }, ambient });
    await assertUnresolved(() => resolve({ terminalSessionId: 'term-bad' }), 'no window owns that claim');
    assert.equal(state.ambientAsks, 0);
  });

  it('an unattributed terminal answers on the ambient window with no capsule pin', async () => {
    const { resolve } = makeResolver({ ownerKeys: {}, ambient });
    const out = await resolve({ terminalSessionId: 'term-free' });
    assert.equal(out?.host, ambient);
    assert.equal(out?.capsuleId, undefined);
  });

  it('an unassigned-owned terminal answers on the ambient window', async () => {
    const { resolve } = makeResolver({ ownerKeys: { 'term-mgr': 'unassigned' }, ambient });
    assert.equal((await resolve({ terminalSessionId: 'term-mgr' }))?.host, ambient);
  });

  it('propagates the ambient window\'s TARGET_REQUIRED refusal when several windows could answer', async () => {
    const ambiguous = new CapabilityError('TARGET_REQUIRED', 'TARGET_REQUIRED: 2 project windows are live');
    const { resolve } = makeResolver({ ownerKeys: { 'term-free': 'unassigned' }, ambient: ambiguous });
    await assert.rejects(() => resolve({ terminalSessionId: 'term-free' }), (err: unknown) => {
      assert.ok(err instanceof CapabilityError);
      assert.equal(err.code, 'TARGET_REQUIRED');
      return true;
    });
  });
});

describe('bridge mint resolver — projectId arm', () => {
  const projectHost = fakeHost('project-window');

  it('mints a fresh provision on the project\'s live window, capsule pinned', async () => {
    const { resolve, state } = makeResolver({
      hosts: { 'project:p-live': projectHost },
      projectCapsules: { 'p-live': 'capsule-live-p' },
    });
    const out = await resolve({ projectId: 'p-live' });
    assert.equal(out?.host, projectHost);
    assert.equal(out?.capsuleId, 'capsule-live-p');
    assert.equal(out?.projectId, 'p-live');
    assert.deepEqual(state.reopens, []);
  });

  it('reopens a closed project window once for a provision', async () => {
    const reopened = fakeHost('reopened');
    const { resolve, state } = makeResolver({
      projectCapsules: { 'p-closed': 'capsule-closed' },
      reopenable: { 'p-closed': reopened },
    });
    const out = await resolve({ projectId: 'p-closed' });
    assert.deepEqual(state.reopens, ['p-closed']);
    assert.equal(out?.host, reopened);
    assert.equal(out?.capsuleId, 'capsule-closed');
    assert.equal(out?.projectId, 'p-closed');
  });

  it('refuses a provision for a project whose window cannot be opened, never using another window', async () => {
    const { resolve, state } = makeResolver({});
    const err = await assertUnresolved(() => resolve({ projectId: 'p-nobody' }), 'owns no live window');
    assert.equal((err.details as Record<string, unknown>).reason, 'not-admitted');
    assert.equal(state.ambientAsks, 0);
  });
});

describe('bridge mint resolver — no claim', () => {
  it('an unclaimed mint lands on the ambient window', async () => {
    const ambient = fakeHost('ambient');
    const { resolve } = makeResolver({ ambient });
    assert.equal((await resolve({} as BridgeMintTargetRequest))?.host, ambient);
  });

  it('a bound tab that is gone resolves undefined and never reopens or borrows a window', async () => {
    const { resolve, state } = makeResolver({});
    assert.equal(await resolve({ boundTabId: 'tab-gone' }), undefined);
    assert.deepEqual(state.reopens, []);
    assert.equal(state.ambientAsks, 0);
  });
});

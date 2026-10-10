/**
 * Bridge mint-host resolver — the detached-window routing truth table.
 *
 * `createBridgeMintHostResolver` (src/main/index.ts) is the factory the shipping
 * bridge installs: every mint an agent asks for routes through it. The routing
 * contract under the detached-webhub topology, pinned here over injected deps:
 *
 *   terminal arm (terminalSessionId):
 *     live detached shell          -> the detached host (never the hub)
 *     marked dead / reattach latch -> TERMINAL_SCOPE_UNRESOLVED (never the hub)
 *     never detached               -> the hub, unchanged
 *     malformed owner key          -> TERMINAL_SCOPE_UNRESOLVED (no ambient mint)
 *     web / unassigned / unclaimed -> own host or the hub floor (a closed hub is reopened)
 *
 *   projectId arm (fresh unbound provision):
 *     live detached shell          -> the detached host
 *     detached but windowless      -> TERMINAL_SCOPE_UNRESOLVED
 *     never detached               -> the hub, project-capsule pinned
 *
 * The one behaviour this file exists to kill: a `project:` claim whose window is
 * detached-but-dead re-homing its mint onto the hub — the double-presentation
 * the whole exclusivity stack exists to prevent. Its twin: a hub closed while sibling
 * windows keep the process running must be reopened for a mint that lands there, never
 * answered with the host that window disposed — and a refused mint must not reopen it.
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

interface Fixture {
  deps: BridgeMintResolverDeps;
  hosts: Record<string, NativeTabHost>;
}

/**
 * The world the resolver reads: `hosts` keys are owner keys ('web', 'project:x')
 * or tab ids on the bound-tab arm; `capsules` is the live capsule store;
 * `projectCapsules` is each project's validated claim; `detached` marks
 * projects in detached mode (live shell, marked record or reattach latch — the
 * deps seam folds all three, exactly as the index.ts wiring does).
 */
function makeResolver(opts: {
  hosts?: Record<string, NativeTabHost>;
  tabHosts?: Record<string, NativeTabHost>;
  ownerKeys?: Record<string, string | undefined>;
  capsules?: Record<string, string | undefined>;
  liveCapsules?: readonly string[];
  projectCapsules?: Record<string, string | undefined>;
  detached?: readonly string[];
  bootProjectId?: string;
}) {
  const hosts = opts.hosts ?? {};
  /** How many times a mint asked for the hub — a refused or elsewhere-routed mint never does. */
  const state = { hubAsks: 0 };
  const tabHosts = opts.tabHosts ?? {};
  const detached: Record<string, true> = {};
  for (const projectId of opts.detached ?? []) detached[projectId] = true;
  const deps: BridgeMintResolverDeps = {
    hostForTab: (tabId) => tabHosts[tabId] ?? null,
    hostForOwnerKey: (ownerKeyValue) => hosts[ownerKeyValue] ?? null,
    sessionCapsuleId: (id) => (opts.capsules ?? {})[id],
    sessionOwnerKey: (id) => (opts.ownerKeys ?? {})[id],
    capsuleExists: (capsuleId) => (opts.liveCapsules ?? []).includes(capsuleId),
    projectCapsuleId: (projectId) => (opts.projectCapsules ?? {})[projectId],
    projectDetached: (projectId) => detached[projectId] === true,
    isBootProject: (projectId) => projectId === opts.bootProjectId,
    ensureHubHost: async () => {
      state.hubAsks += 1;
      // A closed hub comes back as a new host, which then answers for the 'web' key.
      if (!hosts['web']) hosts['web'] = fakeHost('hub-reopened');
      return hosts['web'];
    },
  };
  return { resolve: createBridgeMintHostResolver(deps), deps, hosts, state };
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
  const hub = fakeHost('hub');
  const detached = fakeHost('detached');

  it('routes a bound tab to the host that owns it, capsule included', async () => {
    const tabbed = fakeHost('tab-owner', { 'tab-1': 'capsule-tab' });
    const { resolve } = makeResolver({ tabHosts: { 'tab-1': tabbed } });
    const out = await resolve({ boundTabId: 'tab-1', terminalSessionId: 'term-ignored' });
    assert.equal(out?.host, tabbed);
    assert.equal(out?.capsuleId, 'capsule-tab');
  });

  it('routes a project-owned terminal to its live detached shell', async () => {
    const { resolve, state } = makeResolver({
      hosts: { web: hub, 'project:p-1': detached },
      ownerKeys: { 'term-det': 'project:p-1' },
      capsules: { 'term-det': 'capsule-live' },
      liveCapsules: ['capsule-live'],
      projectCapsules: { 'p-1': 'capsule-p1' },
      detached: ['p-1'],
    });
    const out = await resolve({ terminalSessionId: 'term-det' });
    assert.equal(out?.host, detached, 'the mint landed on the hub instead of the detached shell');
    assert.equal(out?.capsuleId, 'capsule-live', 'the stamped live capsule did not win');
    assert.equal(state.hubAsks, 0, 'a mint routed to its detached shell reopened the hub');
  });

  it('routes a never-detached project claim to the hub, pinned to the project capsule', async () => {
    const { resolve } = makeResolver({
      hosts: { web: hub },
      ownerKeys: { 'term-hub': 'project:p-hub' },
      projectCapsules: { 'p-hub': 'capsule-phub' },
    });
    const out = await resolve({ terminalSessionId: 'term-hub' });
    assert.equal(out?.host, hub);
    assert.equal(out?.capsuleId, 'capsule-phub');
  });

  it('reopens a closed hub for a never-detached project claim instead of answering with a disposed host', async () => {
    const { resolve, hosts, state } = makeResolver({
      hosts: {},
      ownerKeys: { 'term-hub': 'project:p-hub' },
      projectCapsules: { 'p-hub': 'capsule-phub' },
    });
    const out = await resolve({ terminalSessionId: 'term-hub' });
    assert.equal(state.hubAsks, 1);
    assert.ok(out?.host, 'no host for a project the hub presents');
    assert.equal(out?.host, hosts['web'], 'the mint did not land on the reopened hub');
    assert.equal(out?.capsuleId, 'capsule-phub');
  });

  it('refuses a project-owned terminal whose project is detached but dead (marked record)', async () => {
    const { resolve } = makeResolver({
      hosts: { web: hub },
      ownerKeys: { 'term-dead': 'project:p-dead' },
      projectCapsules: { 'p-dead': 'capsule-pdead' },
      detached: ['p-dead'],
    });
    const err = await assertUnresolved(() => resolve({ terminalSessionId: 'term-dead' }), /detached|marked|reattach/i);
    assert.equal(err.code, 'TERMINAL_SCOPE_UNRESOLVED');
  });

  it('a refused claim never reopens a closed hub', async () => {
    const { resolve, hosts, state } = makeResolver({
      hosts: {},
      ownerKeys: { 'term-dead': 'project:p-dead' },
      projectCapsules: { 'p-dead': 'capsule-pdead' },
      detached: ['p-dead'],
    });
    await assertUnresolved(() => resolve({ terminalSessionId: 'term-dead' }), /detached/i);
    assert.equal(state.hubAsks, 0, 'a refused mint reopened the hub');
    assert.equal(hosts['web'], undefined);
  });

  it('refuses a project-owned terminal whose project is mid-reattach (latched)', async () => {
    // The deps seam folds the latch into the same detached-mode answer; what the
    // resolver must never do is mint onto the hub while the fold is in flight.
    const { resolve } = makeResolver({
      hosts: { web: hub },
      ownerKeys: { 'term-latched': 'project:p-latched' },
      projectCapsules: { 'p-latched': 'capsule-platched' },
      detached: ['p-latched'],
    });
    await assertUnresolved(() => resolve({ terminalSessionId: 'term-latched' }), 'TERMINAL_SCOPE_UNRESOLVED');
  });

  it('a malformed owner key resolves to the hub unpinned — the port-level scope guard refuses the mint', async () => {
    // The resolver's contract is routing, not capsule proof: a corrupted `project:`
    // stamp has no owner window and no project id to consult, so it falls to the
    // hub floor exactly as the retired code did. The refuse happens one layer up:
    // `resolveMintTarget` throws TERMINAL_SCOPE_UNRESOLVED for a project-claimed
    // session whose resolution carries no capsule — which a malformed key can
    // never produce. This row pins that hand-off: hub host, undefined capsule.
    const { resolve } = makeResolver({
      hosts: { web: hub },
      ownerKeys: { 'term-bad': 'project:' },
    });
    const out = await resolve({ terminalSessionId: 'term-bad' });
    assert.equal(out?.host, hub);
    assert.equal(out?.capsuleId, undefined, 'a malformed claim pinned a capsule');
  });

  it('drops the default sentinel stamp and re-pins the project capsule', async () => {
    const { resolve } = makeResolver({
      hosts: { web: hub },
      ownerKeys: { 'term-sentinel': 'project:p-s' },
      capsules: { 'term-sentinel': DEFAULT_TERMINAL_CAPSULE_ID },
      liveCapsules: [DEFAULT_TERMINAL_CAPSULE_ID, 'capsule-ps'],
      projectCapsules: { 'p-s': 'capsule-ps' },
    });
    const out = await resolve({ terminalSessionId: 'term-sentinel' });
    assert.equal(out?.host, hub);
    assert.equal(out?.capsuleId, 'capsule-ps', 'the sentinel survived as a capsule pin');
  });

  it('drops a stale stamped capsule no live store carries, then re-pins the project capsule', async () => {
    const { resolve } = makeResolver({
      hosts: { web: hub },
      ownerKeys: { 'term-stale': 'project:p-stale' },
      capsules: { 'term-stale': 'capsule-that-died' },
      projectCapsules: { 'p-stale': 'capsule-pstale' },
    });
    const out = await resolve({ terminalSessionId: 'term-stale' });
    assert.equal(out?.host, hub);
    assert.equal(out?.capsuleId, 'capsule-pstale');
  });

  it('vouches a capsule-less claim of the boot project as unpinned on the hub', async () => {
    const { resolve } = makeResolver({
      hosts: { web: hub },
      ownerKeys: { 'term-boot': 'project:p-boot' },
      bootProjectId: 'p-boot',
    });
    const out = await resolve({ terminalSessionId: 'term-boot' });
    assert.equal(out?.host, hub);
    assert.equal(out?.capsuleId, undefined);
    assert.equal(out?.unpinnedBootProject, true);
  });

  it('never vouches a capsule-less claim of a non-boot project', async () => {
    const { resolve } = makeResolver({
      hosts: { web: hub },
      ownerKeys: { 'term-orphan': 'project:p-orphan' },
      bootProjectId: 'p-boot',
    });
    assert.equal((await resolve({ terminalSessionId: 'term-orphan' }))?.unpinnedBootProject, undefined);
  });

  it('does not vouch a boot project that is detached-but-windowless', async () => {
    const { resolve } = makeResolver({
      hosts: { web: hub },
      ownerKeys: { 'term-boot': 'project:p-boot' },
      bootProjectId: 'p-boot',
      detached: ['p-boot'],
    });
    await assertUnresolved(() => resolve({ terminalSessionId: 'term-boot' }), /detached/i);
  });

  it('an unattributed terminal mints on the hub with no capsule pin', async () => {
    const { resolve } = makeResolver({ hosts: { web: hub }, ownerKeys: {} });
    const out = await resolve({ terminalSessionId: 'term-free' });
    assert.equal(out?.host, hub);
    assert.equal(out?.capsuleId, undefined);
  });

  it('an unassigned-owned terminal resolves its own shell, or the hub floor', async () => {
    const unassigned = fakeHost('manager');
    const { resolve } = makeResolver({
      hosts: { web: hub, unassigned },
      ownerKeys: { 'term-mgr': 'unassigned' },
    });
    assert.equal((await resolve({ terminalSessionId: 'term-mgr' }))?.host, unassigned);

    const { resolve: deadManager } = makeResolver({
      hosts: { web: hub },
      ownerKeys: { 'term-mgr': 'unassigned' },
    });
    assert.equal((await deadManager({ terminalSessionId: 'term-mgr' }))?.host, hub, 'a dead manager no longer mints onto its own shell');
  });
});

describe('bridge mint resolver — projectId arm', () => {
  const hub = fakeHost('hub');
  const detached = fakeHost('detached');

  it('mints a fresh provision on the live detached shell', async () => {
    const { resolve, state } = makeResolver({
      hosts: { web: hub, 'project:p-live': detached },
      projectCapsules: { 'p-live': 'capsule-live-p' },
      detached: ['p-live'],
    });
    const out = await resolve({ projectId: 'p-live' });
    assert.equal(out?.host, detached);
    assert.equal(out?.capsuleId, 'capsule-live-p');
    assert.equal(state.hubAsks, 0, 'a mint routed to its detached shell reopened the hub');
  });

  it('refuses a fresh provision for a detached-but-windowless project, and never reopens the hub for it', async () => {
    const { resolve, state } = makeResolver({
      hosts: { web: hub },
      projectCapsules: { 'p-marked': 'capsule-marked' },
      detached: ['p-marked'],
    });
    const err = await assertUnresolved(() => resolve({ projectId: 'p-marked' }), /detached/i);
    assert.equal(err.code, 'TERMINAL_SCOPE_UNRESOLVED');
    assert.equal(state.hubAsks, 0, 'a refused mint reopened the hub');
  });

  it('mints a validated never-detached claim on the hub, capsule pinned', async () => {
    const { resolve } = makeResolver({
      hosts: { web: hub },
      projectCapsules: { 'p-ok': 'capsule-pok' },
    });
    const out = await resolve({ projectId: 'p-ok' });
    assert.equal(out?.host, hub);
    assert.equal(out?.capsuleId, 'capsule-pok');
  });

  it('mints an unknown claim unpinned on the hub', async () => {
    const { resolve } = makeResolver({ hosts: { web: hub } });
    const out = await resolve({ projectId: 'p-nobody' });
    assert.equal(out?.host, hub);
    assert.equal(out?.capsuleId, undefined);
  });

  it('an unclaimed mint lands on the hub, reopening it when it was closed', async () => {
    const live = makeResolver({ hosts: { web: hub } });
    assert.equal((await live.resolve({} as BridgeMintTargetRequest))?.host, hub);

    const closed = makeResolver({ hosts: {} });
    const out = await closed.resolve({} as BridgeMintTargetRequest);
    assert.ok(out?.host, 'an unclaimed mint had no host to land on');
    assert.equal(out?.host, closed.hosts['web'], 'the mint did not land on the reopened hub');
    assert.equal(closed.state.hubAsks, 1);
  });

  it('a bound tab that is gone resolves undefined and never reopens the hub', async () => {
    const { resolve, state } = makeResolver({ hosts: {} });
    assert.equal(await resolve({ boundTabId: 'tab-gone' }), undefined);
    assert.equal(state.hubAsks, 0, 'a mint the bridge will refuse reopened the hub');
  });
});

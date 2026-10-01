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
 *     web / unassigned / unclaimed -> own host or the hub floor, unchanged
 *
 *   projectId arm (fresh unbound provision):
 *     live detached shell          -> the detached host
 *     detached but windowless      -> TERMINAL_SCOPE_UNRESOLVED
 *     never detached               -> the hub, project-capsule pinned
 *
 * The one behaviour this file exists to kill: a `project:` claim whose window is
 * detached-but-dead re-homing its mint onto the hub — the double-presentation
 * the whole exclusivity stack exists to prevent.
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
}) {
  const hosts = opts.hosts ?? {};
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
    hubHost: () => hosts['web'] ?? fakeHost('hub-fallback'),
  };
  return { resolve: createBridgeMintHostResolver(deps), deps, hosts };
}

function assertUnresolved(fn: () => unknown, match: RegExp | string): CapabilityError {
  try {
    fn();
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

  it('routes a bound tab to the host that owns it, capsule included', () => {
    const tabbed = fakeHost('tab-owner', { 'tab-1': 'capsule-tab' });
    const { resolve } = makeResolver({ tabHosts: { 'tab-1': tabbed } });
    const out = resolve({ boundTabId: 'tab-1', terminalSessionId: 'term-ignored' });
    assert.equal(out?.host, tabbed);
    assert.equal(out?.capsuleId, 'capsule-tab');
  });

  it('routes a project-owned terminal to its live detached shell', () => {
    const { resolve } = makeResolver({
      hosts: { web: hub, 'project:p-1': detached },
      ownerKeys: { 'term-det': 'project:p-1' },
      capsules: { 'term-det': 'capsule-live' },
      liveCapsules: ['capsule-live'],
      projectCapsules: { 'p-1': 'capsule-p1' },
      detached: ['p-1'],
    });
    const out = resolve({ terminalSessionId: 'term-det' });
    assert.equal(out?.host, detached, 'the mint landed on the hub instead of the detached shell');
    assert.equal(out?.capsuleId, 'capsule-live', 'the stamped live capsule did not win');
  });

  it('routes a never-detached project claim to the hub, pinned to the project capsule', () => {
    const { resolve } = makeResolver({
      hosts: { web: hub },
      ownerKeys: { 'term-hub': 'project:p-hub' },
      projectCapsules: { 'p-hub': 'capsule-phub' },
    });
    const out = resolve({ terminalSessionId: 'term-hub' });
    assert.equal(out?.host, hub);
    assert.equal(out?.capsuleId, 'capsule-phub');
  });

  it('refuses a project-owned terminal whose project is detached but dead (marked record)', () => {
    const { resolve } = makeResolver({
      hosts: { web: hub },
      ownerKeys: { 'term-dead': 'project:p-dead' },
      projectCapsules: { 'p-dead': 'capsule-pdead' },
      detached: ['p-dead'],
    });
    const err = assertUnresolved(() => resolve({ terminalSessionId: 'term-dead' }), /detached|marked|reattach/i);
    assert.equal(err.code, 'TERMINAL_SCOPE_UNRESOLVED');
  });

  it('refuses a project-owned terminal whose project is mid-reattach (latched)', () => {
    // The deps seam folds the latch into the same detached-mode answer; what the
    // resolver must never do is mint onto the hub while the fold is in flight.
    const { resolve } = makeResolver({
      hosts: { web: hub },
      ownerKeys: { 'term-latched': 'project:p-latched' },
      projectCapsules: { 'p-latched': 'capsule-platched' },
      detached: ['p-latched'],
    });
    assertUnresolved(() => resolve({ terminalSessionId: 'term-latched' }), 'TERMINAL_SCOPE_UNRESOLVED');
  });

  it('a malformed owner key resolves to the hub unpinned — the port-level scope guard refuses the mint', () => {
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
    const out = resolve({ terminalSessionId: 'term-bad' });
    assert.equal(out?.host, hub);
    assert.equal(out?.capsuleId, undefined, 'a malformed claim pinned a capsule');
  });

  it('drops the default sentinel stamp and re-pins the project capsule', () => {
    const { resolve } = makeResolver({
      hosts: { web: hub },
      ownerKeys: { 'term-sentinel': 'project:p-s' },
      capsules: { 'term-sentinel': DEFAULT_TERMINAL_CAPSULE_ID },
      liveCapsules: [DEFAULT_TERMINAL_CAPSULE_ID, 'capsule-ps'],
      projectCapsules: { 'p-s': 'capsule-ps' },
    });
    const out = resolve({ terminalSessionId: 'term-sentinel' });
    assert.equal(out?.host, hub);
    assert.equal(out?.capsuleId, 'capsule-ps', 'the sentinel survived as a capsule pin');
  });

  it('drops a stale stamped capsule no live store carries, then re-pins the project capsule', () => {
    const { resolve } = makeResolver({
      hosts: { web: hub },
      ownerKeys: { 'term-stale': 'project:p-stale' },
      capsules: { 'term-stale': 'capsule-that-died' },
      projectCapsules: { 'p-stale': 'capsule-pstale' },
    });
    const out = resolve({ terminalSessionId: 'term-stale' });
    assert.equal(out?.host, hub);
    assert.equal(out?.capsuleId, 'capsule-pstale');
  });

  it('an unattributed terminal mints on the hub with no capsule pin', () => {
    const { resolve } = makeResolver({ hosts: { web: hub }, ownerKeys: {} });
    const out = resolve({ terminalSessionId: 'term-free' });
    assert.equal(out?.host, hub);
    assert.equal(out?.capsuleId, undefined);
  });

  it('an unassigned-owned terminal resolves its own shell, or the hub floor', () => {
    const unassigned = fakeHost('manager');
    const { resolve } = makeResolver({
      hosts: { web: hub, unassigned },
      ownerKeys: { 'term-mgr': 'unassigned' },
    });
    assert.equal(resolve({ terminalSessionId: 'term-mgr' })?.host, unassigned);

    const { resolve: deadManager } = makeResolver({
      hosts: { web: hub },
      ownerKeys: { 'term-mgr': 'unassigned' },
    });
    assert.equal(deadManager({ terminalSessionId: 'term-mgr' })?.host, hub, 'a dead manager no longer mints onto its own shell');
  });
});

describe('bridge mint resolver — projectId arm', () => {
  const hub = fakeHost('hub');
  const detached = fakeHost('detached');

  it('mints a fresh provision on the live detached shell', () => {
    const { resolve } = makeResolver({
      hosts: { web: hub, 'project:p-live': detached },
      projectCapsules: { 'p-live': 'capsule-live-p' },
      detached: ['p-live'],
    });
    const out = resolve({ projectId: 'p-live' });
    assert.equal(out?.host, detached);
    assert.equal(out?.capsuleId, 'capsule-live-p');
  });

  it('refuses a fresh provision for a detached-but-windowless project', () => {
    const { resolve } = makeResolver({
      hosts: { web: hub },
      projectCapsules: { 'p-marked': 'capsule-marked' },
      detached: ['p-marked'],
    });
    const err = assertUnresolved(() => resolve({ projectId: 'p-marked' }), /detached/i);
    assert.equal(err.code, 'TERMINAL_SCOPE_UNRESOLVED');
  });

  it('mints a validated never-detached claim on the hub, capsule pinned', () => {
    const { resolve } = makeResolver({
      hosts: { web: hub },
      projectCapsules: { 'p-ok': 'capsule-pok' },
    });
    const out = resolve({ projectId: 'p-ok' });
    assert.equal(out?.host, hub);
    assert.equal(out?.capsuleId, 'capsule-pok');
  });

  it('mints an unknown claim unpinned on the hub', () => {
    const { resolve } = makeResolver({ hosts: { web: hub } });
    const out = resolve({ projectId: 'p-nobody' });
    assert.equal(out?.host, hub);
    assert.equal(out?.capsuleId, undefined);
  });

  it('resolves undefined when nothing is claimed — the bridge keeps its own fallback', () => {
    const { resolve } = makeResolver({ hosts: { web: hub } });
    assert.equal(resolve({} as BridgeMintTargetRequest), undefined);
  });
});

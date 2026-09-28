/**
 * What `openTab` reports when the tab cannot belong to the session.
 *
 * A session is identified by its anchor tab. Two different failures can stop a new
 * tab from joining it, and they need different recoveries:
 *
 * - the anchor is gone, so no tab can be adopted at all - the session must be
 *   rebound to a live tab before anything else can work;
 * - the anchor is alive but its pool refused the tab - normally a full session,
 *   where the caller closes a tab it owns.
 *
 * Reporting the first as the second is not cosmetic: the measured case sent the
 * caller looking for tabs to close while the session's managed set held one id, and
 * the refusal named a quota that had not been reached.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, type BrowserHostPort } from '../../../src/main/tools/browser-control-port';
import { CapabilityError } from '../../../src/shared/control-plane-contracts';
import type { BrowserTarget } from '../../../src/shared/control-plane-contracts';

const SESSION_TAB_LIMIT = 10;

type CreateTabCall = {
  url?: string;
  activate?: boolean;
  options?: {
    capsuleId?: string;
    userAgentMode?: unknown;
    ephemeral?: boolean;
    offscreen?: boolean;
    devicePresetId?: string;
    mobile?: boolean;
    anchorTabId?: string;
  };
};

type Harness = {
  port: BrowserControlPort;
  target: BrowserTarget;
  created: string[];
  closed: string[];
  createCalls: CreateTabCall[];
  /** Tabs the host still lists as live, after every create/close this harness observed. */
  live: Set<string>;
  /** Ids the session's managed set resolves to, pruned the way the production readers prune. */
  managedIds: () => string[];
  /** Any attempt to move the session's automation target. */
  retargets: string[];
};

const ANCHOR = 'tab-anchor';

/** What the host reports for the anchor's capsule affiliation: a capsule, or nothing owned. */
type AnchorAffiliation = { projectId?: string; workspaceId?: string; capsuleId?: string };

function makeHarness(options: {
  anchorAlive: boolean;
  adopt: boolean;
  owned: string[];
  affiliation?: AnchorAffiliation | null;
  omitResolveTabAffiliation?: boolean;
  /**
   * Runs inside the host's `createTab`, so a case can take the anchor away while the
   * child is still being allocated: after the gate read the anchor as live and before
   * the adopt call is the first thing that can observe the loss. `setAffiliation`
   * rewrites what the host reports from that moment on, so a case can also move the
   * anchor's affiliation out from under an in-flight creation.
   */
  onChildAllocated?: (closeAnchor: () => void, setAffiliation: (next: AnchorAffiliation | null) => void) => void;
}): Harness {
  const created: string[] = [];
  const closed: string[] = [];
  const createCalls: CreateTabCall[] = [];
  const retargets: string[] = [];
  // The host's live-tab registry and the session's pool are separate on purpose: a pool
  // may hold an id the host no longer lists, and every production reader prunes it there.
  const live = new Set<string>(options.owned.filter((id) => id !== ANCHOR));
  const pool = new Set<string>(options.owned);
  let anchorAlive = options.anchorAlive;
  let affiliationNow = options.affiliation;
  const hasTab = (tabId?: string | null): boolean =>
    typeof tabId === 'string' && tabId.length > 0
      ? (tabId === ANCHOR ? anchorAlive : live.has(tabId))
      : false;
  const prunePool = (): void => {
    for (const id of Array.from(pool)) if (!hasTab(id)) pool.delete(id);
  };
  const host = {
    hasTab,
    getTabList: () => [{ id: ANCHOR, url: 'about:blank', title: 'Anchor' }],
    getManagedTabIds: () => {
      prunePool();
      return new Set(pool);
    },
    adoptChildTab: (anchor: string, childTabId: string) => {
      // The production adopt path refuses a child whose identifier is not a live tab and
      // writes no pool entry in that case: a pool only exists for a live tab (ad-hoc,
      // keyed by the tab) or for an affinity entry that names one.
      if (!options.adopt) return false;
      if (!hasTab(anchor)) return false;
      pool.add(childTabId);
      return true;
    },
    createTab: (url?: string, activate?: boolean, opts?: CreateTabCall['options']) => {
      const id = `tab-created-${created.length + 1}`;
      created.push(id);
      createCalls.push({ url, activate, options: opts });
      options.onChildAllocated?.(
        () => {
          anchorAlive = false;
          live.delete(ANCHOR);
          pool.delete(ANCHOR);
        },
        (next) => {
          affiliationNow = next;
        }
      );
      live.add(id);
      return id;
    },
    closeTab: (tabId: string) => {
      closed.push(tabId);
      live.delete(tabId);
      pool.delete(tabId);
      return true;
    },
    getAutomationTabId: () => ANCHOR,
    setAutomationTabId: (tabId?: string) => {
      retargets.push(String(tabId));
    },
  } as unknown as BrowserHostPort;
  if (!options.omitResolveTabAffiliation) {
    host.resolveTabAffiliation = (tabId: string) => {
      if (tabId === ANCHOR && hasTab(ANCHOR)) {
        return affiliationNow === null ? undefined : affiliationNow;
      }
      return undefined;
    };
  }
  return {
    port: new BrowserControlPort(host),
    target: { tabId: ANCHOR } as unknown as BrowserTarget,
    created,
    closed,
    createCalls,
    live,
    managedIds: () => {
      prunePool();
      return Array.from(pool);
    },
    retargets,
  };
}

function refusal(run: () => unknown): CapabilityError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof CapabilityError, `expected a CapabilityError, received ${String(error)}`);
    return error;
  }
  throw new Error('expected the call to be refused');
}

describe('Opening a tab for a session', () => {
  it('refuses a dead anchor without creating a tab, and names the rebind recovery', () => {
    const { port, target, created, closed } = makeHarness({ anchorAlive: false, adopt: false, owned: ['tab-anchor'] });

    const error = refusal(() => port.openTab({}, { target }));

    assert.equal(error.code, 'TARGET_STALE');
    assert.equal(error.details?.boundTabId, 'tab-anchor');
    assert.equal(error.details?.recovery, 'anti.browser.rebind_target');
    // Nothing is created, so there is no leak to close either.
    assert.deepStrictEqual(created, []);
    assert.deepStrictEqual(closed, []);
  });

  it('reports a pool refusal under the limit as the measured count, not as the quota', () => {
    const { port, target, created, closed } = makeHarness({ anchorAlive: true, adopt: false, owned: ['tab-anchor'] });

    const error = refusal(() => port.openTab({}, { target }));

    assert.equal(error.code, 'SESSION_STALE');
    assert.equal(error.details?.used, 1);
    assert.equal(error.details?.limit, SESSION_TAB_LIMIT);
    assert.deepStrictEqual(error.details?.countedTabIds, ['tab-anchor']);
    // The tab it could not own is closed rather than left outside the session.
    assert.deepStrictEqual(created, ['tab-created-1']);
    assert.deepStrictEqual(closed, ['tab-created-1']);
  });

  it('refuses a full session at the gate, before creating anything, and reports the quota', () => {
    const owned = Array.from({ length: SESSION_TAB_LIMIT }, (_, index) => `tab-owned-${index + 1}`);
    const { port, target, created, closed } = makeHarness({ anchorAlive: true, adopt: true, owned });

    const error = refusal(() => port.openTab({}, { target }));

    assert.equal(error.code, 'POLICY_DENIED');
    assert.equal(error.details?.used, SESSION_TAB_LIMIT);
    assert.equal(error.details?.limit, SESSION_TAB_LIMIT);
    // The gate refuses before the host creates a view, so there is nothing to close.
    assert.deepStrictEqual(created, []);
    assert.deepStrictEqual(closed, []);
  });

  it('returns the created tab when the anchor adopts it', () => {
    const { port, target } = makeHarness({ anchorAlive: true, adopt: true, owned: ['tab-anchor'] });

    assert.deepStrictEqual(port.openTab({}, { target }), { tabId: 'tab-created-1' });
  });

  it('refuses routed creation with POLICY_DENIED when anchor affiliation conflicts with target and never calls createTab', () => {
    const { port, created, createCalls } = makeHarness({
      anchorAlive: true,
      adopt: true,
      owned: ['tab-anchor'],
      affiliation: { projectId: 'project-alpha', workspaceId: 'workspace-one', capsuleId: 'capsule-a' },
    });
    const routedTarget: BrowserTarget = {
      tabId: 'tab-anchor',
      documentGeneration: 1,
      browserEpoch: 1,
      runtimeId: 'rt-test',
      projectId: 'project-beta',
      workspaceId: 'workspace-two',
    };

    const error = refusal(() => port.openTab({}, { target: routedTarget }));

    assert.equal(error.code, 'POLICY_DENIED');
    assert.deepStrictEqual(created, []);
    assert.deepStrictEqual(createCalls, []);
  });

  it('opens a routed creation inside the anchor own capsule when that capsule is Unassigned', () => {
    // The anchor's capsule claims no project/workspace: there is no affiliation to conflict
    // with, and the child is pinned to the anchor's own capsule, so the creation proceeds
    // there instead of being refused.
    const { port, created, createCalls } = makeHarness({
      anchorAlive: true,
      adopt: true,
      owned: ['tab-anchor'],
      affiliation: { capsuleId: 'capsule-unassigned' },
    });
    const routedTarget: BrowserTarget = {
      tabId: 'tab-anchor',
      documentGeneration: 1,
      browserEpoch: 1,
      runtimeId: 'rt-test',
      projectId: 'project-alpha',
      workspaceId: 'workspace-one',
    };

    const result = port.openTab({}, { target: routedTarget });

    assert.deepStrictEqual(result, { tabId: 'tab-created-1' });
    assert.deepStrictEqual(created, ['tab-created-1']);
    assert.equal(createCalls.length, 1);
    const firstCall = createCalls[0];
    assert.ok(firstCall);
    assert.equal(firstCall.options?.capsuleId, 'capsule-unassigned');
    assert.equal(firstCall.options?.anchorTabId, 'tab-anchor');
  });

  it('refuses routed creation with POLICY_DENIED when the Unassigned anchor names no capsule to pin, and never calls createTab', () => {
    // An unnamed capsule cannot pin the child, so `createTab` would fall back to the window's
    // or the active capsule - the inheritance this gate exists to prevent. That case is what
    // still fails closed, and it fails before anything is allocated.
    const { port, created, createCalls } = makeHarness({
      anchorAlive: true,
      adopt: true,
      owned: ['tab-anchor'],
      affiliation: {},
    });
    const routedTarget: BrowserTarget = {
      tabId: 'tab-anchor',
      documentGeneration: 1,
      browserEpoch: 1,
      runtimeId: 'rt-test',
      projectId: 'project-alpha',
      workspaceId: 'workspace-one',
    };

    const error = refusal(() => port.openTab({}, { target: routedTarget }));

    assert.equal(error.code, 'POLICY_DENIED');
    assert.match(error.message, /Unassigned/);
    assert.deepStrictEqual(created, []);
    assert.deepStrictEqual(createCalls, []);
  });

  it('creates the tab bound to the anchor capsule and names the owning window', () => {
    const { port, created, createCalls } = makeHarness({
      anchorAlive: true,
      adopt: true,
      owned: ['tab-anchor'],
      affiliation: { projectId: 'project-alpha', workspaceId: 'workspace-one', capsuleId: 'capsule-a' },
    });
    const routedTarget: BrowserTarget = {
      tabId: 'tab-anchor',
      documentGeneration: 1,
      browserEpoch: 1,
      runtimeId: 'rt-test',
      projectId: 'project-alpha',
      workspaceId: 'workspace-one',
    };

    const result = port.openTab({}, { target: routedTarget });

    assert.deepStrictEqual(result, { tabId: 'tab-created-1' });
    assert.deepStrictEqual(created, ['tab-created-1']);
    assert.equal(createCalls.length, 1);
    const firstCall = createCalls[0];
    assert.ok(firstCall);
    assert.equal(firstCall.options?.capsuleId, 'capsule-a');
    assert.equal(firstCall.options?.anchorTabId, 'tab-anchor');
    // The verified project/workspace are the gate's authority, not the host's payload: the
    // host binds the tab to the capsule it is given, and the project/workspace are resolved
    // from that capsule, so forwarding the pair would create a second, unread source of truth.
    assert.equal('projectId' in firstCall.options, false);
    assert.equal('workspaceId' in firstCall.options, false);
  });

  it('keeps old behaviour when target has no projectId/workspaceId: tab is created and options carry no capsuleId', () => {
    const { port, target, created, createCalls } = makeHarness({
      anchorAlive: true,
      adopt: true,
      owned: ['tab-anchor'],
      affiliation: { projectId: 'project-alpha', workspaceId: 'workspace-one', capsuleId: 'capsule-a' },
    });

    const result = port.openTab({}, { target });

    assert.deepStrictEqual(result, { tabId: 'tab-created-1' });
    assert.deepStrictEqual(created, ['tab-created-1']);
    assert.equal(createCalls.length, 1);
    const firstCall = createCalls[0];
    assert.ok(firstCall);
    assert.equal(firstCall.options?.capsuleId, undefined);
    assert.equal(firstCall.options?.anchorTabId, undefined);
    assert.equal('capsuleId' in (firstCall.options || {}), false);
  });

  it('refuses routed creation with CAPABILITY_NOT_FOUND when host lacks resolveTabAffiliation and never calls createTab', () => {
    const { port, created, createCalls } = makeHarness({
      anchorAlive: true,
      adopt: true,
      owned: ['tab-anchor'],
      omitResolveTabAffiliation: true,
    });
    const routedTarget: BrowserTarget = {
      tabId: 'tab-anchor',
      documentGeneration: 1,
      browserEpoch: 1,
      runtimeId: 'rt-test',
      projectId: 'project-alpha',
      workspaceId: 'workspace-one',
    };

    const error = refusal(() => port.openTab({}, { target: routedTarget }));

    assert.equal(error.code, 'CAPABILITY_NOT_FOUND');
    assert.deepStrictEqual(created, []);
    assert.deepStrictEqual(createCalls, []);
  });

  it('refuses routed creation with TARGET_STALE when anchor tab is not owned by any capsule and never calls createTab', () => {
    const { port, created, createCalls } = makeHarness({
      anchorAlive: true,
      adopt: true,
      owned: ['tab-anchor'],
      affiliation: null,
    });
    const routedTarget: BrowserTarget = {
      tabId: 'tab-anchor',
      documentGeneration: 1,
      browserEpoch: 1,
      runtimeId: 'rt-test',
      projectId: 'project-alpha',
      workspaceId: 'workspace-one',
    };

    const error = refusal(() => port.openTab({}, { target: routedTarget }));

    assert.equal(error.code, 'TARGET_STALE');
    assert.deepStrictEqual(created, []);
    assert.deepStrictEqual(createCalls, []);
  });

  it('closes the created child, keeps its slot out of the session and leaves the anchor in place when the anchor disappears before adoption', () => {
    // The gate reads the anchor as live, then the anchor is closed while the host is
    // still allocating the child. The adopt call is the first thing after allocation
    // that can observe the loss, so the port's cleanup - not the gate - is what has to
    // keep the created page from outliving the session it could not join.
    const { port, created, closed, createCalls, live, managedIds, retargets } = makeHarness({
      anchorAlive: true,
      adopt: true,
      owned: ['tab-anchor'],
      affiliation: { projectId: 'project-alpha', workspaceId: 'workspace-one', capsuleId: 'capsule-a' },
      onChildAllocated: (closeAnchor) => closeAnchor(),
    });
    const routedTarget: BrowserTarget = {
      tabId: 'tab-anchor',
      documentGeneration: 1,
      browserEpoch: 1,
      runtimeId: 'rt-test',
      projectId: 'project-alpha',
      workspaceId: 'workspace-one',
    };
    assert.deepStrictEqual(managedIds(), ['tab-anchor']);

    const error = refusal(() => port.openTab({}, { target: routedTarget }));

    // No orphan target: the single page the host allocated is the single page it closed,
    // and no window still lists it as a live tab.
    assert.deepStrictEqual(created, ['tab-created-1']);
    assert.deepStrictEqual(closed, ['tab-created-1']);
    assert.equal(createCalls.length, 1);
    assert.equal(live.has('tab-created-1'), false);
    // No orphan session slot either: the child occupies nothing in the managed set, which
    // is the same source both quota gates and the adopt path count.
    assert.equal(managedIds().includes('tab-created-1'), false);
    assert.equal(managedIds().includes('tab-anchor'), false);
    // The parent is not retargeted: the refusal names the anchor it failed to adopt into,
    // and nothing moved the session's automation target onto the child it just gave up.
    assert.equal(error.details?.boundTabId, 'tab-anchor');
    assert.deepStrictEqual(retargets, []);
    // The anchor the gate read as live is gone by the time the adoption is refused, and that
    // loss is the cause the refusal names: an anchor that no longer exists cannot adopt
    // anything, so the caller rebinds. The classification comes from the anchor's state read
    // again here - not from the gate's earlier reading, and not from the pool, whose measured
    // set at this moment is 0 of 10 and explains nothing about the failure. Reporting the pool
    // branch here told the caller its anchor was live and sent it hunting for tabs to close.
    assert.equal(error.code, 'TARGET_STALE');
    assert.equal(error.details?.recovery, 'anti.browser.rebind_target');
    // No counted set travels with a dead anchor, so this refusal cannot be read as a quota...
    assert.equal('used' in (error.details ?? {}), false);
    assert.equal('countedTabIds' in (error.details ?? {}), false);
    // ...and no id is handed back for a child that was already closed.
    assert.equal('tabId' in (error.details ?? {}), false);
  });

  it('reports the pool refusal, not a lost anchor, when the anchor is still live and authorized at the re-read', () => {
    // The same routed creation as the case above, except the anchor survives the allocation
    // and still carries the requested affiliation: the two classifications have to stay
    // distinguishable, or a healthy session would be told to rebind every time its pool
    // refused a tab.
    const { port, created, closed, managedIds, retargets } = makeHarness({
      anchorAlive: true,
      adopt: false,
      owned: ['tab-anchor'],
      affiliation: { projectId: 'project-alpha', workspaceId: 'workspace-one', capsuleId: 'capsule-a' },
    });
    const routedTarget: BrowserTarget = {
      tabId: 'tab-anchor',
      documentGeneration: 1,
      browserEpoch: 1,
      runtimeId: 'rt-test',
      projectId: 'project-alpha',
      workspaceId: 'workspace-one',
    };

    const error = refusal(() => port.openTab({}, { target: routedTarget }));

    assert.equal(error.code, 'SESSION_STALE');
    assert.equal(error.details?.used, 1);
    assert.equal(error.details?.limit, SESSION_TAB_LIMIT);
    assert.deepStrictEqual(error.details?.countedTabIds, ['tab-anchor']);
    assert.equal(error.details?.tabId, 'tab-created-1');
    // Cleanup is the same in both classifications: the child it could not own is closed, holds
    // no session slot, and never becomes the session's automation target.
    assert.deepStrictEqual(created, ['tab-created-1']);
    assert.deepStrictEqual(closed, ['tab-created-1']);
    assert.equal(managedIds().includes('tab-created-1'), false);
    assert.deepStrictEqual(retargets, []);
  });

  it('re-reads the affiliation after a refused adoption and refuses a creation the anchor can no longer authorize', () => {
    // The anchor outlives the allocation but its capsule moves to another project while the
    // child is being created: the affiliation the gate verified no longer authorizes this
    // creation, so the failure is the authorization refusal and not the pool's.
    const { port, created, closed, retargets } = makeHarness({
      anchorAlive: true,
      adopt: false,
      owned: ['tab-anchor'],
      affiliation: { projectId: 'project-alpha', workspaceId: 'workspace-one', capsuleId: 'capsule-a' },
      onChildAllocated: (_closeAnchor, setAffiliation) =>
        setAffiliation({ projectId: 'project-beta', workspaceId: 'workspace-two', capsuleId: 'capsule-b' }),
    });
    const routedTarget: BrowserTarget = {
      tabId: 'tab-anchor',
      documentGeneration: 1,
      browserEpoch: 1,
      runtimeId: 'rt-test',
      projectId: 'project-alpha',
      workspaceId: 'workspace-one',
    };

    const error = refusal(() => port.openTab({}, { target: routedTarget }));

    assert.equal(error.code, 'POLICY_DENIED');
    assert.equal(error.details?.measuredProjectId, 'project-beta');
    assert.equal(error.details?.measuredWorkspaceId, 'workspace-two');
    assert.equal(error.details?.targetProjectId, 'project-alpha');
    assert.equal(error.details?.targetWorkspaceId, 'workspace-one');
    assert.equal(error.details?.recovery, 'rebind to a session matching target project and workspace');
    // The child the refused creation allocated is closed either way, and the session keeps
    // addressing the anchor it was bound to.
    assert.deepStrictEqual(created, ['tab-created-1']);
    assert.deepStrictEqual(closed, ['tab-created-1']);
    assert.deepStrictEqual(retargets, []);
  });
});

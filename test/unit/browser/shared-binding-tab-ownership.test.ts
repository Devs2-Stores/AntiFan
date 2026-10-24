/**
 * Tab ownership across binding rotations, with the real host bookkeeping and the real
 * attachment registry wired the way main wires them.
 *
 * `tabs.create` rotates the attachment's binding onto the new tab. The registry used to release
 * the previous bound tab from every pool on each rotation, so the session lost its own tabs
 * (the next close of the first tab refused with TARGET_MISMATCH) and a sibling sharing the
 * attachment lost the tabs it had opened. A rotation onto a tab the old binding already manages
 * must keep the old tab owned; only a move away from the managed set releases it.
 */
import { after, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeTabHost } from '../../../src/main/browser/native-tab-host';
import { AttachmentRegistry } from '../../../src/main/run/attachment-registry';
import { SemanticRefRegistry } from '../../../src/main/browser/semantic-ref-registry';
import {
  CapabilityError,
  issueRuntimeLease,
  makeControlPlaneId,
  type ExecutionAttachmentRecord,
} from '../../../src/shared/control-plane-contracts';
import { createShellDouble } from '../../support/project-window-shell-double';

// Closing a tab journals into the lifecycle log, which binds its file lazily on first write.
const RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-shared-binding-runtime-'));
process.env.ANTIFAN_RUNTIME_DIR = RUNTIME_DIR;
after(() => {
  fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
});

const PROJECT_ID = 'project-00000000-0000-4000-8000-000000000001';
const WORKSPACE_ID = 'workspace-00000000-0000-4000-8000-000000000001';

interface HostInternals {
  tabs: Map<string, unknown>;
  sessionTabPools: Map<string, Set<string>>;
  adoptChildTab(identifier: string, childTabId: string): boolean;
  isTabAllowedForPrimary(primary: string, requested: string): boolean;
  releaseSessionTab(sessionId: string, tabId: string): boolean;
  closeTab(tabId: string, source?: string): boolean;
  describeTabOwnership(bound: string, target: string): {
    allowed: boolean;
    targetOwner: string;
    managedTabIds: string[];
    managedTotal: number;
  };
  [key: string]: unknown;
}

function makeHost(liveIds: string[]): HostInternals {
  const host = Object.create(NativeTabHost.prototype) as unknown as HostInternals;
  const noopContents = () => {
    let destroyed = false;
    return {
      isDestroyed: () => destroyed,
      destroy: () => { destroyed = true; },
      close: () => { destroyed = true; },
      on: () => {},
      once: () => {},
      removeListener: () => {},
      setBackgroundThrottling: () => {},
      getURL: () => 'https://example.test/',
    };
  };
  host.tabs = new Map(liveIds.map((id) => [
    id,
    { state: { id, url: 'https://example.test/', title: id, ephemeral: true }, view: { webContents: noopContents() } },
  ]));
  host.tabOrder = [...liveIds];
  host.activeTabId = '';
  host.isDisposed = false;
  host.closeAdmission = null;
  host.pendingPageCloses = new Map();
  host.attemptAuthorizedCloses = new Set();
  host.automationTabId = null;
  host.recentlyClosedTabs = [];
  host.tabPreviewUnsubscribers = new Map();
  host.documentGenerations = new Map();
  host.semanticDocumentGenerations = new Map();
  host.crossDocumentGenerations = new Map();
  host.targetOperationQueues = new Map();
  host.targetOperationOwners = new Map();
  host.sessionTabPools = new Map();
  host.closedTabAnchors = new Map();
  host.tabThemeQaStates = new Map();
  host.terminalAgentAffinity = new Map();
  host.hibernatingTabIds = new Set();
  host.agentInputInFlight = 0;
  host.lastUserInputAtMs = 0;
  host.agentWorkingRefs = new Map();
  host.agentWorkingTimers = new Map();
  host.shell = createShellDouble();
  host.semanticRefRegistry = new SemanticRefRegistry();
  host.networkTracker = { dispose: () => {}, detachTarget: () => {} };
  host.broadcastState = () => {};
  host.switchTab = () => true;
  host.createTab = () => 'created-tab';
  host.reassertPresentedView = () => {};
  host.updateLayout = () => {};
  host.persistTabs = () => {};
  return host;
}

/** The delegate main installs: the control plane's ownership predicate over the host's pools. */
function wireRegistry(host: HostInternals): AttachmentRegistry {
  return new AttachmentRegistry({
    isTabAllowed: (record: { tabId?: string }, requestedTabId: string) => {
      if (!record?.tabId) return true;
      if (record.tabId === requestedTabId) return true;
      return host.isTabAllowedForPrimary(record.tabId, requestedTabId);
    },
    releaseSessionTab: (sessionId, tabId) => host.releaseSessionTab(sessionId, tabId),
    releaseSessionTabPool: () => false,
  });
}

async function mint(registry: AttachmentRegistry, tabId: string): Promise<ExecutionAttachmentRecord> {
  const lease = issueRuntimeLease(PROJECT_ID, WORKSPACE_ID, 60_000, 1);
  const { record } = await registry.issueAttachment(
    makeControlPlaneId('run'),
    makeControlPlaneId('attempt'),
    PROJECT_ID,
    WORKSPACE_ID,
    {
      backendId: 'test-backend',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId,
      grant: 'write',
      documentGeneration: 1,
    },
  );
  return record;
}

/** What `tabs.create` does: adopt the new tab under the bound tab, then rotate the binding onto it. */
async function createTabAndRebind(
  host: HostInternals,
  registry: AttachmentRegistry,
  attachmentId: string,
  boundTabId: string,
  newTabId: string,
): Promise<void> {
  assert.equal(host.adoptChildTab(boundTabId, newTabId), true, `adopting ${newTabId} under ${boundTabId}`);
  const rotated = await registry.updateAttachmentTab(attachmentId, newTabId, 2);
  assert.ok(rotated, `rotation onto ${newTabId}`);
}

describe('binding rotation keeps the session\'s own tabs', () => {
  it('serial create: A creates T1 then T2, and may still close T1 while bound to T2', async () => {
    const host = makeHost(['X0', 'T1', 'T2']);
    const registry = wireRegistry(host);
    const record = await mint(registry, 'X0');

    await createTabAndRebind(host, registry, record.id, 'X0', 'T1');
    await createTabAndRebind(host, registry, record.id, 'T1', 'T2');

    assert.equal(host.isTabAllowedForPrimary('T2', 'T1'), true, 'T1 is still the session\'s tab');
    assert.equal(host.isTabAllowedForPrimary('T2', 'X0'), true, 'so is the original anchor');
    assert.deepEqual([...(host.sessionTabPools.get('X0') ?? [])].sort(), ['T1', 'T2', 'X0']);
  });

  it('sibling on a shared attachment: an explicit rebind to a sibling\'s tab keeps the tab the caller left', async () => {
    const host = makeHost(['X0', 'T1', 'T2']);
    const registry = wireRegistry(host);
    const record = await mint(registry, 'X0');

    // A opens T1; B (same attachment, same pool) opens T2; the attachment now names T2.
    await createTabAndRebind(host, registry, record.id, 'X0', 'T1');
    await createTabAndRebind(host, registry, record.id, 'T1', 'T2');
    // A explicitly rebinds back to its own tab.
    const back = await registry.updateAttachmentTab(record.id, 'T1', 3);
    assert.ok(back, 'explicit rebind to T1');

    assert.equal(host.isTabAllowedForPrimary('T1', 'T2'), true, 'B\'s tab stays reachable from A\'s binding');
    assert.equal(host.isTabAllowedForPrimary('T1', 'X0'), true);
  });

  it('closing the pool anchor leaves its children allowed', () => {
    const host = makeHost(['X0', 'T1', 'T2']);
    host.sessionTabPools.set('X0', new Set(['X0', 'T1', 'T2']));

    assert.equal(host.closeTab('X0', 'test'), true);

    assert.equal(host.tabs.has('X0'), false);
    assert.equal(host.isTabAllowedForPrimary('T1', 'T2'), true, 'the children keep their shared authority');
    assert.equal(host.sessionTabPools.has('X0'), false, 'the dead anchor no longer keys a pool');
    const [key, members] = [...host.sessionTabPools.entries()][0]!;
    assert.ok(key === 'T1' || key === 'T2', 'the pool is re-keyed to a live member');
    assert.deepEqual([...members].sort(), ['T1', 'T2']);
  });

  it('closing the last member of a pool still drops the pool', () => {
    const host = makeHost(['X0']);
    host.sessionTabPools.set('X0', new Set(['X0']));

    assert.equal(host.closeTab('X0', 'test'), true);

    assert.equal(host.sessionTabPools.size, 0);
  });

  it('re-keying merges into an existing pool instead of replacing it', () => {
    const host = makeHost(['X0', 'T1', 'T2']);
    host.sessionTabPools.set('X0', new Set(['X0', 'T1']));
    host.sessionTabPools.set('T1', new Set(['T2']));

    assert.equal(host.closeTab('X0', 'test'), true);

    assert.deepEqual([...(host.sessionTabPools.get('T1') ?? [])].sort(), ['T1', 'T2']);
  });
});

describe('a tab outside the managed set is still foreign', () => {
  it('refuses a close-style ownership check for another session\'s tab', async () => {
    const host = makeHost(['X0', 'T1', 'Y0', 'Y1']);
    const registry = wireRegistry(host);
    const record = await mint(registry, 'X0');
    await createTabAndRebind(host, registry, record.id, 'X0', 'T1');
    host.sessionTabPools.set('Y0', new Set(['Y0', 'Y1']));

    assert.equal(host.isTabAllowedForPrimary('T1', 'Y1'), false);
    const description = host.describeTabOwnership('T1', 'Y1');
    assert.equal(description.allowed, false);
    assert.equal(description.targetOwner, 'other-session');
    assert.deepEqual(description.managedTabIds.sort(), ['T1', 'X0']);
  });

  it('rebinding away to an unmanaged tab still releases the old tab', async () => {
    const host = makeHost(['X0', 'Y0']);
    const registry = wireRegistry(host);
    host.sessionTabPools.set('X0', new Set(['X0']));
    const record = await mint(registry, 'X0');

    const rotated = await registry.updateAttachmentTab(record.id, 'Y0', 2);

    assert.ok(rotated);
    assert.equal(host.sessionTabPools.has('X0'), false, 'the slot X0 held is released');
  });

  it('refuses a rebind onto a foreign project tab without touching ownership', async () => {
    const host = makeHost(['X0', 'T1', 'F1']);
    const registry = wireRegistry(host);
    registry.setTabAffiliationResolver((tabId) => (tabId === 'F1' ? { projectId: 'project-foreign' } : undefined));
    const record = await mint(registry, 'X0');
    await createTabAndRebind(host, registry, record.id, 'X0', 'T1');

    await assert.rejects(
      () => registry.updateAttachmentTab(record.id, 'F1', 3),
      (err: unknown) => err instanceof CapabilityError && err.code === 'PROJECT_MISMATCH',
    );
    assert.equal(host.isTabAllowedForPrimary('T1', 'X0'), true, 'a refused rebind releases nothing');
  });

  it('describeTabOwnership reports an unpooled tab as unowned', () => {
    const host = makeHost(['X0', 'Z9']);
    host.sessionTabPools.set('X0', new Set(['X0']));
    const description = host.describeTabOwnership('X0', 'Z9');
    assert.equal(description.allowed, false);
    assert.equal(description.targetOwner, 'unowned');
    assert.equal(description.managedTotal, 1);
  });
});

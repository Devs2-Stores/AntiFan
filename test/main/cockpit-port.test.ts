/**
 * CockpitPort scope-memo contract (finding E).
 *
 * The port memoizes `resolveScope` per tab keyed on the tab URL — but the
 * workspace root half of the identity comes from the host's ambient
 * `resolveTabWorkspaceRoot`, so a URL-keyed memo can pin a PROVISIONAL
 * identity (workspaceRoot '') long after the real root resolves. Post-fix:
 * the root is re-resolved on every call (never memoized), so a provisional
 * first answer heals itself on the next resolution, and a real root that
 * later goes away is surfaced immediately rather than hidden behind the memo.
 *
 * `releaseTab` drops the memo entry wholesale; the test asserts the method is
 * wired and that a released tab resolves fresh — the memo must not answer for
 * a tab the port was told is gone.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { CockpitPort, type CockpitHostPort, type CockpitChecklistLoadResult, type CockpitChecklistMutateResult, type CockpitChecklistSaveResult, type CockpitQaState } from '../../src/main/tools/cockpit-port';
import { checklistScope, workspaceTag, UNKNOWN_WORKSPACE_TAG } from '../../src/shared/theme-checklist';
import { CapabilityError } from '../../src/shared/control-plane-contracts';

const IDLE_QA: CockpitQaState = { status: 'idle', issueCount: 0, updatedAt: 0 };
const EMPTY_LOAD: CockpitChecklistLoadResult = { scope: '', workspaceRoot: '', items: [], updatedAt: 0, existed: false, migrated: false, isProvisional: true };
const EMPTY_SAVE: CockpitChecklistSaveResult = { ok: false, scope: '', workspaceRoot: '', items: [], updatedAt: 0, isProvisional: true };
const EMPTY_MUTATE: CockpitChecklistMutateResult = { scope: '', workspaceRoot: '', items: [], updatedAt: 0, isProvisional: true };

interface HostDouble {
  host: CockpitHostPort;
  /** Roots the resolver returns in order; the last one is sticky. */
  roots: string[];
  /** Every (tabId, url) the resolver was asked about. */
  resolveCalls: Array<{ tabId: string; tabUrl: string }>;
  alive: { value: boolean };
  url: { value: string };
}

function makeHost(tabId: string, url: string, roots: string[]): HostDouble {
  const double: HostDouble = {
    roots,
    resolveCalls: [],
    alive: { value: true },
    url: { value: url },
    host: undefined as unknown as CockpitHostPort,
  };
  double.host = {
    hasTab: (id) => id === tabId && double.alive.value,
    getTabUrl: (id) => (id === tabId ? double.url.value : ''),
    resolveTabWorkspaceRoot: (id, tabUrl) => {
      double.resolveCalls.push({ tabId: id, tabUrl: tabUrl ?? '' });
      // Return the next queued root, then keep returning the last one.
      return double.roots.length > 1 ? double.roots.shift()! : (double.roots[0] ?? '');
    },
    navigateAndWait: async () => true,
    runThemeQa: async () => ({ ok: true }),
    getThemeQaState: () => IDLE_QA,
    checklistLoad: () => EMPTY_LOAD,
    checklistMutate: () => EMPTY_MUTATE,
    checklistSave: () => EMPTY_SAVE,
  };
  return double;
}

describe('CockpitPort scope identity', () => {
  it('never memoizes a provisional identity: a later-resolved root upgrades the scope', () => {
    // The host cannot resolve the workspace on the first call (theme not yet
    // identified), then can on the second — the URL never changed.
    const double = makeHost('tab-1', 'http://shop-a.local/', ['', 'E:\\Work\\themes\\shop-a']);
    const port = new CockpitPort(double.host);

    const first = port.resolveScope('tab-1');
    assert.strictEqual(first.isProvisional, true, 'an unresolved root is a provisional identity');
    assert.strictEqual(first.workspaceRoot, '');
    assert.strictEqual(first.scope, checklistScope('http://shop-a.local', UNKNOWN_WORKSPACE_TAG));

    const second = port.resolveScope('tab-1');
    assert.strictEqual(second.isProvisional, false, 'the provisional answer is not pinned by the memo');
    assert.strictEqual(second.workspaceRoot, 'E:\\Work\\themes\\shop-a');
    assert.strictEqual(second.scope, checklistScope('http://shop-a.local', workspaceTag('E:\\Work\\themes\\shop-a')));
    // Both calls consulted the host: the memo may key the URL-derived origin,
    // never the root.
    assert.strictEqual(double.resolveCalls.length, 2, 'the workspace root is re-resolved on every call');
  });

  it('re-resolves when a bound workspace later fails to resolve', () => {
    const double = makeHost('tab-1', 'http://shop-a.local/', ['E:\\Work\\themes\\shop-a', '']);
    const port = new CockpitPort(double.host);

    const bound = port.resolveScope('tab-1');
    assert.strictEqual(bound.isProvisional, false);
    assert.strictEqual(bound.workspaceRoot, 'E:\\Work\\themes\\shop-a');

    const unbound = port.resolveScope('tab-1');
    assert.strictEqual(unbound.isProvisional, true, 'a workspace that disappears is surfaced, not memoized');
    assert.strictEqual(unbound.scope, checklistScope('http://shop-a.local', UNKNOWN_WORKSPACE_TAG));
  });

  it('releaseTab drops the memoized entry for the released tab', () => {
    const double = makeHost('tab-1', 'http://shop-a.local/', ['E:\\Work\\themes\\shop-a']);
    const port = new CockpitPort(double.host);

    const bound = port.resolveScope('tab-1');
    assert.strictEqual(bound.isProvisional, false);

    assert.strictEqual(typeof port.releaseTab, 'function', 'releaseTab exists on the port');
    port.releaseTab('tab-1');

    // A released tab resolving again must consult the host fresh — a stale memo
    // answering for a closed tab is exactly the leak releaseTab exists to stop.
    const after = port.resolveScope('tab-1');
    assert.strictEqual(after.isProvisional, false);
    assert.strictEqual(after.workspaceRoot, 'E:\\Work\\themes\\shop-a');
    assert.ok(double.resolveCalls.length >= 2, 'the post-release resolve goes through the host, not the dropped memo');
  });

  it('rejects a dead or foreign tab id with TARGET_REQUIRED and forgets its memo', () => {
    const double = makeHost('tab-1', 'http://shop-a.local/', ['E:\\Work\\themes\\shop-a']);
    const port = new CockpitPort(double.host);
    port.resolveScope('tab-1');

    assert.throws(() => port.resolveScope('ghost-tab'), (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_REQUIRED');

    // Once the tab dies, resolveScope must refuse rather than serve the memo.
    double.alive.value = false;
    assert.throws(() => port.resolveScope('tab-1'), (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_REQUIRED');
    assert.strictEqual(port.releaseTab('tab-1'), undefined, 'releaseTab on a dead tab is a no-op, not a crash');
  });
});

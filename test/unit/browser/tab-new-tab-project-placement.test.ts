/**
 * Where a new agent tab lands relative to the project its capsule belongs to.
 *
 * Incident: a terminal owned by project "united" had its anchor and every later
 * `tabs.create` filed under project "sky" — the project the shared hub happened to be
 * presenting — while the tabs carried the "united" capsule. Placement and authority read
 * different sources: the capsule was verified against the target project, but the window
 * stamp was left to the host's default. These cases pin both halves of the repair:
 * a project-scoped window never takes another project's tab, and a hub stamps the
 * capsule's project rather than the one it is showing.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BrowserControlPort, type BrowserHostPort } from '../../../src/main/tools/browser-control-port';
import { TabAmbientAuthority } from '../../../src/main/browser/tab-ambient-authority';
import { TabAuthorityDirectory } from '../../../src/main/browser/tab-authority-directory';
import type { NativeTabHost } from '../../../src/main/browser/native-tab-host';
import type { ProjectWindowShell } from '../../../src/main/browser/project-window-shell';
import { CapabilityError } from '../../../src/shared/control-plane-contracts';
import type { BrowserTarget } from '../../../src/shared/control-plane-contracts';

type CreateCall = { url?: string; options?: Record<string, unknown> };

/** One window: its owner key, the tabs it holds (id → capsule) and what was created on it. */
class FakeWindowHost {
  readonly created: CreateCall[] = [];
  readonly tabs = new Map<string, string | undefined>();
  readonly pool = new Set<string>();
  constructor(private readonly owner: string) {}
  windowOwnerKey(): string { return this.owner; }
  hasTab(tabId: string): boolean { return this.tabs.has(tabId); }
  getTabCapsuleId(tabId?: string | null): string | undefined { return tabId ? this.tabs.get(tabId) : undefined; }
  createTab(url?: string, _activate?: boolean, options?: Record<string, unknown>): string {
    const id = `created-${this.created.length + 1}`;
    this.created.push({ url, options });
    this.tabs.set(id, typeof options?.capsuleId === 'string' ? options.capsuleId : undefined);
    return id;
  }
}

function shellFor(owner: { kind: 'unassigned' } | { kind: 'project'; projectId: string }): ProjectWindowShell {
  return { owner, window: { isDestroyed: () => false } } as unknown as ProjectWindowShell;
}

function world(windowOwner: 'unassigned' | 'project:project-sky') {
  const directory = new TabAuthorityDirectory();
  const window = new FakeWindowHost(windowOwner);
  directory.register(
    shellFor(windowOwner === 'unassigned' ? { kind: 'unassigned' } : { kind: 'project', projectId: 'project-sky' }),
    window as unknown as NativeTabHost,
  );
  // The anchor: a terminal-9 anchor minted under the Unitedvision capsule inside this window.
  window.tabs.set('tab-anchor', 'capsule-united');
  const authority = new TabAmbientAuthority({
    directory,
    capsules: () => [{ id: 'capsule-united', projectId: 'project-united', workspaceId: 'workspace-united' }],
  });
  const host = {
    hasTab: (tabId?: string | null) => Boolean(tabId && directory.hostForTab(tabId)),
    getTabList: () => [],
    getManagedTabIds: () => new Set(['tab-anchor']),
    resolveTabAffiliation: (tabId: string) => authority.measuredTabAffiliation(tabId),
    // The composition root's wiring: an anchored creation resolves its window through the
    // authority and forwards the project stamp with it.
    createTab: (url?: string, activate?: boolean, options?: Record<string, unknown>) => {
      const { anchorTabId, projectId, ...hostOptions } = (options ?? {}) as { anchorTabId?: string; projectId?: string };
      const target = authority.hostForNewTab(anchorTabId, projectId);
      return (target as unknown as FakeWindowHost).createTab(url, activate, anchorTabId && projectId ? { ...hostOptions, projectId } : hostOptions);
    },
    adoptChildTab: (_anchor: string, childTabId: string) => {
      window.pool.add(childTabId);
      return true;
    },
    closeTab: () => true,
    getAutomationTabId: () => 'tab-anchor',
    setAutomationTabId: () => {},
  } as unknown as BrowserHostPort;
  const target = {
    tabId: 'tab-anchor',
    documentGeneration: 1,
    browserEpoch: 1,
    runtimeId: 'rt-test',
    projectId: 'project-united',
    workspaceId: 'workspace-united',
  } as BrowserTarget;
  return { port: new BrowserControlPort(host), window, authority, target };
}

describe('New tab placement follows the capsule project', () => {
  it('refuses to place a project-united tab into the window of project-sky, creating nothing', () => {
    const { port, window, target } = world('project:project-sky');

    let refused: unknown;
    try {
      port.openTab({}, { target });
    } catch (error) {
      refused = error;
    }

    assert.ok(refused instanceof CapabilityError, `expected a CapabilityError, received ${String(refused)}`);
    assert.equal(refused.code, 'POLICY_DENIED');
    assert.equal(refused.details?.windowProjectId, 'project-sky');
    assert.equal(refused.details?.requestedProjectId, 'project-united');
    assert.equal(refused.details?.recovery, 'anti.browser.rebind_target');
    assert.deepStrictEqual(window.created, [], 'a tab was created in the foreign project window');
  });

  it('stamps a hub tab with the capsule project instead of leaving the hub to use the one it presents', () => {
    const { port, window, target } = world('unassigned');

    const result = port.openTab({}, { target });

    assert.deepStrictEqual(result, { tabId: 'created-1' });
    assert.equal(window.created.length, 1);
    assert.equal(window.created[0]?.options?.capsuleId, 'capsule-united');
    assert.equal(
      window.created[0]?.options?.projectId,
      'project-united',
      'no project stamp reached the hub, so it files the tab under whichever project it is showing',
    );
  });

  describe('TabAmbientAuthority.hostForNewTab', () => {
    function authorityWith(owner: string) {
      const directory = new TabAuthorityDirectory();
      const window = new FakeWindowHost(owner);
      window.tabs.set('tab-1', undefined);
      directory.register(shellFor({ kind: 'unassigned' }), window as unknown as NativeTabHost);
      return { authority: new TabAmbientAuthority({ directory }), window };
    }

    it('answers the anchor window when its project owner matches the requested project', () => {
      const { authority, window } = authorityWith('project:project-united');
      assert.strictEqual(authority.hostForNewTab('tab-1', 'project-united'), window);
    });

    it('answers the anchor window for the hub whichever project is requested', () => {
      const { authority, window } = authorityWith('unassigned');
      assert.strictEqual(authority.hostForNewTab('tab-1', 'project-united'), window);
    });

    it('does not police an anchored creation that names no project', () => {
      const { authority, window } = authorityWith('project:project-sky');
      assert.strictEqual(authority.hostForNewTab('tab-1', undefined), window);
    });

    it('still refuses an anchor no live window owns with TARGET_STALE', () => {
      const { authority } = authorityWith('unassigned');
      assert.throws(
        () => authority.hostForNewTab('tab-dead', 'project-united'),
        (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE',
      );
    });
  });
});

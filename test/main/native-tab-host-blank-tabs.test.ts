/**
 * A project window an agent opens must not fill its strip with pages nobody chose: no default
 * Google page for a window that was only opened to give an agent a tab, and no blank anchor
 * tab (`about:blank` minted by an automation caller) carried across a close and reopen, where
 * each new session would mint one more.
 *
 * Rows drive the real `restoreTabs()` and `buildPersistData()` on a prototype-only host, so
 * no window or process is created.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeTabHost, SAVED_TABS_SCHEMA_VERSION } from '../../src/main/browser/native-tab-host';
import { ownerKey } from '../../src/main/browser/project-window-shell';

const OWNER = { kind: 'project', projectId: 'project-00000000-0000-4000-8000-0000000007e2' } as const;

type Row = Record<string, unknown>;

function restoreWith(
  rows: Row[] | undefined,
  options?: { emptyWindowOk?: boolean },
  activeTabId?: string,
): { created: string[] } {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-blank-tabs-'));
  const tabsPath = path.join(tempRoot, 'saved-tabs.json');
  fs.writeFileSync(
    tabsPath,
    JSON.stringify({
      version: SAVED_TABS_SCHEMA_VERSION,
      owners: rows ? { [ownerKey(OWNER)]: { tabs: rows, activeTabId, updatedAt: Date.now() } } : {},
      updatedAt: Date.now(),
    }),
    'utf8',
  );

  const host: Record<string, unknown> = Object.create(NativeTabHost.prototype);
  host.shell = { owner: OWNER, isSidebarOpen: false, sidebarWidth: 380 };
  host.mutedSites = new Set<string>();
  host.bookmarks = [];
  host.tabOrder = [] as string[];
  host.tabs = new Map<string, unknown>();
  const created: string[] = [];
  host.createTab = (url: string) => {
    const id = `tab-${created.length + 1}`;
    created.push(url);
    (host.tabOrder as string[]).push(id);
    return id;
  };
  host.getTabsStoragePath = () => tabsPath;
  host.applyTerminalTabPrefs = () => {};
  host.restoreMutedSites = () => {};
  host.updateLayout = () => {};
  host.getToolbarHeight = () => 0;
  host.switchTab = () => true;
  try {
    (host.restoreTabs as (fallback?: string, opts?: { emptyWindowOk?: boolean }) => void)(undefined, options);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  return { created };
}

function persistWith(
  tabs: Array<{ id: string; url: string; mintedByAutomation?: boolean }>,
  activeTabId: string,
): { tabs: Array<{ id: string }>; activeTabId?: string } {
  const host: Record<string, unknown> = Object.create(NativeTabHost.prototype);
  host.shell = { owner: OWNER, isSidebarOpen: false, sidebarWidth: 380 };
  host.mutedSites = new Set<string>();
  host.bookmarks = [];
  host.tabOrder = tabs.map((tab) => tab.id);
  host.tabs = new Map(
    tabs.map((tab) => [
      tab.id,
      {
        state: { id: tab.id, url: tab.url, title: 'New Tab', zoomFactor: 1, devicePresetId: 'responsive' },
        ...(tab.mintedByAutomation ? { mintedByAutomation: true } : {}),
      },
    ]),
  );
  host.activeTabId = activeTabId;
  return (host.buildPersistData as () => { tabs: Array<{ id: string }>; activeTabId?: string }).call(host);
}

describe('windows opened for an agent', () => {
  it('start with no default page when asked to, with or without a saved record', () => {
    assert.deepEqual(restoreWith(undefined, { emptyWindowOk: true }).created, []);
    assert.deepEqual(restoreWith([], { emptyWindowOk: true }).created, []);
  });

  it('still come back with the default page when a person opens them', () => {
    assert.equal(restoreWith(undefined).created.length, 1);
  });
});

describe('blank tabs across a restore', () => {
  const REAL_A = { id: 'a', url: 'https://example.com/a', title: 'A' };
  const REAL_B = { id: 'b', url: 'https://example.com/b', title: 'B' };
  const BLANK_1 = { id: 'x1', url: 'about:blank', title: 'New Tab' };
  const BLANK_2 = { id: 'x2', url: 'about:blank', title: 'New Tab' };

  it('drops blank pages that sit beside real ones', () => {
    const { created } = restoreWith([REAL_A, BLANK_1, BLANK_2, REAL_B], undefined, 'b');
    assert.deepEqual(created, ['https://example.com/a', 'https://example.com/b']);
  });

  it('keeps a lone blank page: a window that held only a New Tab comes back with it', () => {
    const { created } = restoreWith([BLANK_1], undefined, 'x1');
    assert.deepEqual(created, ['about:blank']);
  });
});

describe('blank tabs across a save', () => {
  it('leaves out a blank tab an automation caller minted, and its active mark', () => {
    const persisted = persistWith(
      [
        { id: 'real', url: 'https://example.com/' },
        { id: 'anchor', url: 'about:blank', mintedByAutomation: true },
      ],
      'anchor',
    );
    assert.deepEqual(persisted.tabs.map((tab) => tab.id), ['real']);
    assert.equal(persisted.activeTabId, undefined, 'the saved active tab must name a saved row');
  });

  it('keeps what a person opened and what an automation tab became', () => {
    const persisted = persistWith(
      [
        { id: 'person-blank', url: 'about:blank' },
        { id: 'navigated', url: 'https://example.com/dash', mintedByAutomation: true },
      ],
      'navigated',
    );
    assert.deepEqual(persisted.tabs.map((tab) => tab.id), ['person-blank', 'navigated']);
    assert.equal(persisted.activeTabId, 'navigated');
  });
});

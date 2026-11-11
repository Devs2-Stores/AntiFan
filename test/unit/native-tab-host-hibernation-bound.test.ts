/**
 * Hibernation and idle-media freezing must fail closed when the attachment registry cannot be
 * read: a tab bound to an agent must never be unloaded or paused because a lookup threw.
 *
 * The host is a partially constructed `Object.create(NativeTabHost.prototype)` (same convention
 * as the presented-view suite); the journal is redirected to a temp runtime dir before the
 * first event is written.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { lifecycleLogDrained } from '../../src/main/diagnostics/main-lifecycle-log';

const RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-hibernation-bound-'));
process.env.ANTIFAN_RUNTIME_DIR = RUNTIME_DIR;

function unreadableRows(): Array<Record<string, unknown>> {
  const logPath = path.join(RUNTIME_DIR, 'logs', 'main.log');
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.includes('"event":"tabhost.hibernationBoundTabsUnreadable"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createHost(registryThrows: boolean) {
  const host: any = Object.create(NativeTabHost.prototype);
  const webContents = {
    isDestroyed: () => false,
    isCurrentlyAudible: () => false,
    isDevToolsOpened: () => false,
    id: 7,
  };
  const idleTab = {
    state: { id: 'idle-tab', url: 'https://example.com/', title: 'Idle' },
    view: { webContents },
    lastActiveAt: 1,
    agentActivityAt: 0,
  };
  host.isDisposed = false;
  host.tabs = new Map([['idle-tab', idleTab]]);
  host.activeTabId = 'other-tab';
  host.automationTabId = null;
  host.hibernationIdleMs = 1000;
  host.hibernatingTabIds = new Set<string>();
  host.unloadVetoedTabIds = new Set<string>();
  host.mediaFrozenTabs = new Set<string>();
  host.mediaFocusHandler = () => {};
  host.shell = { window: { isDestroyed: () => false, isVisible: () => false } };
  host.controlPlane = {
    runs: {
      attachments: {
        getActiveRecordIds: () => ['a', 'b'],
        getRecord: (id: string) => {
          if (id === 'a') return { tabId: 'some-other-bound-tab' };
          if (registryThrows) throw new Error('registry unreadable');
          return { tabId: 'yet-another-tab' };
        },
      },
    },
  };
  const hibernateCalls: string[] = [];
  host.hibernateTab = async (id: string) => {
    hibernateCalls.push(id);
    return true;
  };
  const pauseCalls: string[] = [];
  host.pauseIdleMedia = async (id: string) => {
    pauseCalls.push(id);
  };
  return { host, hibernateCalls, pauseCalls };
}

describe('hibernation bound-tab lookup', () => {
  it('an unreadable attachment registry vetoes hibernation instead of letting it through', async () => {
    await lifecycleLogDrained();
    const before = unreadableRows().length;
    const { host, hibernateCalls } = createHost(true);

    assert.equal(await host.beginTabHibernation('idle-tab'), false);
    assert.deepEqual(hibernateCalls, []);

    await lifecycleLogDrained();
    const rows = unreadableRows();
    assert.ok(rows.length > before, 'the unreadable registry must be journaled');
    assert.match(String(rows.at(-1)?.error), /registry unreadable/);
  });

  it('a healthy registry still lets an idle unbound tab hibernate', async () => {
    const { host, hibernateCalls } = createHost(false);
    assert.equal(await host.beginTabHibernation('idle-tab'), true);
    assert.deepEqual(hibernateCalls, ['idle-tab']);
  });

  it('an unreadable attachment registry means no idle media is frozen', async () => {
    const { host, pauseCalls } = createHost(true);
    host.tabs.get('idle-tab').view.webContents.isCurrentlyAudible = () => true;
    await host.sweepIdleMedia();
    assert.deepEqual(pauseCalls, []);
  });

  it('a healthy registry lets an idle unbound tab with audible media be frozen', async () => {
    const { host, pauseCalls } = createHost(false);
    host.tabs.get('idle-tab').view.webContents.isCurrentlyAudible = () => true;
    await host.sweepIdleMedia();
    assert.deepEqual(pauseCalls, ['idle-tab']);
  });

  it('a CDP probe that throws keeps that tab awake', async () => {
    const { host, hibernateCalls } = createHost(false);
    host.tabs.get('idle-tab').view.webContents.isDevToolsOpened = () => {
      throw new Error('probe failed');
    };
    assert.equal(await host.beginTabHibernation('idle-tab'), false);
    assert.deepEqual(hibernateCalls, []);
  });

  it('journals a lasting registry failure once, and again only after a successful read', async () => {
    await lifecycleLogDrained();
    const before = unreadableRows().length;
    const { host } = createHost(true);
    const attachments = host.controlPlane.runs.attachments;
    const failing = attachments.getRecord;

    for (let i = 0; i < 4; i += 1) host.hibernationBoundTabIds();
    await lifecycleLogDrained();
    assert.equal(unreadableRows().length, before + 1, 'repeated identical failures write one row');

    attachments.getRecord = () => ({ tabId: 'fine' });
    host.hibernationBoundTabIds();
    attachments.getRecord = failing;
    host.hibernationBoundTabIds();
    await lifecycleLogDrained();
    assert.equal(unreadableRows().length, before + 2, 'a failure after a good read is news again');
  });
});

/**
 * NativeTabHost tab-close telemetry.
 *
 * Every path that removes a tab — toolbar, context menu, MCP tool, bridge RPC,
 * adopt-failure cleanup, attachment dispose, webContents close/destroyed, the idle
 * reaper, authorized close attempts, and host disposal — must leave exactly one
 * `tabhost.tabClosed` row in the lifecycle journal carrying the caller's `source`
 * plus capsule/project attribution. The live incident that motivated this suite was a
 * tab that vanished with no attributable row: `disposeChildViewContents` cleared the
 * map without passing through `closeTab` at all.
 *
 * `closeTab` here runs on a partially constructed host (`Object.create` + only the
 * fields the close path reads), the same convention as the close-disposal harness.
 * The journal is redirected to a temp runtime dir BEFORE the first event is recorded
 * — it resolves its path lazily on first write, so the user's real main.log is never
 * appended to.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';

const RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-tabclosed-runtime-'));
process.env.ANTIFAN_RUNTIME_DIR = RUNTIME_DIR;

function tabClosedRows(): Array<Record<string, unknown>> {
  const logPath = path.join(RUNTIME_DIR, 'logs', 'main.log');
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.includes('"event":"tabhost.tabClosed"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * The fields real `closeTab` actually dereferences. Anything the teardown path
 * already guards with `?.` stays undefined on purpose — a partial host is the
 * contract.
 */
function createTelemetryHost(tabId: string, state: Record<string, unknown> = {}) {
  const host = Object.create(NativeTabHost.prototype);
  const record = {
    state: {
      id: tabId,
      url: 'https://store.example.com/page?utm=x',
      title: 'Store',
      ...state,
    },
    view: { webContents: undefined },
    projectId: 'proj-1',
    lastActiveAt: 1727000000000,
    agentActivityAt: 1727000001000,
  };
  host.isDisposed = false;
  host.tabs = new Map([[tabId, record]]);
  host.tabOrder = [tabId];
  host.activeTabId = '';
  host.closeAdmission = null;
  host.attemptAuthorizedCloses = new Set<string>();
  host.tabPreviewUnsubscribers = new Map();
  host.recentlyClosedTabs = [];
  host.sessionTabPools = new Map();
  host.closedTabAnchors = new Map();
  host.terminalAgentAffinity = new Map();
  host.automationTabId = null;
  host.isInspecting = false;
  host.automationHost = { agentWorkingRefs: new Map(), clearTabAgentWorking: () => {} };
  host.networkTracker = { detachTarget: () => {} };
  host.shell = { window: { isDestroyed: () => false, contentView: { children: [] } } };
  host.broadcastState = () => {};
  host.reassertPresentedView = () => {};
  host.isTerminalOnlyWindow = () => false;
  return { host, record };
}

describe('tabhost.tabClosed telemetry', () => {
  it('journals source, capsule, project and urlOrigin once when closeTab removes a tab', () => {
    const { host } = createTelemetryHost('agent-1', {
      offscreen: true,
      ephemeral: true,
      capsuleId: 'cap-9',
      url: 'https://store.example.com/page?utm=x',
    });

    assert.strictEqual(host.closeTab('agent-1', 'user-toolbar'), true);
    // A second close on the removed record is a no-op: double-emit is impossible.
    assert.strictEqual(host.closeTab('agent-1', 'user-toolbar'), false);

    const rows = tabClosedRows().filter((row) => row['tabId'] === 'agent-1');
    assert.strictEqual(rows.length, 1, 'one journal row per removal, no double-emit');
    const row = rows[0]!;
    assert.strictEqual(row['event'], 'tabhost.tabClosed');
    assert.strictEqual(row['source'], 'user-toolbar');
    assert.strictEqual(row['offscreen'], true);
    assert.strictEqual(row['ephemeral'], true);
    assert.strictEqual(row['capsuleId'], 'cap-9');
    assert.strictEqual(row['projectId'], 'proj-1');
    assert.strictEqual(row['urlOrigin'], 'https://store.example.com', 'http(s) URLs contribute their origin only');
    assert.strictEqual(row['lastActiveAt'], 1727000000000);
    assert.strictEqual(row['agentActivityAt'], 1727000001000);
  });

  it('falls back to the unspecified label when no caller names a source', () => {
    const { host } = createTelemetryHost('plain-1', { url: 'about:blank' });

    assert.strictEqual(host.closeTab('plain-1'), true);

    const rows = tabClosedRows().filter((row) => row['tabId'] === 'plain-1');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!['source'], 'unspecified');
    assert.strictEqual(rows[0]!['urlOrigin'], undefined, 'non-http(s) URLs carry no origin');
  });
});

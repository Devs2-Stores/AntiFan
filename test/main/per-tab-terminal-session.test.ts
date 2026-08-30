import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { AntiFanTab } from '../../src/shared/contracts';
import { TerminalManager } from '../../src/main/browser/terminal-manager';

const ROOT = path.resolve(__dirname, '../../..');

// Test seam: run NativeTabHost prototype methods without the full Electron
// constructor. Shape mirrors the real NativeTabRecord (native-tab-host.ts:153).
interface HostWebContents {
  isDestroyed: () => boolean;
  executeJavaScript: (code: string) => Promise<unknown>;
}
interface TabShell {
  state: AntiFanTab;
  view?: { webContents: HostWebContents };
}
interface PerTabHost {
  tabs: Map<string, TabShell>;
  activeTabId: string;
  inspectedTabId: string | null;
  isInspecting: boolean;
  inspectGeneration: number;
  inspectPollTimer: NodeJS.Timeout | null;
  broadcastState: () => void;
  getTabTerminalSession(tabId: string): string | undefined;
  setTabTerminalSession(tabId: string, sessionId?: string): boolean;
  getLastAnnotationSessionId(tabId?: string): string | undefined;
  setLastAnnotationSessionId(sessionId?: string, tabId?: string): void;
  startInspect(): void;
  stopInspect(targetTabId?: string): void;
}

// Test seam: NativeTabHost reads the TerminalManager singleton's listSessions()
// to validate remembered session ids. Override that public boundary so the
// helper logic runs against a controlled session set.
interface TerminalManagerOverride {
  listSessions: () => Array<{ id: string; name: string; cwd: string }>;
  getActiveSessionId: () => string;
}

function createHost(tabIds: string[]): PerTabHost {
  const host = Object.create(NativeTabHost.prototype) as unknown as PerTabHost;
  const tabs = new Map<string, TabShell>();
  for (const id of tabIds) {
    tabs.set(id, {
      state: { id, url: 'https://example.test/', title: 'Example', isLoading: false, canGoBack: false, canGoForward: false, zoomFactor: 1 },
    });
  }
  host.tabs = tabs;
  host.activeTabId = tabIds[0] ?? '';
  host.inspectedTabId = null;
  host.isInspecting = false;
  host.inspectGeneration = 0;
  host.inspectPollTimer = null;
  host.broadcastState = () => {};
  return host;
}

describe('Per-tab terminal memory in Popup Annotation', () => {
  const tm = TerminalManager.getInstance() as unknown as TerminalManagerOverride;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-pertab-test-'));
  let liveSessions: Array<{ id: string; name: string; cwd: string }> = [];
  let sessionA = 'terminal-A';
  let sessionB = 'terminal-B';

  before(() => {
    liveSessions = [
      { id: sessionA, name: 'Terminal A', cwd: tempDir },
      { id: sessionB, name: 'Terminal B', cwd: tempDir },
    ];
    tm.listSessions = () => liveSessions;
    tm.getActiveSessionId = () => sessionA;
  });

  after(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('keeps independent terminal choices per tab (the reported repro)', () => {
    const host = createHost(['tab-1', 'tab-2']);
    assert.strictEqual(host.setTabTerminalSession('tab-1', sessionA), true);
    assert.strictEqual(host.setTabTerminalSession('tab-2', sessionB), true);
    // Tab 1 still remembers A after tab 2 picked B.
    assert.strictEqual(host.getTabTerminalSession('tab-1'), sessionA);
    assert.strictEqual(host.getTabTerminalSession('tab-2'), sessionB);
    assert.strictEqual(host.tabs.get('tab-1')?.state.terminalSessionId, sessionA);
    assert.strictEqual(host.tabs.get('tab-2')?.state.terminalSessionId, sessionB);
  });

  it('legacy getters/setters default to the active tab and accept an explicit tabId', () => {
    const host = createHost(['tab-1', 'tab-2']);
    host.setTabTerminalSession('tab-1', sessionA);
    host.setTabTerminalSession('tab-2', sessionB);

    host.activeTabId = 'tab-1';
    assert.strictEqual(host.getLastAnnotationSessionId(), sessionA);
    host.activeTabId = 'tab-2';
    assert.strictEqual(host.getLastAnnotationSessionId(), sessionB);

    host.setLastAnnotationSessionId(sessionA, 'tab-2');
    assert.strictEqual(host.getTabTerminalSession('tab-2'), sessionA);
  });

  it('a brand-new tab without a prior choice falls back to undefined (popup preselects auto)', () => {
    const host = createHost(['tab-3']);
    assert.strictEqual(host.getTabTerminalSession('tab-3'), undefined);
    assert.strictEqual(host.tabs.get('tab-3')?.state.terminalSessionId, undefined);
  });

  it("persists an explicit 'auto' choice and rejects unknown session ids", () => {
    const host = createHost(['tab-1']);
    assert.strictEqual(host.setTabTerminalSession('tab-1', 'auto'), true);
    assert.strictEqual(host.getTabTerminalSession('tab-1'), 'auto');

    host.setTabTerminalSession('tab-1', 'terminal-9999');
    assert.strictEqual(host.getTabTerminalSession('tab-1'), undefined);
  });

  it('returns false when setting a terminal for an unknown tab', () => {
    const host = createHost(['tab-1']);
    assert.strictEqual(host.setTabTerminalSession('ghost-tab', sessionA), false);
  });

  it('startInspect injects only the inspected tab remembered session into its context', async () => {
    const host = createHost(['tab-1']);
    host.setTabTerminalSession('tab-1', sessionA);
    let injected = '';
    const wc: HostWebContents = {
      isDestroyed: () => false,
      executeJavaScript: async (code: string) => {
        if (code.includes('termContextScript') || code.includes('__antifanTerminalContext')) {
          injected = code;
        }
        return undefined;
      },
    };
    host.tabs.get('tab-1')!.view = { webContents: wc };
    host.startInspect();
    assert.match(injected, /annotationSessionId/);
    assert.ok(injected.includes(`"${sessionA}"`), 'injected context must carry the tab remembered session');
    assert.ok(injected.includes('"tabId"'), 'injected context must be tab-scoped');
    host.stopInspect('tab-1');
  });

  it('guarantees startInspect is idempotent when called repeatedly and advances inspectGeneration on stop', () => {
    const host = createHost(['tab-1']);
    let execCount = 0;
    const wc: HostWebContents = {
      isDestroyed: () => false,
      executeJavaScript: async () => {
        execCount++;
        return undefined;
      },
    };
    host.tabs.get('tab-1')!.view = { webContents: wc };

    // First startInspect
    host.startInspect();
    assert.strictEqual(host.isInspecting, true);
    const initialGen = host.inspectGeneration;
    assert.ok(initialGen > 0, 'Must increment inspectGeneration on start');
    const initialExecCount = execCount;
    const initialTimer = host.inspectPollTimer;

    // Second startInspect on the same active tab (e.g. rapid shortcut / menu clicks)
    host.startInspect();
    assert.strictEqual(host.isInspecting, true);
    assert.strictEqual(host.inspectGeneration, initialGen, 'Must NOT re-increment generation or re-run on duplicate start');
    assert.strictEqual(execCount, initialExecCount, 'Must NOT re-execute injected scripts');
    assert.strictEqual(host.inspectPollTimer, initialTimer, 'Must NOT leak or re-allocate duplicate timers');

    // stopInspect should invalidate the generation and clean up
    host.stopInspect('tab-1');
    assert.strictEqual(host.isInspecting, false);
    assert.strictEqual(host.inspectPollTimer, null);
    assert.strictEqual(host.inspectGeneration, initialGen + 1, 'Must increment inspectGeneration on stop to invalidate in-flight polls');
  });

  it('drops a remembered session once the terminal no longer exists (session killed)', () => {
    const host = createHost(['tab-1']);
    host.setTabTerminalSession('tab-1', sessionA);
    assert.strictEqual(host.getTabTerminalSession('tab-1'), sessionA);

    liveSessions = [];
    assert.strictEqual(host.getTabTerminalSession('tab-1'), undefined);
    assert.strictEqual(host.tabs.get('tab-1')?.state.terminalSessionId, undefined);
  });

  it('element-picker source no longer reads or writes the origin-shared localStorage key', () => {
    const pickerSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'browser', 'element-picker.ts'), 'utf8');
    assert.ok(!pickerSrc.includes('antifan_last_annotation_session_id'), 'origin-shared localStorage key must be gone from element-picker');
  });
});
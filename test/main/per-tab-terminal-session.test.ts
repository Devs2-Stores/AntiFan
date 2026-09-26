import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vm from 'node:vm';
import { createRequire } from 'node:module';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { AntiFanTab } from '../../src/shared/contracts';
import { TerminalManager } from '../../src/main/browser/terminal-manager';

const ROOT = path.resolve(__dirname, '../../..');

/**
 * jsdom is a dev dependency resolved at runtime: the compiled test may run from a
 * junctioned node_modules, and `ANTIFAN_JSDOM` can point at a directory holding it.
 * A missing jsdom skips the DOM-driven case instead of failing the lane.
 */
interface JsdomWindow {
  window: Window & typeof globalThis;
  getInternalVMContext: () => vm.Context;
}
function loadJsdom(): new (html: string, options: Record<string, unknown>) => JsdomWindow {
  const req = createRequire(__filename);
  const searchPaths = process.env.ANTIFAN_JSDOM
    ? [process.env.ANTIFAN_JSDOM, path.dirname(__filename)]
    : [path.dirname(__filename)];
  try {
    const resolved = req.resolve('jsdom', { paths: searchPaths });
    return (req(resolved) as { JSDOM: (new (html: string, options: Record<string, unknown>) => JsdomWindow) }).JSDOM;
  } catch (err) {
    throw new Error(`jsdom is a declared devDependency and a hard prerequisite of this suite; resolution failed (searched: ${searchPaths.join(', ')}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

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
  broadcastState: () => void;
  getTabTerminalSession(tabId: string): string | undefined;
  setTabTerminalSession(tabId: string, sessionId?: string): boolean;
  getLastAnnotationSessionId(tabId?: string): string | undefined;
  setLastAnnotationSessionId(sessionId?: string, tabId?: string): void;
  startInspect(): void;
  stopInspect(targetTabId?: string): void;
  resolveTabStrictWorkspace(targetSessionId?: string, tabUrl?: string): string;
}

// Test seam: NativeTabHost reads the TerminalManager singleton's listSessions()
// to validate remembered session ids and to build the annotation target list.
// Override that public boundary so the
interface TerminalManagerOverride {
  listSessions: () => Array<{ id: string; name: string; cwd: string; state?: 'running' | 'exited' | 'closed' | 'sleeping'; splitOf?: string }>;
  getActiveSessionId: () => string;
  getSession?: (id: string) => { id: string; name: string; cwd: string } | undefined;
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
  host.broadcastState = () => {};
  return host;
}

describe('Per-tab terminal memory in Popup Annotation', () => {
  const tm = TerminalManager.getInstance() as unknown as TerminalManagerOverride;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-pertab-test-'));
  let liveSessions: Array<{ id: string; name: string; cwd: string; state?: 'running' | 'exited' | 'closed' | 'sleeping'; splitOf?: string }> = [];
  let sessionA = 'terminal-A';
  let sessionB = 'terminal-B';

  before(() => {
    liveSessions = [
      { id: sessionA, name: 'Terminal A', cwd: tempDir, state: 'running' },
      { id: sessionB, name: 'Terminal B', cwd: tempDir, state: 'running' },
    ];
    tm.listSessions = () => liveSessions;
    tm.getActiveSessionId = () => sessionA;
    tm.getSession = (id: string) => liveSessions.find((s) => s.id === id);
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

  it('offers only running base sessions as annotation targets (no sleeping, no split pane)', async (t) => {
    const JSDOM = loadJsdom();
    const host = createHost(['tab-1']);
    host.setTabTerminalSession('tab-1', sessionA);
    liveSessions = [
      { id: sessionA, name: 'Terminal A', cwd: tempDir, state: 'running' },
      { id: 'terminal-nap', name: 'Terminal NAP', cwd: tempDir, state: 'sleeping' },
      { id: 'terminal-dead', name: 'Terminal DEAD', cwd: tempDir, state: 'exited' },
      { id: 'terminal-split', name: 'Terminal split-1', cwd: tempDir, state: 'running', splitOf: sessionA },
    ];

    let injected = '';
    const wc: HostWebContents = {
      isDestroyed: () => false,
      executeJavaScript: async (code: string) => {
        if (code.includes('__antifanTerminalContext')) injected = code;
        return undefined;
      },
    };
    host.tabs.get('tab-1')!.view = { webContents: wc };
    host.startInspect();
    assert.ok(injected.includes('__antifanTerminalContext'), 'the picker context must be injected');

    // Run the real injected script in a DOM and open the modal the way a click does:
    // the assertion is on the <option> rows the user actually sees, not on the payload.
    const dom = new JSDOM('<!doctype html><html><body><div class="grid">x</div></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const ctx = dom.getInternalVMContext();
    vm.runInContext(injected, ctx);
    const target = dom.window.document.querySelector('.grid') as HTMLElement;
    target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    const select = dom.window.document.getElementById('antifanTerminalSelect') as HTMLSelectElement | null;
    assert.ok(select, 'the annotation modal must render its target select');
    assert.deepStrictEqual(
      Array.from(select.options).map((o) => o.value),
      ['auto', sessionA],
      'only the running base session may be offered beside auto'
    );
    host.stopInspect('tab-1');
    dom.window.close();
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

    // Second startInspect on the same active tab (e.g. rapid shortcut / menu clicks)
    host.startInspect();
    assert.strictEqual(host.isInspecting, true);
    assert.strictEqual(host.inspectGeneration, initialGen, 'Must NOT re-increment generation or re-run on duplicate start');
    assert.strictEqual(execCount, initialExecCount, 'Must NOT re-execute injected scripts');

    // stopInspect should invalidate the generation and clean up
    host.stopInspect('tab-1');
    assert.strictEqual(host.isInspecting, false);
    assert.strictEqual(host.inspectGeneration, initialGen + 1, 'Must increment inspectGeneration on stop');
  });

  it('drops a remembered session once the terminal no longer exists (session killed)', () => {
    const host = createHost(['tab-1']);
    host.setTabTerminalSession('tab-1', sessionA);
    assert.strictEqual(host.getTabTerminalSession('tab-1'), sessionA);

    liveSessions = [];
    assert.strictEqual(host.getTabTerminalSession('tab-1'), undefined);
    assert.strictEqual(host.tabs.get('tab-1')?.state.terminalSessionId, undefined);
  });
  it('resolveTabStrictWorkspace fails closed without falling through to active session or CWD', () => {
    const host = createHost(['tab-1']);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-tab-ws-'));
    liveSessions = [{ id: sessionA, name: 'S1', cwd: tmpDir }];

    // 1. Explicit valid session returns cwd
    assert.strictEqual(host.resolveTabStrictWorkspace(sessionA), path.normalize(tmpDir));

    // 2. Unbound session (undefined, 'auto', invalid id) with no matching URL returns empty string
    assert.strictEqual(host.resolveTabStrictWorkspace(undefined, 'https://unknown-domain.com'), '');
    assert.strictEqual(host.resolveTabStrictWorkspace('auto', 'https://unknown-domain.com'), '');
    assert.strictEqual(host.resolveTabStrictWorkspace('non-existent-session-id', 'about:blank'), '');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('element-picker source no longer reads or writes the origin-shared localStorage key', () => {
    const pickerSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'browser', 'element-picker.ts'), 'utf8');
    assert.ok(!pickerSrc.includes('antifan_last_annotation_session_id'), 'origin-shared localStorage key must be gone from element-picker');
  });
});
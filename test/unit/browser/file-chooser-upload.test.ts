/**
 * file_upload through the native file chooser: a target that is not itself an <input type=file>
 * (or a caller that asks for the chooser) is clicked while the chooser is intercepted, and the
 * files go to the input the page names. The interception is always switched off again.
 */
import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CapabilityError } from '../../../src/shared/control-plane-contracts';
import {
  fileChooserTarget,
  interceptFileChooser,
  type FileChooserSession,
} from '../../../src/main/browser/file-chooser-intercept';
import { SemanticRefRegistry } from '../../../src/main/browser/semantic-ref-registry';
import { TabAutomationHost } from '../../../src/main/browser/tab-automation-host';
import { TabDevToolsHost, type TabDevToolsContext } from '../../../src/main/browser/tab-devtools-host';

type Sent = { method: string; params: Record<string, unknown> };

function scriptedSession(options: { failOn?: string } = {}) {
  const log: string[] = [];
  const handlers = new Set<(method: string, params: Record<string, unknown>) => void>();
  const session: FileChooserSession = {
    send: async (method, params) => {
      log.push(`${method}${params && 'enabled' in params ? `:${String(params.enabled)}` : ''}`);
      if (method === options.failOn) throw new Error('transport reset');
      return {};
    },
    onEvent: (handler) => {
      handlers.add(handler);
      log.push('subscribe');
      return () => { handlers.delete(handler); log.push('unsubscribe'); };
    },
  };
  return { session, log, emit: (method: string, params: Record<string, unknown>) => handlers.forEach((h) => h(method, params)), handlers };
}

describe('interceptFileChooser', () => {
  it('turns interception on, runs the trigger, returns the chooser, then turns interception off', async () => {
    const s = scriptedSession();
    const opened = await interceptFileChooser(s.session, async () => {
      s.log.push('trigger');
      s.emit('Page.fileChooserOpened', { frameId: 'F1', mode: 'selectMultiple', backendNodeId: 321 });
    });
    assert.deepEqual(opened, { frameId: 'F1', mode: 'selectMultiple', backendNodeId: 321 });
    assert.deepEqual(s.log, ['subscribe', 'Page.enable', 'Page.setInterceptFileChooserDialog:true', 'trigger', 'unsubscribe', 'Page.setInterceptFileChooserDialog:false']);
    assert.equal(s.handlers.size, 0);
  });

  it('switches interception off when the trigger throws', async () => {
    const s = scriptedSession();
    await assert.rejects(
      () => interceptFileChooser(s.session, async () => { throw new CapabilityError('EXECUTION_ERROR', 'click failed'); }),
      /click failed/
    );
    assert.equal(s.log.at(-1), 'Page.setInterceptFileChooserDialog:false');
    assert.equal(s.handlers.size, 0);
  });

  it('switches interception off and names the cause when the page opens no chooser', async () => {
    const s = scriptedSession();
    await assert.rejects(
      () => interceptFileChooser(s.session, async () => {}, 25),
      (err: unknown) => err instanceof CapabilityError && err.code === 'EXECUTION_ERROR' && err.details?.cause === 'file-chooser-not-opened'
    );
    assert.equal(s.log.at(-1), 'Page.setInterceptFileChooserDialog:false');
  });

  it('a transport that cannot switch interception off does not mask the result', async () => {
    const s = scriptedSession();
    const failingOff: FileChooserSession = {
      ...s.session,
      send: async (method, params) => {
        if (method === 'Page.setInterceptFileChooserDialog' && params?.enabled === false) throw new Error('target closed');
        return s.session.send(method, params);
      },
    };
    const opened = await interceptFileChooser(failingOff, async () => s.emit('Page.fileChooserOpened', { backendNodeId: 9 }));
    assert.equal(opened.backendNodeId, 9);
  });

  it('a chooser event that arrives before the trigger returns is not lost', async () => {
    const s = scriptedSession();
    const opened = await interceptFileChooser(s.session, async () => {
      s.emit('Page.fileChooserOpened', { backendNodeId: 5, mode: 'selectSingle' });
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.equal(opened.backendNodeId, 5);
  });
});

describe('fileChooserTarget', () => {
  it('returns the node the chooser belongs to', () => {
    assert.equal(fileChooserTarget({ backendNodeId: 12, mode: 'selectMultiple' }, 3), 12);
    assert.equal(fileChooserTarget({ backendNodeId: 12, mode: 'selectSingle' }, 1), 12);
  });

  it('refuses a chooser that names no input, and several files for a single-file chooser', () => {
    assert.throws(() => fileChooserTarget({ mode: 'selectMultiple' }, 1), (e: unknown) => e instanceof CapabilityError && e.code === 'EXECUTION_ERROR');
    assert.throws(() => fileChooserTarget({ backendNodeId: 1, mode: 'selectSingle' }, 2), (e: unknown) => e instanceof CapabilityError && e.code === 'INVALID_ARGUMENT');
  });
});

describe('TabAutomationHost.uploadFileInput through the file chooser', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-chooser-'));
  const upload = path.join(tmpRoot, 'orders.csv');
  before(() => fs.writeFileSync(upload, 'a,b\n1,2\n'));
  after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  /** A tab whose resolved element is `kind`; clicking a non-input element makes the page report a chooser for node 777. */
  function harness(options: { kind: 'button' | 'file-input' | 'none' }) {
    const sent: Sent[] = [];
    const dbg = new EventEmitter();
    let attached = true;
    Object.assign(dbg, {
      isAttached: () => attached,
      attach: () => { attached = true; },
      detach: () => { attached = false; },
      sendCommand: (method: string, params: Record<string, unknown> = {}) => {
        sent.push({ method, params });
        if (method === 'Runtime.evaluate') {
          return Promise.resolve(options.kind === 'none' ? { result: {} } : { result: { objectId: 'obj-1' } });
        }
        if (method === 'DOM.describeNode') return Promise.resolve({ node: { backendNodeId: 55 } });
        if (method === 'Runtime.callFunctionOn') {
          const fn = String(params.functionDeclaration || '');
          if (fn.includes('isFileInput')) return Promise.resolve({ result: { value: { isFileInput: options.kind === 'file-input' } } });
          if (fn.includes('getBoundingClientRect')) return Promise.resolve({ result: { value: { x: 120, y: 64, width: 90, height: 30 } } });
          return Promise.resolve({});
        }
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
          setImmediate(() => dbg.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'F', mode: 'selectMultiple', backendNodeId: 777 }));
        }
        return Promise.resolve({});
      },
    });
    const wcEvents = new EventEmitter();
    const wc = {
      id: 61,
      isDestroyed: () => false,
      getURL: () => 'https://shop.example/admin/orders',
      executeJavaScript: async () => undefined,
      debugger: dbg,
      on: wcEvents.on.bind(wcEvents),
      once: wcEvents.once.bind(wcEvents),
      removeListener: wcEvents.removeListener.bind(wcEvents),
    } as unknown as Electron.WebContents;
    const devToolsCtx = { getActiveTabId: () => 'tab-1', getTabRecord: () => ({ focusedPane: 'desktop' }), getTabWebContents: () => wc } as unknown as TabDevToolsContext;
    const devTools = new TabDevToolsHost(devToolsCtx);
    const tabRecord = { state: { id: 'tab-1', url: 'https://shop.example/admin/orders' } };
    const host = new TabAutomationHost({
      getTabWebContents: () => wc,
      getTabRecord: () => tabRecord,
      getAutomationTabId: () => 'tab-1',
      getActiveTabId: () => 'tab-1',
      getBrowserEpoch: () => 1,
      getSemanticDocumentGeneration: () => 1,
      semanticRefRegistry: new SemanticRefRegistry(),
      runTargetOperation: async (_tab: unknown, _pane: unknown, op: () => Promise<unknown>) => op(),
      broadcastState: () => {},
      syncFrameBackdrop: () => {},
      getAllTabs: () => [][Symbol.iterator](),
      tabDevToolsHost: devTools,
      resolveAnchorWorkspace: () => tmpRoot,
    } as unknown as ConstructorParameters<typeof TabAutomationHost>[0]);
    const methods = () => sent.map((s) => s.method);
    const interceptionSwitches = () => sent.filter((s) => s.method === 'Page.setInterceptFileChooserDialog').map((s) => s.params.enabled);
    return { host, sent, methods, interceptionSwitches };
  }

  it('clicks a button target with trusted input and attaches the file to the input the chooser names', async () => {
    const h = harness({ kind: 'button' });
    const res = await h.host.uploadFileInput('#import-orders', [upload]);
    assert.deepEqual(res, { success: true, uploadedCount: 1 });

    const pressed = h.sent.find((s) => s.method === 'Input.dispatchMouseEvent' && s.params.type === 'mousePressed');
    assert.ok(pressed, 'the element is clicked with trusted input');
    assert.equal(pressed.params.x, 120);
    assert.equal(pressed.params.y, 64);

    const files = h.sent.find((s) => s.method === 'DOM.setFileInputFiles');
    assert.ok(files);
    assert.deepEqual(files.params, { files: [fs.realpathSync(upload)], backendNodeId: 777 });
    assert.deepEqual(h.interceptionSwitches(), [true, false], 'interception is on only around the click');
    assert.ok(h.methods().indexOf('Input.dispatchMouseEvent') < h.methods().indexOf('DOM.setFileInputFiles'), 'the chooser opens before the files are set');
  });

  it('viaFileChooser reaches the chooser even when the resolved element is a file input', async () => {
    const h = harness({ kind: 'file-input' });
    const res = await h.host.uploadFileInput({ refOrSelector: 'input[type=file]', filePaths: [upload], viaFileChooser: true });
    assert.equal(res.success, true);
    assert.equal(h.sent.find((s) => s.method === 'DOM.setFileInputFiles')?.params.backendNodeId, 777);
    assert.deepEqual(h.interceptionSwitches(), [true, false]);
  });

  it('a real file input keeps the direct path: no click, no interception', async () => {
    const h = harness({ kind: 'file-input' });
    const res = await h.host.uploadFileInput('input[type=file]', [upload]);
    assert.equal(res.success, true);
    assert.equal(h.sent.find((s) => s.method === 'DOM.setFileInputFiles')?.params.backendNodeId, 55);
    assert.equal(h.methods().includes('Input.dispatchMouseEvent'), false);
    assert.deepEqual(h.interceptionSwitches(), []);
  });

  it('an element that cannot be resolved at all is still REF_NOT_FOUND', async () => {
    const h = harness({ kind: 'none' });
    await assert.rejects(
      () => h.host.uploadFileInput('#missing', [upload]),
      (err: unknown) => err instanceof CapabilityError && err.code === 'REF_NOT_FOUND'
    );
    assert.deepEqual(h.interceptionSwitches(), []);
  });
});

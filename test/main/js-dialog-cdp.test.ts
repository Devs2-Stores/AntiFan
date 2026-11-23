import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { TabDevToolsHost, type TabDevToolsContext } from '../../src/main/browser/tab-devtools-host';
import { CaptureError } from '../../src/main/verification/visual-capture';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { makeBrowserPolicy } from '../../src/main/tools/browser-capabilities';
import type { JsDialogDescription } from '../../src/main/browser/js-dialog-tracker';
import {
  CapabilityError,
  issueRuntimeLease,
  makeControlPlaneId,
  type CapabilityRequestContext,
} from '../../src/shared/control-plane-contracts';

type CommandHandler = (params: Record<string, unknown>) => Promise<unknown>;

/** One WebContents' scriptable CDP debugger: commands answer through `handlers`, events through `emitCdp`. */
function createDebugger() {
  const dbg = new EventEmitter();
  let attached = false;
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const handlers: Record<string, CommandHandler> = {
    // Chromium's own answer for a target with no dialog; a test that mocks a live dialog overrides this.
    'Page.handleJavaScriptDialog': () => Promise.reject(new Error('No dialog is showing')),
  };
  const detach = () => {
    attached = false;
    dbg.emit('detach', {}, 'target closed');
  };
  Object.assign(dbg, {
    isAttached: () => attached,
    attach: () => { attached = true; },
    detach,
    sendCommand: (method: string, params: Record<string, unknown> = {}) => {
      sent.push({ method, params });
      const handler = handlers[method];
      return handler ? handler(params) : Promise.resolve({});
    },
  });
  return { dbg, sent, handlers, detach, isAttached: () => attached };
}

function createWebContents(id: number) {
  const debuggerState = createDebugger();
  const events = new EventEmitter();
  const wc = {
    id,
    isDestroyed: () => false,
    debugger: debuggerState.dbg,
    on: events.on.bind(events),
    once: events.once.bind(events),
    removeListener: events.removeListener.bind(events),
  } as unknown as Electron.WebContents;
  return {
    wc,
    ...debuggerState,
    emitCdp: (method: string, params: Record<string, unknown> = {}) => debuggerState.dbg.emit('message', {}, method, params),
    openDialog: (type: string, message: string) =>
      debuggerState.dbg.emit('message', {}, 'Page.javascriptDialogOpening', { type, message, url: 'https://shop.example/comments', hasBrowserHandler: true }),
  };
}

/**
 * One tab with a desktop WebContents, a mobile pane view the tab record keeps, and an optional second
 * tab beside it. `splitMobile` controls whether the host still answers the mobile pane through
 * `getTabWebContents`.
 */
function createDialogTab(options: { mobile?: boolean; splitMobile?: boolean; sibling?: boolean } = {}) {
  const desktop = createWebContents(77);
  const mobile = options.mobile ? createWebContents(88) : undefined;
  const sibling = options.sibling ? createWebContents(99) : undefined;
  const view = { webContents: desktop.wc } as unknown as Electron.WebContentsView;
  const mobileView = mobile ? { webContents: mobile.wc } as unknown as Electron.WebContentsView : undefined;
  const siblingView = sibling ? { webContents: sibling.wc } as unknown as Electron.WebContentsView : undefined;
  const records = new Map<string, { view: Electron.WebContentsView; mobileView?: Electron.WebContentsView }>([
    ['tab-1', { view, mobileView }],
    ...(siblingView ? [['tab-2', { view: siblingView }] as [string, { view: Electron.WebContentsView }]] : []),
  ]);
  const ctx = {
    getTabWebContents: (tabId?: string, paneId?: string) => {
      if (tabId === 'tab-2') return paneId === 'mobile' ? null : sibling?.wc ?? null;
      if (tabId !== 'tab-1') return null;
      if (paneId === 'mobile') return options.splitMobile ? mobile?.wc ?? null : null;
      return desktop.wc;
    },
    getTabRecord: (tabId: string) => {
      const record = records.get(tabId);
      return record ? { ...record, state: {}, focusedPane: 'desktop' } : undefined;
    },
    getAllTabs: () => records.entries(),
  } as unknown as TabDevToolsContext;
  const host = new TabDevToolsHost(ctx);
  return {
    host,
    wc: desktop.wc,
    sent: desktop.sent,
    handlers: desktop.handlers,
    emitCdp: desktop.emitCdp,
    openDialog: desktop.openDialog,
    detach: desktop.detach,
    isAttached: desktop.isAttached,
    mobile,
    sibling,
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const sentMethods = (sent: Array<{ method: string }>) => sent.map((entry) => entry.method);

describe('JavaScript dialogs over CDP', () => {
  it('attaches and enables Page when a tab is armed, before any dialog can appear', () => {
    const tab = createDialogTab();
    tab.host.armJsDialogs(tab.wc);
    assert.strictEqual(tab.isAttached(), true);
    assert.deepStrictEqual(sentMethods(tab.sent), ['Page.enable']);
  });

  it('answers a confirm while the click whose mouseReleased opened it is still pending', async () => {
    const tab = createDialogTab();
    tab.host.armJsDialogs(tab.wc);
    const released = Promise.withResolvers<unknown>();
    let releaseSettled = false;
    tab.handlers['Input.dispatchMouseEvent'] = (params) => (params.type === 'mouseReleased'
      ? released.promise.finally(() => { releaseSettled = true; })
      : Promise.resolve({}));

    const click = tab.host.sendCdpCommand(tab.wc, 'Input.dispatchMouseEvent', { type: 'mouseReleased' }, 10_000);
    await tick();
    tab.openDialog('confirm', 'Xóa comment này?');

    // The click returns the dialog at once instead of timing out against the frozen page.
    await assert.rejects(click, (err: unknown) => {
      assert.ok(err instanceof CapabilityError);
      assert.strictEqual(err.code, 'DIALOG_OPEN');
      assert.deepStrictEqual(err.details?.dialog, { type: 'confirm', message: 'Xóa comment này?', url: 'https://shop.example/comments' });
      return true;
    });
    assert.strictEqual(tab.host.findOpenJsDialog('tab-1')?.dialog.message, 'Xóa comment này?');

    // New work on the frozen page is refused with the dialog, never queued behind it.
    await assert.rejects(tab.host.sendCdpCommand(tab.wc, 'Runtime.evaluate', { expression: '1' }), (err: unknown) => err instanceof CapabilityError && err.code === 'DIALOG_OPEN');
    assert.ok(!sentMethods(tab.sent).includes('Runtime.evaluate'));

    let answeredWhileReleasePending = false;
    tab.handlers['Page.handleJavaScriptDialog'] = () => {
      answeredWhileReleasePending = !releaseSettled;
      setImmediate(() => {
        tab.emitCdp('Page.javascriptDialogClosed', { result: false, userInput: '' });
        released.resolve({});
      });
      return Promise.resolve({});
    };
    const answer = await tab.host.answerJsDialog('tab-1', undefined, false);

    assert.strictEqual(answeredWhileReleasePending, true, 'the answer must bypass the queue the frozen mouseReleased holds');
    if (!answer.open) assert.fail('the answer must report the dialog it answered');
    assert.deepStrictEqual(tab.sent.find((entry) => entry.method === 'Page.handleJavaScriptDialog')?.params, { accept: false });
    assert.strictEqual(answer.action, 'dismiss');
    assert.strictEqual(answer.paneId, 'desktop');
    assert.strictEqual(answer.closedEventSeen, true);
    assert.strictEqual(answer.dialog?.type, 'confirm');
    assert.strictEqual(answer.nativeBox.closed, false, 'a host without a window has no native box to close');
    assert.strictEqual(tab.host.findOpenJsDialog('tab-1'), undefined);

    // Once the page resumes, the queue the click held drains and the next command runs.
    tab.handlers['Runtime.evaluate'] = () => Promise.resolve({ result: { value: 2 } });
    assert.deepStrictEqual(await tab.host.sendCdpCommand(tab.wc, 'Runtime.evaluate', { expression: '1+1' }), { result: { value: 2 } });
  });

  it('refuses with NO_DIALOG_OPEN when nothing shows, and frees a record the page no longer holds', async () => {
    const tab = createDialogTab();
    tab.host.armJsDialogs(tab.wc);
    await assert.rejects(tab.host.answerJsDialog('tab-1', undefined, true), (err: unknown) => err instanceof CapabilityError && err.code === 'NO_DIALOG_OPEN');

    tab.openDialog('alert', 'Đã lưu');
    const cleared = await tab.host.answerJsDialog('tab-1', undefined, true);
    if (cleared.open) assert.fail('a record the page does not hold must not be reported as answered');
    assert.strictEqual(cleared.stale, true);
    assert.strictEqual(cleared.dialog.message, 'Đã lưu');
    assert.strictEqual(tab.host.findOpenJsDialog('tab-1'), undefined);
  });

  it('keeps a record across a debugger detach and answers that dialog once the session is back', async () => {
    const tab = createDialogTab();
    tab.host.armJsDialogs(tab.wc);
    tab.openDialog('alert', 'Lỗi mạng');

    // A capture's geometry restore drains the target: the debugger detaches, the page keeps its dialog.
    tab.detach();
    assert.strictEqual(tab.host.findOpenJsDialog('tab-1')?.dialog.message, 'Lỗi mạng');
    await tick();
    assert.strictEqual(tab.isAttached(), true);
    assert.deepStrictEqual(sentMethods(tab.sent), ['Page.enable', 'Page.enable']);

    tab.handlers['Page.handleJavaScriptDialog'] = () => {
      setImmediate(() => tab.emitCdp('Page.javascriptDialogClosed', { result: true }));
      return Promise.resolve({});
    };
    const answer = await tab.host.answerJsDialog('tab-1', undefined, true);
    if (!answer.open) assert.fail('the answer must report the dialog it answered');
    assert.strictEqual(answer.action, 'accept');
    assert.strictEqual(answer.dialog?.message, 'Lỗi mạng');
    assert.strictEqual(tab.host.findOpenJsDialog('tab-1'), undefined);
  });

  it('frees a tab whose recorded dialog the page no longer holds', async () => {
    const tab = createDialogTab();
    tab.host.armJsDialogs(tab.wc);
    tab.openDialog('confirm', 'Xoá bài này khỏi danh sách?');

    // Everything but the dialog capability is refused while the record stands.
    await assert.rejects(
      tab.host.sendCdpCommand(tab.wc, 'Runtime.evaluate', { expression: '1' }),
      (err: unknown) => err instanceof CapabilityError && err.code === 'DIALOG_OPEN'
    );

    // The page holds no dialog any more (answered natively, or lost with the session that reported it).
    const cleared = await tab.host.answerJsDialog('tab-1', undefined, false);
    if (cleared.open) assert.fail('a record the page does not hold must not be reported as answered');
    assert.strictEqual(cleared.stale, true);
    assert.strictEqual(cleared.dialog.type, 'confirm');
    assert.strictEqual(tab.host.findOpenJsDialog('tab-1'), undefined);

    // The stale refusal is gone, so the tab runs work again instead of offering no way out.
    tab.handlers['Runtime.evaluate'] = () => Promise.resolve({ result: { value: 2 } });
    assert.deepStrictEqual(await tab.host.sendCdpCommand(tab.wc, 'Runtime.evaluate', { expression: '1+1' }), { result: { value: 2 } });
  });

  it('answers a beforeunload dialog the page reports', async () => {
    const tab = createDialogTab();
    tab.host.armJsDialogs(tab.wc);
    tab.openDialog('beforeunload', '');

    const reported = await tab.host.findOpenJsDialog('tab-1');
    assert.strictEqual(reported?.dialog.type, 'beforeunload');

    tab.handlers['Page.handleJavaScriptDialog'] = (params) => {
      assert.deepStrictEqual(params, { accept: false });
      setImmediate(() => tab.emitCdp('Page.javascriptDialogClosed', { result: false }));
      return Promise.resolve({});
    };
    const answer = await tab.host.answerJsDialog('tab-1', undefined, false);
    if (!answer.open) assert.fail('the answer must report the dialog it answered');
    assert.strictEqual(answer.dialog?.type, 'beforeunload');
    assert.strictEqual(answer.closedEventSeen, true);
    assert.strictEqual(tab.host.findOpenJsDialog('tab-1'), undefined);
  });

  it('answers a dialog on a pane view the host no longer answers for that pane', async () => {
    const tab = createDialogTab({ mobile: true, splitMobile: false });
    const mobile = tab.mobile;
    if (!mobile) assert.fail('the tab record must hold the pane view');
    tab.host.armJsDialogs(mobile.wc);
    mobile.openDialog('confirm', 'Xoá bài này?');

    // The record is the only path to a pane view the tab record still holds but the host stops answering.
    assert.strictEqual(tab.host.findOpenJsDialog('tab-1')?.dialog.message, 'Xoá bài này?');
    assert.strictEqual(tab.host.findOpenJsDialog('tab-1', 'mobile')?.dialog.message, 'Xoá bài này?');

    mobile.handlers['Page.handleJavaScriptDialog'] = () => {
      setImmediate(() => mobile.emitCdp('Page.javascriptDialogClosed', { result: false }));
      return Promise.resolve({});
    };
    const answer = await tab.host.answerJsDialog('tab-1', 'mobile', false);
    if (!answer.open) assert.fail('the answer must report the dialog it answered');
    assert.strictEqual(answer.paneId, 'mobile');
    assert.strictEqual(tab.host.findOpenJsDialog('tab-1'), undefined);
  });

  it('answers a dialog the Page domain never reported, and refuses when the page has none', async () => {
    const tab = createDialogTab();
    tab.host.armJsDialogs(tab.wc);
    await assert.rejects(tab.host.answerJsDialog('tab-1', undefined, true), (err: unknown) => err instanceof CapabilityError && err.code === 'NO_DIALOG_OPEN');

    // A dialog that appeared while Page was off is invisible to the record but still parks the page.
    tab.handlers['Page.handleJavaScriptDialog'] = () => Promise.resolve({});
    const answer = await tab.host.answerJsDialog('tab-1', undefined, false);
    if (!answer.open) assert.fail('the answer must report the dialog it answered');
    assert.strictEqual(answer.untracked, true);
    assert.strictEqual(answer.dialog, undefined);
  });

  it('names the tab that is parked when the addressed tab has no dialog', async () => {
    const tab = createDialogTab({ sibling: true });
    const sibling = tab.sibling;
    if (!sibling) assert.fail('the harness must provide the second tab');
    tab.host.armJsDialogs(tab.wc);
    tab.host.armJsDialogs(sibling.wc);
    sibling.openDialog('confirm', 'Tab khác?');

    await assert.rejects(tab.host.answerJsDialog('tab-1', undefined, false), (err: unknown) => {
      assert.ok(err instanceof CapabilityError);
      assert.strictEqual(err.code, 'NO_DIALOG_OPEN');
      assert.deepStrictEqual(err.details?.openDialogs, [
        { tabId: 'tab-2', paneId: 'desktop', dialog: { type: 'confirm', message: 'Tab khác?', url: 'https://shop.example/comments' } },
      ]);
      return true;
    });

    sibling.handlers['Page.handleJavaScriptDialog'] = () => {
      setImmediate(() => sibling.emitCdp('Page.javascriptDialogClosed', { result: false }));
      return Promise.resolve({});
    };
    const answer = await tab.host.answerJsDialog('tab-2', undefined, false);
    if (!answer.open) assert.fail('the parked tab must be answerable');
    assert.strictEqual(answer.tabId, 'tab-2');
    assert.strictEqual(tab.host.findOpenJsDialog('tab-2'), undefined);
  });

  it('drains a command still frozen a second after its dialog closed, so the target cannot wedge', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tab = createDialogTab();
    tab.host.armJsDialogs(tab.wc);
    tab.handlers['Input.dispatchMouseEvent'] = () => new Promise<never>(() => {});
    const click = tab.host.sendCdpCommand(tab.wc, 'Input.dispatchMouseEvent', { type: 'mouseReleased' }, 10_000);
    await tick();
    tab.openDialog('confirm', 'Xóa?');
    await assert.rejects(click, (err: unknown) => err instanceof CapabilityError && err.code === 'DIALOG_OPEN');
    tab.emitCdp('Page.javascriptDialogClosed', { result: true });

    // The settle grace starts once the close resolves its waiter; step the clock past it.
    await tick();
    t.mock.timers.tick(1_000);
    await assert.rejects(
      tab.host.sendCdpCommand(tab.wc, 'Runtime.evaluate', {}, 50),
      (err: unknown) => err instanceof CaptureError && err.code === 'TARGET_BUSY_DRAINING'
    );
  });
});

describe('capability dispatch while a tab shows a JavaScript dialog', () => {
  const projectId = makeControlPlaneId('project');
  const workspaceId = makeControlPlaneId('workspace');
  const lease = issueRuntimeLease(projectId, workspaceId, 60_000, 1);
  const context = (): CapabilityRequestContext => ({
    lease,
    leaseToken: lease.token,
    projectId,
    workspaceId,
    runId: 'run-dialog',
    attemptId: 'attempt-dialog',
    grant: 'write',
    browserTarget: { tabId: 'tab-1', projectId, workspaceId, runtimeId: lease.runtimeId, browserEpoch: 1, documentGeneration: 1 },
  });

  function createCatalogue(openDialog: { current: JsDialogDescription | undefined }) {
    const executed: string[] = [];
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      getActiveLease: () => lease,
      getDocumentGeneration: () => 1,
      getOpenJsDialog: (tabId) => (tabId === 'tab-1' ? openDialog.current : undefined),
    });
    for (const name of ['browser.agent-click', 'anti.browser.dialog']) {
      catalogue.register({
        name,
        description: name,
        risk: 'write',
        requiresBrowserTarget: true,
        policy: makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'unbounded' }),
        inputSchema: { type: 'object', properties: {} },
        execute: () => {
          executed.push(name);
          return { ok: true };
        },
      });
    }
    return { catalogue, executed };
  }

  it('refuses page work with DIALOG_OPEN but still reaches the dialog capability', async () => {
    const dialog: JsDialogDescription = { type: 'confirm', message: 'Xóa comment này?', url: 'https://shop.example/' };
    const open = { current: dialog as JsDialogDescription | undefined };
    const { catalogue, executed } = createCatalogue(open);

    await assert.rejects(catalogue.dispatch('browser.agent-click', {}, context()), (err: unknown) => {
      assert.ok(err instanceof CapabilityError);
      assert.strictEqual(err.code, 'DIALOG_OPEN');
      assert.deepStrictEqual(err.details?.dialog, dialog);
      assert.strictEqual(err.details?.tabId, 'tab-1');
      return true;
    });
    assert.deepStrictEqual(await catalogue.dispatch('anti.browser.dialog', {}, context()), { ok: true });
    assert.deepStrictEqual(executed, ['anti.browser.dialog']);

    open.current = undefined;
    assert.deepStrictEqual(await catalogue.dispatch('browser.agent-click', {}, context()), { ok: true });
    assert.deepStrictEqual(executed, ['anti.browser.dialog', 'browser.agent-click']);
  });
});

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

/** One tab's WebContents with a scriptable CDP debugger: commands answer through `handlers`, events through `emitCdp`. */
function createDialogTab() {
  const dbg = new EventEmitter();
  let attached = false;
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const handlers: Record<string, CommandHandler> = {};
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
  const wcEvents = new EventEmitter();
  const wc = {
    id: 77,
    isDestroyed: () => false,
    debugger: dbg,
    on: wcEvents.on.bind(wcEvents),
    once: wcEvents.once.bind(wcEvents),
    removeListener: wcEvents.removeListener.bind(wcEvents),
  } as unknown as Electron.WebContents;
  const ctx = {
    getTabWebContents: (tabId?: string, paneId?: string) => (tabId === 'tab-1' && paneId !== 'mobile' ? wc : null),
  } as unknown as TabDevToolsContext;
  const host = new TabDevToolsHost(ctx);
  const emitCdp = (method: string, params: Record<string, unknown> = {}) => dbg.emit('message', {}, method, params);
  const openDialog = (type: string, message: string) =>
    emitCdp('Page.javascriptDialogOpening', { type, message, url: 'https://shop.example/comments', hasBrowserHandler: true });
  return { host, wc, sent, handlers, emitCdp, openDialog, detach, isAttached: () => attached };
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
    assert.deepStrictEqual(tab.sent.find((entry) => entry.method === 'Page.handleJavaScriptDialog')?.params, { accept: false });
    assert.strictEqual(answer.action, 'dismiss');
    assert.strictEqual(answer.paneId, 'desktop');
    assert.strictEqual(answer.closedEventSeen, true);
    assert.strictEqual(answer.dialog.type, 'confirm');
    assert.strictEqual(answer.nativeBox.closed, false, 'a host without a window has no native box to close');
    assert.strictEqual(tab.host.findOpenJsDialog('tab-1'), undefined);

    // Once the page resumes, the queue the click held drains and the next command runs.
    tab.handlers['Runtime.evaluate'] = () => Promise.resolve({ result: { value: 2 } });
    assert.deepStrictEqual(await tab.host.sendCdpCommand(tab.wc, 'Runtime.evaluate', { expression: '1+1' }), { result: { value: 2 } });
  });

  it('refuses with NO_DIALOG_OPEN when nothing shows, and forgets a dialog answered elsewhere', async () => {
    const tab = createDialogTab();
    tab.host.armJsDialogs(tab.wc);
    await assert.rejects(tab.host.answerJsDialog('tab-1', undefined, true), (err: unknown) => err instanceof CapabilityError && err.code === 'NO_DIALOG_OPEN');

    tab.openDialog('alert', 'Đã lưu');
    tab.handlers['Page.handleJavaScriptDialog'] = () => Promise.reject(new Error('No dialog is showing'));
    await assert.rejects(tab.host.answerJsDialog('tab-1', undefined, true), (err: unknown) => err instanceof CapabilityError && err.code === 'NO_DIALOG_OPEN');
    assert.strictEqual(tab.host.findOpenJsDialog('tab-1'), undefined);
  });

  it('re-attaches and re-enables Page after a detach, dropping the dialog it can no longer answer', async () => {
    const tab = createDialogTab();
    tab.host.armJsDialogs(tab.wc);
    tab.openDialog('alert', 'Lỗi mạng');

    tab.detach();
    assert.strictEqual(tab.host.findOpenJsDialog('tab-1'), undefined);
    await tick();

    assert.strictEqual(tab.isAttached(), true);
    assert.deepStrictEqual(sentMethods(tab.sent), ['Page.enable', 'Page.enable']);
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

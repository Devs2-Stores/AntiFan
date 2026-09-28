/**
 * Split-pane behaviour of `src/renderer/standalone.js`, driven through the shared vm harness.
 *
 * These cases replace source-text assertions with the behaviour they described: pane geometry
 * comes from the shipped `getSplitGeometry`/`applySplitRatio`, the toggle exercises the real
 * click handler, the shortcuts exercise the real custom key handler, and the context menu is
 * inspected through the DOM the renderer builds.
 */
import { describe, it, before, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import {
  loadStandalone,
  FakeElement,
  type KeyEventLike,
  type SplitGeometry,
  type StandaloneHarness,
} from './standalone-harness';

interface SplitCall {
  sessionId: string;
  geometry: { cols: number; rows: number };
}

const keyEvent = (key: string, modifiers: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key,
  type: 'keydown',
  preventDefault: () => {},
  stopPropagation: () => {},
  ...modifiers,
});

const px = (value: string | undefined): number => {
  const parsed = Number.parseFloat(String(value ?? '').replace('px', ''));
  assert.ok(Number.isFinite(parsed), `expected a pixel value, received "${value}"`);
  return parsed;
};

/** Flush pending microtasks and the immediates the renderer schedules. */
const settle = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

describe('Renderer split-pane behaviour', () => {
  let harness: StandaloneHarness;
  let splitCalls: SplitCall[];

  const splitPane = (): FakeElement => harness.elements.get('terminal-split')!;
  const geometry = (): SplitGeometry => harness.getSplitGeometry();

  const mountSplitFor = (sessionId: string, containerHeight: number): void => {
    harness.container.clientHeight = containerHeight;
    const mount = harness.read<(id: string, snapshot?: string, seq?: number) => void>('mountSplit');
    mount(sessionId, '', 0);
  };

  before(() => {
    harness = loadStandalone();
  });

  beforeEach(() => {
    splitCalls = [];
    harness.assign('splitEnabled = false; splitId = ""; splitTerm = null; activeId = "s1";');
    harness.assign('unmountSplit();');
    harness.api.splitTerminal = async (sessionId, target) => {
      splitCalls.push({ sessionId, geometry: target });
      return `${sessionId}-split`;
    };
  });

  it('sizes both panes from the measured geometry and keeps the main pane at the default ratio', () => {
    mountSplitFor('s1', 800);
    const geo = geometry();

    assert.strictEqual(geo.dividerTotal, harness.elements.get('terminal-divider')!.offsetHeight);
    assert.strictEqual(geo.usable, 800 - geo.dividerTotal);

    const mainHeight = px(harness.mainPane.style.height);
    const splitHeight = px(splitPane().style.height);
    assert.strictEqual(mainHeight + splitHeight, geo.usable, 'both panes must fill the usable height');
    assert.ok(splitHeight >= geo.paneMin, 'the split pane must not shrink below the pane minimum');
    assert.strictEqual(mainHeight, Math.round(geo.usable * 0.8), 'the main pane keeps the default ratio');
    assert.strictEqual(harness.mainPane.style.flex, `0 0 ${mainHeight}px`);
    assert.strictEqual(splitPane().style.flex, `0 0 ${splitHeight}px`);
  });

  it('clamps the pane minimum on tiny and oversized viewports', () => {
    for (const containerHeight of [20, 100, 400, 1600]) {
      harness.assign('unmountSplit();');
      mountSplitFor('s1', containerHeight);
      const geo = geometry();
      const mainHeight = px(harness.mainPane.style.height);
      const splitHeight = px(splitPane().style.height);

      assert.strictEqual(mainHeight + splitHeight, geo.usable, `height ${containerHeight} must stay fully allocated`);
      assert.ok(mainHeight >= geo.paneMin, `height ${containerHeight} must keep the main pane at or above the minimum`);
      assert.ok(splitHeight >= geo.paneMin, `height ${containerHeight} must keep the split pane at or above the minimum`);
      assert.ok(geo.paneMin <= 60, 'the pane minimum is capped');
    }
  });

  it('clamps a dragged split ratio so neither pane collapses', () => {
    mountSplitFor('s1', 800);
    const geo = geometry();
    const applyRatio = harness.read<(ratio: number, resizePty?: boolean) => void>('applySplitRatio');

    for (const ratio of [0.01, 0.35, 0.65, 0.99]) {
      applyRatio(ratio, false);
      const mainHeight = px(harness.mainPane.style.height);
      const splitHeight = px(splitPane().style.height);

      assert.strictEqual(mainHeight + splitHeight, geo.usable, `ratio ${ratio} must stay fully allocated`);
      assert.ok(mainHeight >= geo.paneMin, `ratio ${ratio} must keep the main pane at or above the minimum`);
      assert.ok(splitHeight >= geo.paneMin, `ratio ${ratio} must keep the split pane at or above the minimum`);
    }

    // An out-of-range ratio falls back to the default split.
    applyRatio(1.5, false);
    assert.strictEqual(px(harness.mainPane.style.height), Math.round(geo.usable * 0.8));
  });

  it('disables the split button while a split request is in flight and ignores repeat clicks', async () => {
    const splitGate = Promise.withResolvers<string>();
    harness.api.splitTerminal = (sessionId, target) => {
      splitCalls.push({ sessionId, geometry: target });
      return splitGate.promise;
    };

    harness.assign('activeId = "s1";');
    const onClick = harness.splitButton.onclick;
    assert.ok(onClick, 'the renderer must wire the split toggle button');

    const inFlight = onClick() as Promise<unknown>;
    assert.strictEqual(harness.splitButton.disabled, true, 'the toggle must be disabled while a split is in flight');
    const repeat = onClick() as Promise<unknown>;
    assert.strictEqual(splitCalls.length, 1, 'a repeat click must not start a second split request');

    splitGate.resolve('s1-split');
    await Promise.all([inFlight, repeat]);
    assert.strictEqual(harness.splitButton.disabled, false, 'the toggle must be re-enabled after the split settles');
  });

  it('routes the documented split chords through the terminal key handler and leaves other keys alone', () => {
    harness.assign('activeId = "s1";');
    const pane = harness.read<(id: string, snapshot?: string, seq?: number, authoritative?: boolean) => unknown>('getOrCreateTerminalPane');
    pane('s1', '', 0, false);
    const terminal = harness.terminals[harness.terminals.length - 1];
    assert.ok(terminal, 'a pane must have been created');
    const handler = terminal.customKeyHandler;
    assert.ok(handler, 'the pane must install a custom key handler');

    assert.strictEqual(handler(keyEvent('d')), true, 'a bare key must pass through to the shell');
    assert.strictEqual(splitCalls.length, 0);

    assert.strictEqual(handler(keyEvent('d', { ctrlKey: true, shiftKey: true })), false, 'Ctrl+Shift+D toggles the split');
    assert.strictEqual(handler(keyEvent('D', { altKey: true, shiftKey: true })), false, 'Alt+Shift+D toggles the split');
    assert.strictEqual(handler(keyEvent('\\', { ctrlKey: true })), false, 'Ctrl+\\ toggles the split');
  });

  it('labels the context menu action from the target session split state', () => {
    const splitItem = new FakeElement('div');
    splitItem.className = 'context-item';
    splitItem.setAttribute('data-action', 'split');
    const label = new FakeElement('span');
    splitItem.appendChild(label);
    harness.contextMenu.appendChild(splitItem);

    harness.assign('sessions = [{ id: "s1", splitSessionId: "s1-split" }, { id: "s2" }];');
    const menuEvent = { clientX: 10, clientY: 10, preventDefault: () => {}, stopPropagation: () => {} };

    harness.showContextMenu({ ...menuEvent, key: '' }, 's1');
    assert.strictEqual(label.textContent, 'Đóng chia đôi (Unsplit)');
    assert.strictEqual(harness.contextMenu.style.display, 'flex');

    harness.showContextMenu({ ...menuEvent, key: '' }, 's2');
    assert.strictEqual(label.textContent, 'Chia đôi tab (Split)');
    assert.match(splitItem.title, /Chia đôi màn hình terminal/);
  });

  it('opens a clicked terminal link through the owning-window route and states the refusal', async () => {
    const opened: string[] = [];
    const handed: string[] = [];
    // A tab surface is present throughout: it must stay untouched while the route answers, so
    // these rows also prove the fallback is not reached on the happy path or on a refusal.
    harness.api.createTab = async (url?: string) => {
      opened.push(`tab:${url}`);
      return 'tab-1';
    };
    harness.api.openExternal = (url?: string) => {
      opened.push(`external:${url}`);
      return undefined;
    };
    harness.api.openTerminalLink = async (sessionId: string, url: string) => {
      handed.push(`${sessionId} ${url}`);
      return { ok: true, sessionId, ownerKey: 'project:proj-phukien' };
    };

    const pane = harness.read<(id: string, snapshot?: string, seq?: number, authoritative?: boolean) => unknown>('getOrCreateTerminalPane');
    pane('link-session', '', 0, false);

    const handler = harness.webLinksHandlers[harness.webLinksHandlers.length - 1];
    assert.ok(handler, 'the pane must register a hyperlink handler with the web-links addon');

    handler({}, 'https://example.com/a');
    await settle();
    assert.deepStrictEqual(handed, ['link-session https://example.com/a'],
      'the click is offered to Main with the session that owns it, not to whichever tab surface is local');
    assert.deepStrictEqual(opened, [], 'a routed link must not also open in this window');

    // A refusal is final: the window that shows the notice is not the window that may open the tab.
    handed.length = 0;
    harness.api.openTerminalLink = async (sessionId: string, url: string) => {
      handed.push(`${sessionId} ${url}`);
      return { ok: false, reason: 'TARGET_WINDOW_ABSENT', message: 'Cua so du an dich chua mo' };
    };
    handler({}, 'https://example.com/b');
    await settle();
    assert.deepStrictEqual(handed, ['link-session https://example.com/b']);
    assert.deepStrictEqual(opened, [], 'a refused link must not fall back to the local tab surface');
    assert.strictEqual(
      harness.read<string>('terminalNoticeEl ? terminalNoticeEl.textContent : ""'),
      'Cua so du an dich chua mo',
      'the refusal Main typed is what the user reads',
    );

    // A malformed answer is not a success either: silence here would be a dead click.
    handed.length = 0;
    harness.api.openTerminalLink = async (sessionId: string, url: string) => {
      handed.push(`${sessionId} ${url}`);
      return undefined;
    };
    handler({}, 'https://example.com/c');
    await settle();
    assert.deepStrictEqual(opened, [], 'an answer that is not an explicit success opens nothing locally');
    assert.match(
      harness.read<string>('terminalNoticeEl ? terminalNoticeEl.textContent : ""'),
      /liên kết/,
      'an answer with no outcome still says the link did not open',
    );

    // A bridge failure is reported, not retried through the focused window.
    handed.length = 0;
    harness.api.openTerminalLink = async () => {
      throw new Error('bridge down');
    };
    handler({}, 'https://example.com/d');
    await settle();
    assert.deepStrictEqual(opened, [], 'a rejected route must not fall back to the local tab surface');
    assert.match(
      harness.read<string>('terminalNoticeEl ? terminalNoticeEl.textContent : ""'),
      /bridge down/,
      'the bridge failure is reported with its own reason',
    );

    // A drifted preload is a build fault, reported like the sibling handover route reports its own
    // missing method — never resolved by opening the tab in this window.
    harness.api.openTerminalLink = undefined;
    handler({}, 'https://example.com/e');
    await settle();
    assert.deepStrictEqual(opened, [], 'a preload without the route must not open the link locally');
    assert.match(
      harness.read<string>('terminalNoticeEl ? terminalNoticeEl.textContent : ""'),
      /preload thiếu openTerminalLink/,
      'the missing preload method is named',
    );

    // A pane with no session cannot be scoped, so it says so rather than guessing a window.
    harness.api.openTerminalLink = async (sessionId: string, url: string) => {
      handed.push(`${sessionId} ${url}`);
      return { ok: true, sessionId, ownerKey: 'unassigned' };
    };
    pane('', '', 0, false);
    const unscopedHandler = harness.webLinksHandlers[harness.webLinksHandlers.length - 1];
    assert.ok(unscopedHandler, 'the new pane registers its own handler');
    handed.length = 0;
    opened.length = 0;
    unscopedHandler({}, 'https://example.com/h');
    await settle();
    assert.deepStrictEqual(handed, [], 'a pane with no session id must not ask Main to open anything');
    assert.deepStrictEqual(opened, [], 'and it must not open the link locally either');
    assert.match(
      harness.read<string>('terminalNoticeEl ? terminalNoticeEl.textContent : ""'),
      /chưa xác định được phiên terminal/,
      'the unscoped pane says what is missing instead of opening elsewhere',
    );

    opened.length = 0;
    handler({}, '');
    await settle();
    assert.deepStrictEqual(opened, [], 'an empty uri must not open anything');
  });

  it('moves the focus class between panes and clears the split state on unmount', () => {
    mountSplitFor('s1', 800);
    const focusSplit = harness.read<() => void>('focusSplitPane');
    const focusMain = harness.read<() => void>('focusMainPane');

    focusSplit();
    assert.strictEqual(splitPane().classList.contains('focused-pane'), true);
    assert.strictEqual(harness.mainPane.classList.contains('focused-pane'), false);

    focusMain();
    assert.strictEqual(splitPane().classList.contains('focused-pane'), false);
    assert.strictEqual(harness.mainPane.classList.contains('focused-pane'), true);

    harness.assign('unmountSplit();');
    assert.strictEqual(harness.container.classList.contains('split'), false);
    assert.strictEqual(harness.splitButton.classList.contains('active'), false);
    assert.match(harness.splitButton.title, /Chia đôi màn hình terminal/);
  });
});

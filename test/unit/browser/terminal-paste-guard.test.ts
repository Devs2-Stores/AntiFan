import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Terminal Clipboard & Custom Key Handling (Native Paste Policy)', () => {
  function loadSetupTerminalClipboard() {
    const standaloneJsPath = path.resolve(__dirname, '../../../src/renderer/standalone.js');
    const standaloneCode = fs.readFileSync(standaloneJsPath, 'utf8');

    // Extract setupTerminalClipboard
    const fnMatch = standaloneCode.match(/function setupTerminalClipboard[\s\S]*?^}/m);
    assert.ok(fnMatch, 'setupTerminalClipboard must be defined in standalone.js');

    // Extract writeClipboard
    const writeClipMatch = standaloneCode.match(/function writeClipboard[\s\S]*?^}/m);
    assert.ok(writeClipMatch, 'writeClipboard must be defined in standalone.js');

    const sandbox = new Function('writeClipboard', `
      ${fnMatch[0]}
      return setupTerminalClipboard;
    `);

    let lastWrittenClipboard = '';
    const mockWriteClipboard = (t: string) => { lastWrittenClipboard = t; };
    const setupTerminalClipboard = sandbox(mockWriteClipboard);

    return {
      setupTerminalClipboard,
      getLastWrittenClipboard: () => lastWrittenClipboard,
    };
  }

  interface MockKeyEvent {
    type: string;
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    keyCode?: number;
    preventDefault?: () => void;
    stopPropagation?: () => void;
  }

  interface MockCustomEvent {
    type?: string;
    preventDefault?: () => void;
    stopPropagation?: () => void;
  }

  function createMockTerm(initialSelection = '') {
    let keyHandler: ((e: MockKeyEvent) => boolean) | null = null;
    const elementListeners = new Map<string, Array<(e: MockCustomEvent) => void>>();
    let currentSelection = initialSelection;
    let selectedAll = false;
    let cleared = false;

    const termMock = {
      element: {
        addEventListener: (evt: string, cb: (e: MockCustomEvent) => void) => {
          if (!elementListeners.has(evt)) elementListeners.set(evt, []);
          elementListeners.get(evt)!.push(cb);
        },
        removeEventListener: (evt: string, cb: (e: MockCustomEvent) => void) => {
          const arr = elementListeners.get(evt);
          if (arr) {
            const idx = arr.indexOf(cb);
            if (idx !== -1) arr.splice(idx, 1);
          }
        },
        dispatchEvent: (evt: MockCustomEvent) => {
          const arr = elementListeners.get(evt.type || '');
          if (arr) arr.forEach(cb => cb(evt));
        },
      },
      attachCustomKeyEventHandler: (handler: (e: MockKeyEvent) => boolean) => {
        keyHandler = handler;
      },
      hasSelection: () => Boolean(currentSelection),
      getSelection: () => currentSelection,
      clearSelection: () => { currentSelection = ''; },
      selectAll: () => { selectedAll = true; },
      clear: () => { cleared = true; },
      focus: () => {},
      dispatchKey: (evt: MockKeyEvent) => {
        if (!keyHandler) return true;
        return keyHandler(evt);
      },
      hasElementListener: (evt: string) => elementListeners.has(evt) && elementListeners.get(evt)!.length > 0,
      triggerElementEvent: (evtName: string, eventObj: MockCustomEvent) => {
        const arr = elementListeners.get(evtName);
        if (arr) arr.forEach(cb => cb(eventObj));
      },
      isCleared: () => cleared,
      isSelectedAll: () => selectedAll,
    };

    return termMock;
  }

  it('does NOT intercept Ctrl+V or Cmd+V, returning true for native browser/xterm handling', () => {
    const { setupTerminalClipboard } = loadSetupTerminalClipboard();
    const term = createMockTerm();
    setupTerminalClipboard(term);

    // Ctrl+V keydown event
    const ctrlVEvent = {
      type: 'keydown',
      key: 'v',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => { assert.fail('Ctrl+V must NOT call preventDefault'); },
      stopPropagation: () => { assert.fail('Ctrl+V must NOT call stopPropagation'); },
    };

    const handled = term.dispatchKey(ctrlVEvent);
    assert.strictEqual(handled, true, 'Ctrl+V must return true so xterm handles paste natively');

    // Cmd+V on macOS
    const cmdVEvent = {
      type: 'keydown',
      key: 'v',
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
      altKey: false,
      preventDefault: () => { assert.fail('Cmd+V must NOT call preventDefault'); },
      stopPropagation: () => { assert.fail('Cmd+V must NOT call stopPropagation'); },
    };

    const cmdHandled = term.dispatchKey(cmdVEvent);
    assert.strictEqual(cmdHandled, true, 'Cmd+V must return true so xterm handles paste natively');
  });

  it('does NOT register any custom DOM paste event listener on terminal element', () => {
    const { setupTerminalClipboard } = loadSetupTerminalClipboard();
    const term = createMockTerm();
    setupTerminalClipboard(term);

    assert.strictEqual(
      term.hasElementListener('paste'),
      false,
      'No custom paste listener should be attached to targetTerm.element'
    );
  });

  it('preserves Ctrl+C copy when selection exists and passes through when empty', () => {
    const { setupTerminalClipboard, getLastWrittenClipboard } = loadSetupTerminalClipboard();
    const termWithSelection = createMockTerm('selected text');
    setupTerminalClipboard(termWithSelection);

    let defaultPrevented = false;
    let propagationStopped = false;
    const copyEvent = {
      type: 'keydown',
      key: 'c',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => { defaultPrevented = true; },
      stopPropagation: () => { propagationStopped = true; },
    };

    const copyResult = termWithSelection.dispatchKey(copyEvent);
    assert.strictEqual(copyResult, false, 'Ctrl+C with selection must return false to prevent sending SIGINT');
    assert.strictEqual(defaultPrevented, true);
    assert.strictEqual(propagationStopped, true);
    assert.strictEqual(getLastWrittenClipboard(), 'selected text');

    // Without selection
    const termEmpty = createMockTerm('');
    setupTerminalClipboard(termEmpty);

    const sigintEvent = {
      type: 'keydown',
      key: 'c',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => { assert.fail('Must not prevent default on SIGINT'); },
      stopPropagation: () => { assert.fail('Must not stop propagation on SIGINT'); },
    };

    const sigintResult = termEmpty.dispatchKey(sigintEvent);
    assert.strictEqual(sigintResult, true, 'Ctrl+C without selection must return true to allow SIGINT');
  });

  it('preserves Ctrl+A select all and Ctrl+K clear', () => {
    const { setupTerminalClipboard } = loadSetupTerminalClipboard();
    const term = createMockTerm();
    setupTerminalClipboard(term);

    // Ctrl+A
    const selectAllEvent = {
      type: 'keydown',
      key: 'a',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => {},
      stopPropagation: () => {},
    };
    const aResult = term.dispatchKey(selectAllEvent);
    assert.strictEqual(aResult, false);
    assert.strictEqual(term.isSelectedAll(), true);

    // Ctrl+K
    const clearEvent = {
      type: 'keydown',
      key: 'k',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => {},
      stopPropagation: () => {},
    };
    const kResult = term.dispatchKey(clearEvent);
    assert.strictEqual(kResult, false);
    assert.strictEqual(term.isCleared(), true);
  });

  it('right-click contextmenu copies selected text without intercepting paste when empty', () => {
    const { setupTerminalClipboard, getLastWrittenClipboard } = loadSetupTerminalClipboard();
    const term = createMockTerm('selected for right-click');
    setupTerminalClipboard(term);

    let defaultPrevented = false;
    let propagationStopped = false;
    const cmEvent = {
      preventDefault: () => { defaultPrevented = true; },
      stopPropagation: () => { propagationStopped = true; },
    };

    term.triggerElementEvent('contextmenu', cmEvent);
    assert.strictEqual(defaultPrevented, true);
    assert.strictEqual(propagationStopped, true);
    assert.strictEqual(getLastWrittenClipboard(), 'selected for right-click');
    assert.strictEqual(term.hasSelection(), false, 'Selection should be cleared after right-click copy');

    // When empty
    defaultPrevented = false;
    const cmEmptyEvent = {
      preventDefault: () => { defaultPrevented = true; },
      stopPropagation: () => {},
    };
    term.triggerElementEvent('contextmenu', cmEmptyEvent);
    // No paste was called; clipboard unchanged
    assert.strictEqual(getLastWrittenClipboard(), 'selected for right-click');
  });
});

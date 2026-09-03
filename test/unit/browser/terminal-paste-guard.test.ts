import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Terminal Paste Safety Guard & Multiline Protection', () => {
  let sanitizePasteText: (text: string) => { isMultiline: boolean; text: string; lines: string[] };
  let showMultilinePasteModal: (rawText: string, lines: string[], sendInput: (t: string) => void, targetTerm?: any) => void;
  let dispatchSafePaste: (rawText: string, sendInput: (t: string) => void, targetTerm?: any) => void;

  // Lightweight pure DOM mock for testing modal lifecycle
  let mockElements: Map<string, any>;
  let mockWindowListeners: Map<string, Array<(e: any) => void>>;

  function createMockElement(id?: string, className?: string): any {
    const listeners = new Map<string, Array<(e: any) => void>>();
    const classes = new Set<string>();
    if (className) {
      className.split(' ').filter(Boolean).forEach(c => classes.add(c));
    }
    const el = {
      id: id || '',
      className: className || '',
      innerHTML: '',
      classList: {
        add: (c: string) => classes.add(c),
        remove: (c: string) => classes.delete(c),
        contains: (c: string) => classes.has(c),
      },
      addEventListener: (evt: string, cb: (e: any) => void) => {
        if (!listeners.has(evt)) listeners.set(evt, []);
        listeners.get(evt)!.push(cb);
      },
      removeEventListener: (evt: string, cb: (e: any) => void) => {
        const arr = listeners.get(evt);
        if (arr) {
          const idx = arr.indexOf(cb);
          if (idx !== -1) arr.splice(idx, 1);
        }
      },
      click: () => {
        const arr = listeners.get('click');
        if (arr) {
          arr.forEach(cb => cb({ target: el }));
        }
      },
      focus: () => {},
      querySelector: (selector: string) => {
        if (selector.startsWith('#')) {
          const targetId = selector.slice(1);
          return mockElements.get(targetId) || null;
        }
        return null;
      },
    };
    if (id) {
      mockElements.set(id, el);
    }
    return el;
  }

  beforeEach(() => {
    mockElements = new Map();
    mockWindowListeners = new Map();

    const mockDocument = {
      getElementById: (id: string) => mockElements.get(id) || null,
      createElement: (_tag: string) => {
        const el = createMockElement();
        return el;
      },
      body: {
        appendChild: (el: any) => {
          if (el.id) mockElements.set(el.id, el);
          return el;
        },
      },
      activeElement: null as any,
    };

    const mockWindow = {
      addEventListener: (evt: string, cb: (e: any) => void) => {
        if (!mockWindowListeners.has(evt)) mockWindowListeners.set(evt, []);
        mockWindowListeners.get(evt)!.push(cb);
      },
      removeEventListener: (evt: string, cb: (e: any) => void) => {
        const arr = mockWindowListeners.get(evt);
        if (arr) {
          const idx = arr.indexOf(cb);
          if (idx !== -1) arr.splice(idx, 1);
        }
      },
      dispatchEvent: (evt: any) => {
        const arr = mockWindowListeners.get(evt.type);
        if (arr) {
          arr.forEach(cb => cb(evt));
        }
      },
    };

    // Load functions from standalone.js via evaluation with mocked browser environment
    const standaloneJsPath = path.resolve(__dirname, '../../../src/renderer/standalone.js');
    const standaloneCode = fs.readFileSync(standaloneJsPath, 'utf8');

    // Extract sanitizePasteText
    const sanitizeMatch = standaloneCode.match(/function sanitizePasteText[\s\S]*?^}/m);
    assert.ok(sanitizeMatch, 'sanitizePasteText must be found in standalone.js');
    sanitizePasteText = new Function('return ' + sanitizeMatch[0])();

    // Create environment for showMultilinePasteModal and dispatchSafePaste
    const sandboxFn = new Function('document', 'window', 'sanitizePasteText', `
      let activePasteModalCleanup = null;
      ${standaloneCode.match(/function showMultilinePasteModal[\s\S]*?^}/m)![0]}
      ${standaloneCode.match(/function dispatchSafePaste[\s\S]*?^}/m)![0]}
      return { showMultilinePasteModal, dispatchSafePaste };
    `);

    const result = sandboxFn(mockDocument, mockWindow, sanitizePasteText);
    showMultilinePasteModal = result.showMultilinePasteModal;
    dispatchSafePaste = result.dispatchSafePaste;
  });

  describe('1. Trailing Newline Auto-Trim for Single-Line Commands', () => {
    it('preserves single-line command with no newline', () => {
      const res = sanitizePasteText('git status');
      assert.strictEqual(res.isMultiline, false);
      assert.strictEqual(res.text, 'git status');
      assert.deepStrictEqual(res.lines, ['git status']);
    });

    it('strips trailing \\n so command does NOT auto-execute on paste', () => {
      const res = sanitizePasteText('git status\n');
      assert.strictEqual(res.isMultiline, false);
      assert.strictEqual(res.text, 'git status');
      assert.deepStrictEqual(res.lines, ['git status']);
    });

    it('strips trailing \\r\\n so Windows PowerShell command does NOT auto-execute', () => {
      const res = sanitizePasteText('Get-Process antifan\r\n');
      assert.strictEqual(res.isMultiline, false);
      assert.strictEqual(res.text, 'Get-Process antifan');
      assert.deepStrictEqual(res.lines, ['Get-Process antifan']);
    });

    it('strips multiple redundant trailing newlines', () => {
      const res = sanitizePasteText('npm run test\r\n\n\r\n');
      assert.strictEqual(res.isMultiline, false);
      assert.strictEqual(res.text, 'npm run test');
      assert.deepStrictEqual(res.lines, ['npm run test']);
    });

    it('handles empty or falsy inputs safely', () => {
      const res1 = sanitizePasteText('');
      assert.strictEqual(res1.isMultiline, false);
      assert.strictEqual(res1.text, '');

      const res2 = (sanitizePasteText as any)(null);
      assert.strictEqual(res2.isMultiline, false);
      assert.strictEqual(res2.text, '');
    });
  });

  describe('2. Multiline Detection & Line Extraction', () => {
    it('correctly detects genuine two-line input with LF', () => {
      const res = sanitizePasteText('echo line1\necho line2');
      assert.strictEqual(res.isMultiline, true);
      assert.strictEqual(res.text, 'echo line1\necho line2');
      assert.deepStrictEqual(res.lines, ['echo line1', 'echo line2']);
    });

    it('correctly detects genuine multiline input with CRLF and trailing newline', () => {
      const res = sanitizePasteText('cd /app\r\nls -la\r\nnode index.js\r\n');
      assert.strictEqual(res.isMultiline, true);
      assert.deepStrictEqual(res.lines, ['cd /app', 'ls -la', 'node index.js']);
    });

    it('handles script blocks with internal empty lines', () => {
      const multiline = 'function test() {\n  console.log("hello");\n}\ntest();';
      const res = sanitizePasteText(multiline);
      assert.strictEqual(res.isMultiline, true);
      assert.strictEqual(res.lines.length, 4);
    });
  });

  describe('3. Unified Ingress Dispatch & Multiline Modal Interaction', () => {
    it('dispatches single-line directly to sendInput without opening modal', () => {
      let dispatchedText = '';
      const sendInput = (t: string) => { dispatchedText = t; };
      const termMock = { focus: () => {} };

      dispatchSafePaste('cargo build --release\r\n', sendInput, termMock);
      assert.strictEqual(dispatchedText, 'cargo build --release');

      const backdrop = mockElements.get('multilinePasteBackdrop');
      assert.strictEqual(backdrop?.classList.contains('active') ?? false, false);
    });

    it('opens modal on multiline paste and executes Primary action on Enter / Click', () => {
      let dispatchedText = '';
      const sendInput = (t: string) => { dispatchedText = t; };
      let focused = false;
      const termMock = { focus: () => { focused = true; } };

      const multilineText = 'npm install\r\nnpm run build';
      // Register buttons into mockElements so querySelector finds them
      createMockElement('btnPasteMultiLine');
      createMockElement('btnPasteSingleLine');
      createMockElement('btnPasteCancel');

      dispatchSafePaste(multilineText, sendInput, termMock);

      const backdrop = mockElements.get('multilinePasteBackdrop');
      assert.ok(backdrop);
      assert.strictEqual(backdrop.classList.contains('active'), true);

      const btnMulti = mockElements.get('btnPasteMultiLine');
      assert.ok(btnMulti, 'Primary multiline paste button must exist');

      // Click Primary: pastes raw multiline
      btnMulti.click();
      assert.strictEqual(dispatchedText, multilineText);
      assert.strictEqual(backdrop.classList.contains('active'), false);
      assert.strictEqual(focused, true, 'Focus must be restored to terminal');
    });

    it('joins commands with safe semicolon separator on Secondary action', () => {
      let dispatchedText = '';
      const sendInput = (t: string) => { dispatchedText = t; };
      const termMock = { focus: () => {} };

      const multilineText = 'git checkout main\ngit pull origin main\ngit status';
      createMockElement('btnPasteMultiLine');
      createMockElement('btnPasteSingleLine');
      createMockElement('btnPasteCancel');

      dispatchSafePaste(multilineText, sendInput, termMock);

      const backdrop = mockElements.get('multilinePasteBackdrop');
      assert.ok(backdrop);
      const btnSingle = mockElements.get('btnPasteSingleLine');

      btnSingle.click();
      assert.strictEqual(dispatchedText, 'git checkout main; git pull origin main; git status');
      assert.strictEqual(backdrop.classList.contains('active'), false);
    });

    it('cancels paste and restores focus on Cancel action', () => {
      let dispatchedText = '';
      const sendInput = (t: string) => { dispatchedText = t; };
      let focused = false;
      const termMock = { focus: () => { focused = true; } };

      const multilineText = 'rm -rf /\nrm -rf /home';
      createMockElement('btnPasteMultiLine');
      createMockElement('btnPasteSingleLine');
      createMockElement('btnPasteCancel');

      dispatchSafePaste(multilineText, sendInput, termMock);

      const backdrop = mockElements.get('multilinePasteBackdrop');
      assert.ok(backdrop);
      const btnCancel = mockElements.get('btnPasteCancel');

      btnCancel.click();
      assert.strictEqual(dispatchedText, '', 'No text should be sent on cancel');
      assert.strictEqual(backdrop.classList.contains('active'), false);
      assert.strictEqual(focused, true, 'Focus must be restored to terminal');
    });
  });
});

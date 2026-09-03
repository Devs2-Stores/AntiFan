import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CleanTabProtocol } from './clean-tab-protocol.js';

describe('CleanTabProtocol - Reversible State & Mutation Guard', () => {
  it('1. Captures and restores scroll position and probe elements', async () => {
    let mockScrollX = 150;
    let mockScrollY = 300;
    const injectedIds = ['data-probe-1'];

    const mockEvaluator = async (expr: string): Promise<unknown> => {
      if (expr.includes('window.scrollX')) {
        return { scrollX: mockScrollX, scrollY: mockScrollY, injectedElementIds: injectedIds };
      }
      if (expr.includes('window.scrollTo')) {
        // Parse arguments
        const match = expr.match(/window\.scrollTo\((\d+),\s*(\d+)\)/);
        if (match) {
          mockScrollX = Number(match[1]);
          mockScrollY = Number(match[2]);
        }
        return true;
      }
      return null;
    };

    const snapshot = await CleanTabProtocol.captureState(mockEvaluator);
    assert.strictEqual(snapshot.scrollX, 150);
    assert.strictEqual(snapshot.scrollY, 300);

    // Simulate mutation
    mockScrollX = 800;
    mockScrollY = 1200;

    // Restore
    const restored = await CleanTabProtocol.restoreState(mockEvaluator, snapshot);
    assert.strictEqual(restored, true);
    assert.strictEqual(mockScrollX, 150);
    assert.strictEqual(mockScrollY, 300);
  });

  it('2. withReversibleState guarantees cleanup in finally even when action throws', async () => {
    let restoredCalled = false;
    const mockEvaluator = async (expr: string): Promise<unknown> => {
      if (expr.includes('window.scrollTo')) {
        restoredCalled = true;
        return true;
      }
      return { scrollX: 0, scrollY: 0, injectedElementIds: [] };
    };

    const res = await CleanTabProtocol.withReversibleState(mockEvaluator, async () => {
      throw new Error('Test probe failure');
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.error, 'Test probe failure');
    assert.strictEqual(restoredCalled, true, 'Restore must be called in finally');
    assert.strictEqual(res.restored, true, 'res.restored must truthfully reflect successful restore');
  });

  it('2b. withReversibleState truthfully reports restored: true on successful action', async () => {
    const mockEvaluator = async (expr: string): Promise<unknown> => {
      if (expr.includes('window.scrollTo')) return true;
      return { scrollX: 10, scrollY: 20, injectedElementIds: [] };
    };

    const res = await CleanTabProtocol.withReversibleState(mockEvaluator, async () => 'action_result');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data, 'action_result');
    assert.strictEqual(res.restored, true);
  });

  it('2c. withReversibleState truthfully reports restored: false when cleanup fails', async () => {
    const failingEvaluator = async (expr: string): Promise<unknown> => {
      if (expr.includes('window.scrollTo')) {
        throw new Error('CDP evaluation failed during cleanup');
      }
      return { scrollX: 0, scrollY: 0, injectedElementIds: [] };
    };

    const res = await CleanTabProtocol.withReversibleState(failingEvaluator, async () => 'data_ok');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data, 'data_ok');
    assert.strictEqual(res.restored, false, 'res.restored must be false when cleanup evaluator throws');
  });

  it('3. assertCleanTab detects leaks and confirms clean environment', async () => {
    // 3a. Leaky tab
    const leakyEvaluator = async (): Promise<unknown> => ({
      clean: false,
      leaks: ['__antifanFreeze', 'style#antifan-qa-freeze']
    });

    const leakCheck = await CleanTabProtocol.assertCleanTab(leakyEvaluator);
    assert.strictEqual(leakCheck.clean, false);
    assert.strictEqual(leakCheck.leaks.length, 2);

    // 3b. Clean tab
    const cleanEvaluator = async (): Promise<unknown> => ({
      clean: true,
      leaks: []
    });

    const cleanCheck = await CleanTabProtocol.assertCleanTab(cleanEvaluator);
    assert.strictEqual(cleanCheck.clean, true);
    assert.strictEqual(cleanCheck.leaks.length, 0);
  });

  it('4. Captures and restores body class name and open dialog state', async () => {
    let mockBodyClass = 'theme-dark overflow-hidden';
    const mockEvaluator = async (expr: string): Promise<unknown> => {
      if (expr.includes('bodyClassName: document.body')) {
        return {
          scrollX: 0,
          scrollY: 0,
          bodyClassName: 'theme-default',
          injectedElementIds: [],
          openDialogIds: ['modal-1']
        };
      }
      if (expr.includes('document.body.className =')) {
        mockBodyClass = 'theme-default';
        return true;
      }
      return true;
    };

    const snapshot = await CleanTabProtocol.captureState(mockEvaluator);
    assert.strictEqual(snapshot.bodyClassName, 'theme-default');
    assert.deepStrictEqual(snapshot.openDialogIds, ['modal-1']);

    const restored = await CleanTabProtocol.restoreState(mockEvaluator, snapshot);
    assert.strictEqual(restored, true);
    assert.strictEqual(mockBodyClass, 'theme-default');
  });

  it('5. Restores empty body class when classes were mutated during probe', async () => {
    let mockBodyClass = 'mutated-probe-class overflow-hidden';
    const mockEvaluator = async (expr: string): Promise<unknown> => {
      if (expr.includes('bodyClassName: document.body')) {
        return {
          scrollX: 0,
          scrollY: 0,
          bodyClassName: '',
          injectedElementIds: []
        };
      }
      if (expr.includes('document.body.className = ""')) {
        mockBodyClass = '';
        return true;
      }
      return true;
    };

    const snapshot = await CleanTabProtocol.captureState(mockEvaluator);
    assert.strictEqual(snapshot.bodyClassName, '');

    const restored = await CleanTabProtocol.restoreState(mockEvaluator, snapshot);
    assert.strictEqual(restored, true);
    assert.strictEqual(mockBodyClass, '', 'Mutated classes must be cleared back to empty string');
  });

  it('6. Captures and restores inline style on body and html (preventing scroll lock)', async () => {
    let mockBodyStyle = 'overflow: hidden; padding-right: 15px;';
    let mockHtmlStyle = 'overflow: hidden;';
    const mockEvaluator = async (expr: string): Promise<unknown> => {
      if (expr.includes('bodyClassName: document.body')) {
        return {
          scrollX: 0,
          scrollY: 0,
          bodyClassName: '',
          bodyInlineStyle: '',
          htmlInlineStyle: 'color: red;',
          injectedElementIds: []
        };
      }
      if (expr.includes("document.body.removeAttribute('style')")) {
        mockBodyStyle = '';
      }
      if (expr.includes('const hStyle = "color: red;";') && expr.includes("document.documentElement.setAttribute('style', hStyle)")) {
        mockHtmlStyle = 'color: red;';
      }
      return true;
    };

    const snapshot = await CleanTabProtocol.captureState(mockEvaluator);
    assert.strictEqual(snapshot.bodyInlineStyle, '');
    assert.strictEqual(snapshot.htmlInlineStyle, 'color: red;');

    const restored = await CleanTabProtocol.restoreState(mockEvaluator, snapshot);
    assert.strictEqual(restored, true);
    assert.strictEqual(mockBodyStyle, '', 'Mutated body style must be stripped when original was empty');
    assert.strictEqual(mockHtmlStyle, 'color: red;', 'Mutated html style must revert to original');
  });

  it('7. withReversibleState truthfully reports probesCleared flag', async () => {
    const mockEvaluator = async (expr: string): Promise<unknown> => {
      if (expr.includes('window.scrollTo')) return true;
      return { scrollX: 0, scrollY: 0, injectedElementIds: [] };
    };

    const res = await CleanTabProtocol.withReversibleState(mockEvaluator, async () => 42);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data, 42);
    assert.strictEqual(res.restored, true);
    assert.strictEqual(res.probesCleared, true);
  });

  it('8. assertCleanProbes and assertCleanTab verify zero residual AntiFan artifacts', async () => {
    const evaluator = async (): Promise<unknown> => ({ clean: true, leaks: [] });
    const probeCheck = await CleanTabProtocol.assertCleanProbes(evaluator);
    assert.strictEqual(probeCheck.clean, true);
    assert.deepStrictEqual(probeCheck.leaks, []);

    const tabCheck = await CleanTabProtocol.assertCleanTab(evaluator);
    assert.strictEqual(tabCheck.clean, true);
  });
});

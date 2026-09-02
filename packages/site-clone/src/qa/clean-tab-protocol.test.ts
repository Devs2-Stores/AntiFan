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
});

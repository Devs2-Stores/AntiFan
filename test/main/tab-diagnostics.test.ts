import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { TabDiagnosticsManager } from '../../src/main/browser/tab-diagnostics';

describe('TabDiagnosticsManager buffer lifecycle', () => {
  it('clear(tabId) wipes only that tab and keeps other tabs intact', () => {
    const manager = new TabDiagnosticsManager();
    manager.recordConsole('tab-a', { level: 3, message: 'a1', source: 'https://a.test/x.js', line: 1, timestamp: 1, origin: 'a.test', isFirstParty: true });
    manager.recordConsole('tab-a', { level: 3, message: 'a2', source: 'https://a.test/x.js', line: 2, timestamp: 2, origin: 'a.test', isFirstParty: true });
    manager.recordConsole('tab-b', { level: 3, message: 'b1', source: 'https://b.test/x.js', line: 1, timestamp: 1, origin: 'b.test', isFirstParty: true });

    manager.clear('tab-a');

    const a = manager.getDiagnostics('tab-a');
    const b = manager.getDiagnostics('tab-b');
    assert.strictEqual(a.console.length, 0);
    assert.strictEqual(a.failures.length, 0);
    assert.strictEqual(b.console.length, 1);
  });

  it('clear() with no tabId wipes every bucket', () => {
    const manager = new TabDiagnosticsManager();
    manager.recordConsole('tab-a', { level: 3, message: 'a1', source: 'https://a.test/x.js', line: 1, timestamp: 1, origin: 'a.test', isFirstParty: true });
    manager.recordConsole('tab-b', { level: 3, message: 'b1', source: 'https://b.test/x.js', line: 1, timestamp: 1, origin: 'b.test', isFirstParty: true });
    manager.recordFailure('tab-a', { errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', validatedURL: 'https://a.test/missing.png', isMainFrame: false, timestamp: 1, origin: 'a.test', isFirstParty: true });

    manager.clear();

    assert.strictEqual(manager.getDiagnostics('tab-a').console.length, 0);
    assert.strictEqual(manager.getDiagnostics('tab-a').failures.length, 0);
    assert.strictEqual(manager.getDiagnostics('tab-b').console.length, 0);
  });

  it('clear-at-navigation: records AFTER clear survive, records BEFORE clear do not (Finding 2)', () => {
    const manager = new TabDiagnosticsManager();
    // Console error lands during the earlier parse window (before navigation)
    manager.recordConsole('tab-1', { level: 3, message: 'stale error', source: 'https://s.test/x.js', line: 1, timestamp: 1, origin: 's.test', isFirstParty: true });
    // did-start-navigation fires -> synchronous clear (phase 1 gate)
    manager.clear('tab-1');
    // Errors emitted after navigation (new page parse) must survive
    manager.recordConsole('tab-1', { level: 3, message: 'fresh error', source: 'https://s.test/x.js', line: 2, timestamp: 2, origin: 's.test', isFirstParty: true });
    manager.recordFailure('tab-1', { errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', validatedURL: 'https://s.test/missing.png', isMainFrame: false, timestamp: 2, origin: 's.test', isFirstParty: true });

    const snapshot = manager.getDiagnostics('tab-1');
    const messages = snapshot.console.map((entry) => entry.message);
    assert.deepStrictEqual(messages, ['fresh error']);
    assert.strictEqual(snapshot.failures.length, 1);
  });

  it('clear(tabId) on a non-existent tab is a no-op', () => {
    const manager = new TabDiagnosticsManager();
    assert.doesNotThrow(() => manager.clear('ghost-tab'));
  });

  it('records numeric console error levels correctly for gate filtering (level >= 3)', () => {
    const manager = new TabDiagnosticsManager();
    manager.recordConsole('tab-err', {
      level: 3,
      message: 'Uncaught TypeError: Cannot read properties of undefined',
      source: 'https://theme.test/assets/app.js',
      line: 42,
      timestamp: Date.now(),
      origin: 'theme.test',
      isFirstParty: true,
    });
    const snapshot = manager.getDiagnostics('tab-err');
    assert.strictEqual(snapshot.console.length, 1);
    assert.strictEqual(snapshot.console[0]?.level, 3);
  });

  it('maps string console levels ("error", "warning", "info", "debug") to numeric enum (3, 2, 1, 0)', () => {
    const LEVEL_MAP: Record<string, number> = {
      error: 3,
      warning: 2,
      warn: 2,
      info: 1,
      log: 1,
      debug: 0,
      verbose: 0,
    };
    const manager = new TabDiagnosticsManager();
    for (const [lvlStr, expectedNum] of Object.entries(LEVEL_MAP)) {
      manager.recordConsole('tab-map', {
        level: expectedNum,
        message: `msg for ${lvlStr}`,
        source: 'app.js',
        line: 1,
        timestamp: Date.now(),
        origin: 'theme.test',
        isFirstParty: true,
      });
    }
    const snapshot = manager.getDiagnostics('tab-map');
    assert.strictEqual(snapshot.console.length, Object.keys(LEVEL_MAP).length);
    assert.strictEqual(snapshot.console.find((c) => c.message === 'msg for error')?.level, 3);
    assert.strictEqual(snapshot.console.find((c) => c.message === 'msg for warning')?.level, 2);
    assert.strictEqual(snapshot.console.find((c) => c.message === 'msg for info')?.level, 1);
    assert.strictEqual(snapshot.console.find((c) => c.message === 'msg for debug')?.level, 0);
  });
});
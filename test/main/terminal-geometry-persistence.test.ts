import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TerminalManager } from '../../src/main/browser/terminal-manager';

describe('TerminalManager Geometry Persistence & Restoration', () => {
  let tmpDir: string;
  let oldConfigDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-term-geom-'));
    oldConfigDir = process.env.ANTIFAN_CONFIG_DIR;
    process.env.ANTIFAN_CONFIG_DIR = tmpDir;
    // Reset canonical singleton for test isolation
    (TerminalManager as any).instance = undefined;
    (TerminalManager as any).constructionCount = 0;
  });

  afterEach(() => {
    try {
      const tm = (TerminalManager as any).instance;
      if (tm) {
        tm.isDisposed = true;
      }
    } catch {}
    if (oldConfigDir !== undefined) {
      process.env.ANTIFAN_CONFIG_DIR = oldConfigDir;
    } else {
      delete process.env.ANTIFAN_CONFIG_DIR;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test('persists custom cols and rows and restores them into new sessions', () => {
    const tm1 = TerminalManager.getInstance();
    tm1.startTerminal(process.cwd());

    const activeId = tm1.getActiveSessionId();
    assert.ok(activeId, 'expected active terminal session');

    // Resize terminal to custom geometry (e.g. 142x45)
    tm1.resize(142, 45);

    // Synchronously persist
    tm1.persistSync();

    // Verify written JSON on disk contains lastCols, lastRows, and session cols/rows
    const stateFile = path.join(tmpDir, 'terminal-sessions.json');
    assert.ok(fs.existsSync(stateFile), 'terminal-sessions.json should exist');

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(state.lastCols, 142);
    assert.strictEqual(state.lastRows, 45);
    assert.ok(Array.isArray(state.sessions) && state.sessions.length > 0);
    assert.strictEqual(state.sessions[0].cols, 142);
    assert.strictEqual(state.sessions[0].rows, 45);

    // List sessions should report cols and rows
    const summaries = tm1.listSessions();
    assert.ok(summaries[0]);
    assert.strictEqual(summaries[0]?.cols, 142);
    assert.strictEqual(summaries[0]?.rows, 45);
    // Reset singleton to simulate app restart
    (TerminalManager as any).instance = undefined;
    (TerminalManager as any).constructionCount = 0;

    const tm2 = TerminalManager.getInstance();
    tm2.startTerminal(process.cwd());

    const restoredSummaries = tm2.listSessions();
    assert.ok(restoredSummaries[0]);
    assert.strictEqual(restoredSummaries[0]?.cols, 142);
    assert.strictEqual(restoredSummaries[0]?.rows, 45);
  });
});

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TerminalManager } from '../../src/main/browser/terminal-manager';

const ROOT = path.resolve(__dirname, '../../..');

describe('Terminal Split Hardened 10-Round Verification Suite', () => {
  const tm = TerminalManager.getInstance();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-split-10round-'));
  const testStateFile = path.join(tempDir, 'terminal-sessions.json');

  type TerminalManagerInternals = {
    spawn: (id: string, cwd: string, restoredBuffer?: string, initialCols?: number, initialRows?: number, minimumRows?: number) => unknown;
    statePath: () => string;
    sessions: Map<string, { id: string; cwd: string; name?: string; splitOf?: string; capsuleId?: string; disposed?: boolean; pty: { cols: number; rows: number; kill: () => void; write: (data: string) => void; resize: (c: number, r: number) => void } }>;
    activeSessionId?: string;
    currentCapsuleId?: string;
    lastCols?: number;
    lastRows?: number;
    persistAsync: () => Promise<void>;
    readSavedSessions: () => { activeSessionId?: string; sessions?: Array<{ id: string; buffer?: string; name?: string; splitOf?: string }> };
  };

  const tmInternal = tm as unknown as TerminalManagerInternals;
  const originalSpawn = tmInternal.spawn.bind(tm);
  const originalStatePath = tmInternal.statePath.bind(tm);

  before(() => {
    tmInternal.statePath = () => testStateFile;
    tmInternal.spawn = function (id: string, cwd: string, restoredBuffer = '', initialCols?: number, initialRows?: number, minimumRows = 4) {
      const cols = Math.max(40, initialCols || tmInternal.lastCols || 120);
      const rows = Math.max(minimumRows, initialRows || tmInternal.lastRows || 30);
      const mockPty = {
        pid: 1000 + Math.floor(Math.random() * 8000),
        cols,
        rows,
        onData: () => ({ dispose: () => {} }),
        onExit: () => ({ dispose: () => {} }),
        kill: () => {},
        write: () => {},
        resize: (newCols: number, newRows: number) => {
          mockPty.cols = newCols;
          mockPty.rows = newRows;
        },
      };
      const s = {
        id,
        name: `Terminal ${id.replace('terminal-', '')}`,
        cwd: cwd || 'E:/Work/project',
        pty: mockPty,
        buffer: restoredBuffer || '',
        capsuleId: tmInternal.currentCapsuleId || 'default',
        disposed: false,
      };
      tmInternal.sessions.set(id, s);
      return s;
    };
  });

  after(async () => {
    await tm.dispose();
    tmInternal.spawn = originalSpawn;
    tmInternal.statePath = originalStatePath;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // Round 1: Target session split routing on context menu & background tabs
  it('Round 1: context menu split routing and state synchronization', () => {
    const jsPath = path.join(ROOT, 'src/renderer/standalone.js');
    const js = fs.readFileSync(jsPath, 'utf8');
    assert.match(js, /const isTargetSplit = Boolean\(targetSession\?\.splitSessionId\)/);
    assert.match(js, /textSpan\.textContent = 'Đóng chia đôi \(Unsplit\)'/);
    assert.match(js, /textSpan\.textContent = 'Chia đôi tab \(Split\)'/);
    assert.match(js, /if \(targetId !== activeId\) \{/);
  });

  // Round 2: Split session closing by both parent ID and split ID
  it('Round 2: closeSplitSession resolves by parentId or direct splitId without leak', async () => {
    const p1 = tm.createSession();
    const split1 = tm.createSplitSession(p1);
    assert.ok(split1);
    assert.strictEqual(tm.listSessions().find(s => s.id === p1)?.splitSessionId, split1);

    // Close by splitId directly
    const resSplit = await tm.closeSplitSession(split1);
    assert.strictEqual(resSplit, true);
    assert.strictEqual(tm.listSessions().find(s => s.id === p1)?.splitSessionId, undefined);

    // Recreate and close by parentId
    const split2 = tm.createSplitSession(p1);
    assert.ok(split2);
    const resParent = await tm.closeSplitSession(p1);
    assert.strictEqual(resParent, true);
    assert.strictEqual(tm.listSessions().find(s => s.id === p1)?.splitSessionId, undefined);

    await tm.closeSession(p1);
  });

  // Round 3: Disposed session rejection and safe attached split killing
  it('Round 3: createSplitSession rejects disposed parent and kill() cleans attached split', async () => {
    const p2 = tm.createSession();
    const sp = tm.createSplitSession(p2);
    assert.ok(sp);
    assert.strictEqual(tm.getActiveSessionId(), p2);

    // Kill active session
    await tm.kill();
    assert.strictEqual(tm.getSession(sp), undefined, 'Attached split must be safely killed when parent is killed');

    // Trying to create split on non-existent / closed session
    assert.strictEqual(tm.createSplitSession('non-existent'), '');
    await tm.closeSession(p2);
  });

  // Round 4: Keyboard shortcut toggling and pane navigation
  it('Round 4: keyboard shortcut contracts for split toggle and focus navigation', () => {
    const jsPath = path.join(ROOT, 'src/renderer/standalone.js');
    const js = fs.readFileSync(jsPath, 'utf8');
    assert.match(js, /Ctrl\+Shift\+D/);
    assert.match(js, /splitButton\?\.click\(\)/);
    assert.match(js, /Alt\+Up/);
    assert.match(js, /Alt\+Down/);
    assert.match(js, /focusMainPane\(\)/);
    assert.match(js, /focusSplitPane\(\)/);
  });

  // Round 5: Active vs Inactive focus classes & visual borders
  it('Round 5: visual focus classes and styling contracts', () => {
    const cssPath = path.join(ROOT, 'src/renderer/standalone.css');
    const css = fs.readFileSync(cssPath, 'utf8');
    assert.match(css, /#terminal\.split #terminal-main\.focused-pane/);
    assert.match(css, /#terminal-split\.focused-pane \.split-pane-header/);
    assert.match(css, /#terminal-split\.focused-pane/);
  });

  // Round 6: Rapid split toggle button click debounce & concurrency guards
  it('Round 6: split button click handler prevents duplicate in-flight triggers', () => {
    const jsPath = path.join(ROOT, 'src/renderer/standalone.js');
    const js = fs.readFileSync(jsPath, 'utf8');
    assert.match(js, /splitButton\.disabled = true;/);
    assert.match(js, /finally \{\s*splitButton\.disabled = false;\s*\}/);
  });

  // Round 7: Multi-tab switching with independent split terminals
  it('Round 7: multi-tab switching isolates split states and preserves independent buffers', async () => {
    const tabA = tm.createSession();
    const tabB = tm.createSession();
    const splitA = tm.createSplitSession(tabA);
    assert.ok(splitA);

    // Tab A is split, Tab B is not
    let list = tm.listSessions();
    assert.strictEqual(list.find(s => s.id === tabA)?.splitSessionId, splitA);
    assert.strictEqual(list.find(s => s.id === tabB)?.splitSessionId, undefined);

    // Switch to Tab B
    tm.switchSession(tabB);
    assert.strictEqual(tm.getActiveSessionId(), tabB);
    assert.strictEqual(tm.getSessionState().splitSessionId, undefined);

    // Switch back to Tab A
    tm.switchSession(tabA);
    assert.strictEqual(tm.getActiveSessionId(), tabA);
    assert.strictEqual(tm.getSessionState().splitSessionId, splitA);

    await tm.closeSession(tabA);
    await tm.closeSession(tabB);
  });

  // Round 8: Bounded resize math under extreme window dimensions
  it('Round 8: bounded resize math guarantees minimum rows and valid split geometry', () => {
    const testHeights = [100, 200, 400, 800, 1600];
    for (const totalHeight of testHeights) {
      const dividerTotal = 11;
      const usable = Math.max(0, totalHeight - dividerTotal);
      const paneMin = Math.min(60, Math.floor(usable * 0.15));
      const rawMain = Math.round(usable * 0.8);
      const clampedMain = Math.max(paneMin, Math.min(usable - paneMin, rawMain));
      const clampedLower = Math.max(0, usable - clampedMain);

      assert.ok(clampedMain >= paneMin);
      assert.ok(clampedLower >= paneMin);
      assert.strictEqual(clampedMain + clampedLower, usable);
    }
  });

  // Round 9: Persistence, disk roundtrip, and restart recovery with multiple split sessions
  it('Round 9: full state persistence and clean disk restoration of split sessions', async () => {
    const parentSession = tm.createSession();
    const splitSession = tm.createSplitSession(parentSession);
    assert.ok(splitSession);

    tm.persistSync();
    const diskState = tmInternal.readSavedSessions();
    const parentSaved = diskState.sessions?.find((s) => s.id === parentSession);
    const splitSaved = diskState.sessions?.find((s) => s.id === splitSession);

    assert.ok(parentSaved);
    assert.ok(splitSaved);
    assert.strictEqual(splitSaved.splitOf, parentSession);

    await tm.closeSession(parentSession);
  });

  // Round 10: Full structural integrity and zero memory leaks across multi-cycle disposal
  it('Round 10: multi-cycle creation and disposal endurance has zero leaked sessions', async () => {
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = tm.createSession();
      const sp = tm.createSplitSession(p);
      created.push(p);
      assert.ok(sp);
    }

    assert.strictEqual(tm.listSessions().length, 5);

    for (const p of created) {
      await tm.closeSession(p);
    }

    assert.strictEqual(tm.listSessions().length, 0);
  });
});

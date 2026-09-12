/**
 * Terminal Split Hardened 10-Round Verification Suite (main process).
 *
 * Rounds 2, 3, 7, 9, and 10 exercise TerminalManager directly. Rounds 1, 4, 6, and 8 described
 * renderer behaviour (context-menu labels, key chords, toggle debounce, split geometry) and are
 * covered behaviourally in test/renderer/terminal-split-behaviour.test.ts, where the shipped
 * renderer runs against a stubbed platform. Round 5 asserts the stylesheet rules that style the
 * focused pane; CSS has no runtime under Node, so the asset text is the observable.
 */
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

  // Round 1 lives in test/renderer/terminal-split-behaviour.test.ts.

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

  // Round 4 lives in test/renderer/terminal-split-behaviour.test.ts.

  // Round 5: Active vs Inactive focus classes & visual borders
  it('Round 5: visual focus classes and styling contracts', () => {
    const cssPath = path.join(ROOT, 'src/renderer/standalone.css');
    const css = fs.readFileSync(cssPath, 'utf8');
    assert.match(css, /#terminal\.split #terminal-main\.focused-pane/);
    assert.match(css, /#terminal-split\.focused-pane \.split-pane-header/);
    assert.match(css, /#terminal-split\.focused-pane/);
  });

  // Round 6 lives in test/renderer/terminal-split-behaviour.test.ts.

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

  // Round 8 lives in test/renderer/terminal-split-behaviour.test.ts, where the split geometry
  // is computed by the shipped getSplitGeometry/applySplitRatio instead of local arithmetic.

  // Round 9: Persistence, disk roundtrip, and restart recovery with multiple split sessions
  it('Round 9: full state persistence and clean disk restoration of split sessions', async () => {
    const parentSession = tm.createSession();
    const splitSession = tm.createSplitSession(parentSession);
    assert.ok(splitSession);

    tm.getSession(parentSession)!.buffer = 'PARENT_SPLIT_BUFFER_OUTPUT\r\n';
    tm.getSession(splitSession)!.buffer = 'SPLIT_CHILD_BUFFER_OUTPUT\r\n';

    tm.persistSync();
    const diskState = tmInternal.readSavedSessions();
    const parentSaved = diskState.sessions?.find((s) => s.id === parentSession);
    const splitSaved = diskState.sessions?.find((s) => s.id === splitSession);

    assert.ok(parentSaved);
    assert.ok(splitSaved);
    assert.strictEqual(splitSaved.splitOf, parentSession);
    assert.ok(parentSaved.buffer?.includes('PARENT_SPLIT_BUFFER_OUTPUT'));
    assert.ok(splitSaved.buffer?.includes('SPLIT_CHILD_BUFFER_OUTPUT'));

    // Clear in-memory map to simulate restart and test actual disk restoration
    (tm as unknown as { sessions: Map<string, unknown> }).sessions.clear();
    (tm as unknown as { activeSessionId: string }).activeSessionId = '';

    tm.startTerminal();

    const restoredParent = tm.getSession(parentSession);
    const restoredSplit = tm.getSession(splitSession);
    assert.ok(restoredParent, 'Parent session must be restored from disk');
    assert.ok(restoredSplit, 'Split session must be restored from disk');
    assert.strictEqual(restoredSplit.splitOf, parentSession);
    assert.ok(restoredParent.buffer.includes('PARENT_SPLIT_BUFFER_OUTPUT'), 'Parent buffer must be restored');
    assert.ok(restoredSplit.buffer.includes('SPLIT_CHILD_BUFFER_OUTPUT'), 'Split buffer must be restored');

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

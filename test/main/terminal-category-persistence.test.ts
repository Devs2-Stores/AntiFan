import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TerminalManager } from '../../src/main/browser/terminal-manager';

describe('TerminalManager Category Persistence on Startup & Session Operations', () => {
  const tm = TerminalManager.getInstance();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-category-test-'));
  const testStateFile = path.join(tempDir, 'terminal-sessions.json');

  type TerminalManagerInternals = {
    spawn: (id: string, cwd: string, restoredBuffer?: string, initialCols?: number, initialRows?: number, minimumRows?: number) => unknown;
    statePath: () => string;
    sessions: Map<string, { id: string; cwd: string; name?: string; splitOf?: string; capsuleId?: string; category?: string; state?: string; disposed?: boolean; pty: { cols: number; rows: number; kill: () => void; write: (data: string) => void; resize: (c: number, r: number) => void } }>;
    activeSessionId?: string;
    currentCapsuleId?: string;
    lastCols?: number;
    lastRows?: number;
    persistAsync: () => Promise<void>;
    readSavedSessions: () => { activeSessionId?: string; sessions?: Array<{ id: string; buffer?: string; name?: string; splitOf?: string; category?: string; state?: string }> };
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
        name: `Terminal ${id}`,
        cwd: cwd || 'E:/Work/project',
        pty: mockPty,
        buffer: restoredBuffer || '',
        bufferBytes: Buffer.byteLength(restoredBuffer || '', 'utf8'),
        deliveryJournal: { clear: () => {} },
        capsuleId: tmInternal.currentCapsuleId || 'default',
        state: 'running',
        category: undefined as string | undefined,
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

  it('preserves category on startup for active session and its split pane', async () => {
    // Seed saved-tabs state file with active session and split session categorized as "CUSTOMIZES"
    const savedState = {
      activeSessionId: 'session-1',
      lastCols: 120,
      lastRows: 30,
      sessions: [
        {
          id: 'session-1',
          name: 'Hapas',
          cwd: 'E:/Work/hapas',
          state: 'running',
          category: 'CUSTOMIZES',
          buffer: 'hapas output',
        },
        {
          id: 'split-1',
          name: 'Terminal split-1',
          cwd: 'E:/Work/hapas',
          splitOf: 'session-1',
          state: 'running',
          category: 'CUSTOMIZES',
          buffer: 'split output',
        },
        {
          id: 'session-2',
          name: 'Bagamuioto',
          cwd: 'E:/Work/bagamuioto',
          state: 'running',
          category: 'CUSTOMIZES',
          buffer: 'baga output',
        },
        {
          id: 'session-3',
          name: 'SleepingProject',
          cwd: 'E:/Work/sleeping',
          state: 'sleeping',
          category: 'ANTIFAN',
          buffer: 'sleep output',
        },
      ],
    };
    fs.writeFileSync(testStateFile, JSON.stringify(savedState), 'utf8');

    tmInternal.sessions.clear();
    tmInternal.activeSessionId = '';

    tm.startTerminal();

    // Verify session-1 (the active session) preserved its category!
    const activeSession = tm.getSession('session-1');
    assert.ok(activeSession, 'session-1 must be restored');
    assert.strictEqual(activeSession.category, 'CUSTOMIZES', 'active session category must be CUSTOMIZES, not undefined');

    // Verify split-1 preserved its category
    const splitSession = tm.getSession('split-1');
    assert.ok(splitSession, 'split-1 must be restored');
    assert.strictEqual(splitSession.category, 'CUSTOMIZES', 'split session category must be CUSTOMIZES');

    // Verify session-2 (background session) preserved its category
    const session2 = tm.getSession('session-2');
    assert.ok(session2, 'session-2 must be restored');
    assert.strictEqual(session2.category, 'CUSTOMIZES', 'background session category must be CUSTOMIZES');

    // Verify session-3 (sleeping session) preserved its category
    const session3 = tm.getSession('session-3');
    assert.ok(session3, 'session-3 must be restored');
    assert.strictEqual(session3.category, 'ANTIFAN', 'sleeping session category must be ANTIFAN');

    // Now verify disk persistence does not wipe the category
    tm.persistSync();
    const diskState = JSON.parse(fs.readFileSync(testStateFile, 'utf8'));
    const savedActive = diskState.sessions?.find((s: { id: string }) => s.id === 'session-1');
    assert.strictEqual(savedActive?.category, 'CUSTOMIZES', 'persisted active session category must remain CUSTOMIZES');
  });

  it('preserves category and attributes on session restart', async () => {
    const s = tm.getSession('session-1');
    assert.ok(s);
    assert.strictEqual(s.category, 'CUSTOMIZES');

    await tm.restart();

    const restarted = tm.getSession('session-1');
    assert.ok(restarted, 'session-1 must exist after restart');
    assert.strictEqual(restarted.category, 'CUSTOMIZES', 'category must survive session restart');
  });

  it('assigns parent category to newly created split session', () => {
    const splitId = tm.createSplitSession('session-1');
    assert.ok(splitId);
    const split = tm.getSession(splitId);
    assert.ok(split);
    assert.strictEqual(split.category, 'CUSTOMIZES', 'new split must inherit parent category');
  });

  it('updates split pane categories when parent category is changed', () => {
    tm.setCategory('session-1', 'SHOPIFY');
    const parent = tm.getSession('session-1');
    assert.strictEqual(parent?.category, 'SHOPIFY');

    const split = tm.getSession('split-1');
    assert.strictEqual(split?.category, 'SHOPIFY', 'split pane must update category when parent changes');
  });
});

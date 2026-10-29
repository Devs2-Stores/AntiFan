import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TerminalManager } from '../../src/main/browser/terminal-manager';

describe('TerminalManager never reissues a terminal or split id', () => {
  const tm = TerminalManager.getInstance();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-monotonic-id-'));
  const testStateFile = path.join(tempDir, 'terminal-sessions.json');
  const counterFile = path.join(tempDir, 'terminal-id-counters.json');

  type TerminalManagerInternals = {
    spawn: (id: string, cwd: string, restoredBuffer?: string, initialCols?: number, initialRows?: number, minimumRows?: number) => unknown;
    statePath: () => string;
    sessions: Map<string, unknown>;
    activeSessionId?: string;
    currentCapsuleId?: string;
    lastCols?: number;
    lastRows?: number;
    idCountersLoadedFrom: string;
    persistTimer: NodeJS.Timeout | null;
    activePersistPromise: Promise<void> | null;
  };

  const tmInternal = tm as unknown as TerminalManagerInternals;
  const originalSpawn = tmInternal.spawn.bind(tm);
  const originalStatePath = tmInternal.statePath.bind(tm);

  /** A fresh process: no live rows, no pending flush, counters re-read from disk on the next mint. */
  const simulateRestart = async () => {
    clearTimeout(tmInternal.persistTimer ?? undefined);
    tmInternal.persistTimer = null;
    await tmInternal.activePersistPromise?.catch(() => {});
    tmInternal.sessions.clear();
    tmInternal.activeSessionId = '';
    tmInternal.idCountersLoadedFrom = '';
  };

  before(() => {
    tmInternal.statePath = () => testStateFile;
    tmInternal.spawn = function (id: string, cwd: string, restoredBuffer = '', initialCols?: number, initialRows?: number, minimumRows = 4) {
      const mockPty = {
        pid: 1000,
        cols: Math.max(40, initialCols || tmInternal.lastCols || 120),
        rows: Math.max(minimumRows, initialRows || tmInternal.lastRows || 30),
        onData: () => ({ dispose: () => {} }),
        onExit: () => ({ dispose: () => {} }),
        kill: () => {},
        write: () => {},
        resize: () => {},
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
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not hand a closed terminal id to the next terminal', async () => {
    await simulateRestart();
    assert.strictEqual(tm.createSession('E:/Work/a'), 'terminal-1');
    assert.strictEqual(tm.createSession('E:/Work/b'), 'terminal-2');
    assert.strictEqual(await tm.closeSession('terminal-2'), true);
    assert.strictEqual(tm.createSession('E:/Work/c'), 'terminal-3', 'terminal-2 must stay retired');
  });

  it('does not hand a closed split id to the next split', async () => {
    const first = tm.createSplitSession('terminal-1');
    const second = tm.createSplitSession('terminal-3');
    assert.strictEqual(first, 'split-1');
    assert.strictEqual(second, 'split-2');
    assert.strictEqual(await tm.closeSplitSession('split-2'), true);
    assert.strictEqual(tm.createSplitSession('terminal-3'), 'split-3', 'split-2 must stay retired');
  });

  it('writes the counters synchronously on mint so a hard kill keeps them', () => {
    const onDisk = JSON.parse(fs.readFileSync(counterFile, 'utf8')) as { terminal: number; split: number };
    assert.deepStrictEqual(onDisk, { terminal: 3, split: 3 });
  });

  it('keeps counting past the sidecar after a restart even though the sessions file is stale', async () => {
    // The sessions file lags by its debounce: it still shows an old, smaller id set.
    fs.writeFileSync(testStateFile, JSON.stringify({ sessions: [{ id: 'terminal-1', name: 'a', cwd: 'E:/Work/a', state: 'sleeping' }] }), 'utf8');
    await simulateRestart();
    assert.strictEqual(tm.createSession('E:/Work/d'), 'terminal-4');
    assert.strictEqual(tm.createSplitSession('terminal-4'), 'split-4');
  });

  it('seeds from the highest saved id when the sidecar is missing (legacy install)', async () => {
    fs.rmSync(counterFile, { force: true });
    fs.writeFileSync(
      testStateFile,
      JSON.stringify({
        sessions: [
          { id: 'terminal-2', name: 'a', cwd: 'E:/Work/a', state: 'sleeping' },
          { id: 'terminal-9', name: 'b', cwd: 'E:/Work/b', state: 'sleeping' },
          { id: 'split-5', name: 'c', cwd: 'E:/Work/b', splitOf: 'terminal-9', state: 'sleeping' },
        ],
      }),
      'utf8',
    );
    await simulateRestart();
    assert.strictEqual(tm.createSession('E:/Work/e'), 'terminal-10');
    assert.strictEqual(tm.createSplitSession('terminal-10'), 'split-6');
  });

  it('keeps a restored id retired when its row is closed before any new mint', async () => {
    fs.rmSync(counterFile, { force: true });
    fs.writeFileSync(testStateFile, JSON.stringify({ sessions: [{ id: 'terminal-7', name: 'a', cwd: 'E:/Work/a', state: 'sleeping' }] }), 'utf8');
    await simulateRestart();
    tm.startTerminal();
    assert.ok(tm.getSession('terminal-7'), 'terminal-7 must be restored');
    assert.strictEqual(await tm.closeSession('terminal-7'), true);
    fs.rmSync(testStateFile, { force: true });
    tmInternal.idCountersLoadedFrom = '';
    assert.strictEqual(tm.createSession('E:/Work/f'), 'terminal-8');
  });

  it('loads a legacy bare-array sessions file', async () => {
    fs.rmSync(counterFile, { force: true });
    fs.writeFileSync(testStateFile, JSON.stringify([{ id: 'terminal-4', name: 'a', cwd: 'E:/Work/a', state: 'sleeping' }]), 'utf8');
    await simulateRestart();
    assert.strictEqual(tm.createSession('E:/Work/g'), 'terminal-5');
  });
});

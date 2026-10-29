import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TerminalManager, idsFromRunFileNames } from '../../src/main/browser/terminal-manager';
import { leaderRunsDir } from '../../src/main/leader/leader-runtime';
import { StorageLocations } from '../../src/main/config/storage-locations';

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

describe('idsFromRunFileNames', () => {
  it('names terminals and splits from run and brief files only', () => {
    const ids = idsFromRunFileNames([
      'terminal-12.json',
      'terminal-12.brief.json',
      'split-3.json',
      'terminal-4.json.tmp-9120',
      'terminal-4.brief.json.tmp-9120',
      'terminal-7.json.tmp',
      'control',
      'notes.json',
      'terminal-x.json',
      'terminal-.json',
      'xterminal-5.json',
    ]);
    assert.deepStrictEqual(ids, ['terminal-12', 'terminal-12', 'split-3']);
  });
});

describe('TerminalManager id floor from the Leader registry and run files', () => {
  const tm = TerminalManager.getInstance();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-id-floor-'));
  const configDir = path.join(dataRoot, 'config');
  const runsDir = path.join(dataRoot, 'runtime', 'runs');
  const stateFile = path.join(configDir, 'terminal-sessions.json');
  const counterFile = path.join(configDir, 'terminal-id-counters.json');
  const registryFile = path.join(configDir, 'leader-terminals.json');

  type Internals = {
    spawn: (id: string, cwd: string, restoredBuffer?: string, initialCols?: number, initialRows?: number, minimumRows?: number) => unknown;
    statePath: () => string;
    sessions: Map<string, unknown>;
    activeSessionId?: string;
    currentCapsuleId?: string;
    idCountersLoadedFrom: string;
    isDisposed: boolean;
    persistTimer: NodeJS.Timeout | null;
    activePersistPromise: Promise<void> | null;
  };
  const internal = tm as unknown as Internals;
  const originalSpawn = internal.spawn.bind(tm);
  const originalStatePath = internal.statePath.bind(tm);
  const written: Array<{ id: string; data: string }> = [];

  const simulateRestart = async () => {
    clearTimeout(internal.persistTimer ?? undefined);
    internal.persistTimer = null;
    await internal.activePersistPromise?.catch(() => {});
    internal.sessions.clear();
    internal.activeSessionId = '';
    internal.idCountersLoadedFrom = '';
    written.length = 0;
  };

  before(() => {
    // The suite above disposed the shared singleton; a write needs a live manager again.
    internal.isDisposed = false;
    internal.statePath = () => stateFile;
    internal.spawn = function (id: string, cwd: string, restoredBuffer = '') {
      const session = {
        id,
        name: `Terminal ${id}`,
        cwd: cwd || 'E:/Work/project',
        pty: {
          pid: 1000,
          cols: 120,
          rows: 30,
          onData: () => ({ dispose: () => {} }),
          onExit: () => ({ dispose: () => {} }),
          kill: () => {},
          write: (data: string) => { written.push({ id, data }); },
          resize: () => {},
        },
        buffer: restoredBuffer,
        bufferBytes: Buffer.byteLength(restoredBuffer, 'utf8'),
        deliveryJournal: { clear: () => {} },
        capsuleId: internal.currentCapsuleId || 'default',
        state: 'running',
        disposed: false,
      };
      internal.sessions.set(id, session);
      return session;
    };
  });

  after(async () => {
    await tm.dispose();
    internal.spawn = originalSpawn;
    internal.statePath = originalStatePath;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it('mints above run files and registry ids when no sidecar or sessions file exists', async () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(path.join(runsDir, 'terminal-12.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(runsDir, 'terminal-3.brief.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(runsDir, 'terminal-40.json.tmp-77'), '{}', 'utf8');
    fs.writeFileSync(
      registryFile,
      JSON.stringify({ schema: 1, leaders: ['terminal-2'], workers: { 'terminal-15': { leaderId: 'terminal-2', assignedAt: 1 }, 'split-6': { leaderId: 'terminal-2', assignedAt: 1 } } }),
      'utf8',
    );
    await simulateRestart();
    assert.strictEqual(tm.createSession('E:/Work/a'), 'terminal-16');
    assert.strictEqual(tm.createSplitSession('terminal-16'), 'split-7');
    const onDisk = JSON.parse(fs.readFileSync(counterFile, 'utf8')) as { terminal: number; split: number };
    assert.deepStrictEqual(onDisk, { terminal: 16, split: 7 });
  });

  it('still mints when the runs directory and the registry do not exist', async () => {
    fs.rmSync(path.join(dataRoot, 'runtime'), { recursive: true, force: true });
    fs.rmSync(registryFile, { force: true });
    fs.rmSync(counterFile, { force: true });
    fs.rmSync(stateFile, { force: true });
    await simulateRestart();
    assert.strictEqual(tm.createSession('E:/Work/b'), 'terminal-1');
  });

  it('leaves no temp file behind after persisting the counters', () => {
    const leftovers = fs.readdirSync(configDir).filter(name => name.startsWith('terminal-id-counters.json.tmp'));
    assert.deepStrictEqual(leftovers, []);
  });

  it('reports whether a write reached a session', () => {
    assert.strictEqual(tm.writeTo('terminal-does-not-exist', 'x'), false);
    assert.strictEqual(tm.writeTo('terminal-1', 'echo hi\r'), true);
    assert.deepStrictEqual(written, [{ id: 'terminal-1', data: 'echo hi\r' }]);
  });

  it('reports the active-session write result', () => {
    internal.activeSessionId = '';
    assert.strictEqual(tm.write('x'), false);
    internal.activeSessionId = 'terminal-1';
    assert.strictEqual(tm.write('y'), true);
  });

  it('warns, cleans its temp file and still mints when the counters cannot be saved', async () => {
    // A directory where the sidecar belongs makes the final rename fail.
    fs.rmSync(counterFile, { force: true });
    fs.mkdirSync(counterFile);
    await simulateRestart();
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      assert.strictEqual(tm.createSession('E:/Work/c'), 'terminal-1');
    } finally {
      console.warn = originalWarn;
      fs.rmSync(counterFile, { recursive: true, force: true });
    }
    assert.ok(warnings.length >= 1, 'the failed save is reported');
    const leftovers = fs.readdirSync(configDir).filter(name => name.startsWith('terminal-id-counters.json.tmp'));
    assert.deepStrictEqual(leftovers, []);
  });
});

describe('TerminalManager id floor follows the data root, not the config dir', () => {
  const tm = TerminalManager.getInstance();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-id-floor-config-'));
  const dataRoot = path.join(base, 'data');
  // The config dir is overridden on its own and is NOT a sibling of `<dataRoot>/runtime`.
  const configElsewhere = path.join(base, 'config-alt');
  const previous = { data: process.env.ANTIFAN_DATA_ROOT, config: process.env.ANTIFAN_CONFIG_DIR };
  type Internals = { idCountersLoadedFrom: string; sessions: Map<string, unknown>; mintSessionId: (prefix: 'terminal' | 'split') => string };
  const internal = tm as unknown as Internals;

  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  before(() => {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.mkdirSync(configElsewhere, { recursive: true });
    process.env.ANTIFAN_DATA_ROOT = dataRoot;
    process.env.ANTIFAN_CONFIG_DIR = configElsewhere;
    StorageLocations.resetCache();
    internal.sessions.clear();
    internal.idCountersLoadedFrom = '';
  });

  after(() => {
    restore('ANTIFAN_DATA_ROOT', previous.data);
    restore('ANTIFAN_CONFIG_DIR', previous.config);
    StorageLocations.resetCache();
    internal.idCountersLoadedFrom = '';
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('reads the directory the run-state service writes when only the config dir is overridden', () => {
    const runs = leaderRunsDir();
    assert.strictEqual(runs, path.join(dataRoot, 'runtime', 'runs'));
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(path.join(runs, 'terminal-20.json'), '{}', 'utf8');
    // A decoy where a config-relative guess would look must not count.
    const decoy = path.join(base, 'runtime', 'runs');
    fs.mkdirSync(decoy, { recursive: true });
    fs.writeFileSync(path.join(decoy, 'terminal-90.json'), '{}', 'utf8');
    assert.strictEqual(internal.mintSessionId('terminal'), 'terminal-21');
    const onDisk = JSON.parse(fs.readFileSync(path.join(configElsewhere, 'terminal-id-counters.json'), 'utf8')) as { terminal: number };
    assert.strictEqual(onDisk.terminal, 21);
  });
});
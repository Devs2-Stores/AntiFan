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
import { CapabilityError } from '../../src/shared/control-plane-contracts';


const ROOT = path.resolve(__dirname, '../..');

describe('Terminal Split Hardened 10-Round Verification Suite', () => {
  const tm = TerminalManager.getInstance();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-split-10round-'));
  const testStateFile = path.join(tempDir, 'terminal-sessions.json');

  type TerminalManagerInternals = {
    spawn: (id: string, cwd: string, restoredBuffer?: string, initialCols?: number, initialRows?: number, minimumRows?: number) => unknown;
    statePath: () => string;
    sessions: Map<string, { id: string; cwd: string; name?: string; splitOf?: string; capsuleId?: string; disposed?: boolean; pty: { pid?: number; cols: number; rows: number; kill: () => void; write: (data: string) => void; resize: (c: number, r: number) => void } }>;
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
        // No fake pid: teardownSessionPty would feed it to a real `taskkill /T /F`
        // and a random number can name a live, unrelated Windows process.
        pid: undefined,
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
        bufferBytes: Buffer.byteLength(restoredBuffer || '', 'utf8'),
        deliveryJournal: { clear: () => {} },
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
 
  it('parks a parent\'s panes with it and wakes them through the split toggle path', async () => {
    const parent = tm.createSession();
    const split = tm.createSplitSession(parent);
    assert.ok(split);
    tm.getSession(parent)!.state = 'running';
    tm.getSession(split)!.state = 'running';
    // A pane is subordinate to the tab it splits: parking the parent parks its panes in
    // the same transition. A split left running under a sleeping parent keeps a shell
    // alive for a tab the user believes is parked, and its row leaks out of the parent's
    // group in the sidebar — the group a pane inherits comes from the awake parent.
    assert.deepStrictEqual(tm.sleepSession(parent), { ok: true });
    assert.strictEqual(tm.getSession(parent)?.state, 'sleeping');
    assert.strictEqual(tm.getSession(split)?.state, 'sleeping');
    assert.strictEqual(tm.getSession(split)?.pty, null, 'the parked pane releases its shell');

    assert.strictEqual(tm.createSplitSession(parent), split,
      'waking a hidden split must reuse its existing session');
    assert.strictEqual(tm.getSession(parent)?.state, 'running');
    assert.strictEqual(tm.getSession(split)?.state, 'running');

    // The mirror rule: waking a pane wakes the tab that owns it, so a keystroke in the
    // lower pane can never leave a live shell under a parked parent.
    assert.deepStrictEqual(tm.sleepSession(parent), { ok: true });
    assert.strictEqual(tm.wakeSession(split), true);
    assert.strictEqual(tm.getSession(parent)?.state, 'running');
    assert.strictEqual(tm.getSession(split)?.state, 'running');

    // A pane can still be parked on its own; the tab it splits keeps running, and the
    // toggle is still the pane's wake path.
    assert.deepStrictEqual(tm.sleepSession(split), { ok: true });
    assert.strictEqual(tm.getSession(parent)?.state, 'running');
    assert.strictEqual(tm.getSession(split)?.state, 'sleeping');
    assert.strictEqual(tm.createSplitSession(parent), split);
    assert.strictEqual(tm.getSession(split)?.state, 'running');

    await tm.closeSession(parent);
  });

  it('waking a parked parent wakes its parked panes in the same transition', async () => {
    const parent = tm.createSession();
    const split = tm.createSplitSession(parent);
    assert.ok(split);
    tm.getSession(parent)!.state = 'running';
    tm.getSession(split)!.state = 'running';
    assert.deepStrictEqual(tm.sleepSession(parent), { ok: true });
    assert.strictEqual(tm.getSession(split)?.state, 'sleeping');
    // The reported regression: clicking the parked tab wakes only it, leaving the
    // split mounted but shell-less. The wake must mirror the sleep cascade.
    assert.strictEqual(tm.wakeSession(parent), true);
    assert.strictEqual(tm.getSession(parent)?.state, 'running');
    assert.strictEqual(tm.getSession(split)?.state, 'running');
    assert.ok(tm.getSession(split)?.pty, 'the woken pane owns a live shell');

    await tm.closeSplitSession(split);
    await tm.closeSession(parent);
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

    // Every split is projected as its own pane, so the strip sees 5 parents and their
    // 5 splits; each split dies with the parent that owns it.
    assert.strictEqual(tm.listSessions().length, 10);
    assert.strictEqual(tm.listSessions().filter((s) => s.splitOf).length, 5);

    for (const p of created) {
      await tm.closeSession(p);
    }

    assert.strictEqual(tm.listSessions().length, 0);
  });

  // Split projection: a split pane is an independent terminal, so every split is
  // projected as its own session entry (own id, transcript, state, alt-screen flag)
  // while the base entry keeps naming the first split; `altScreen` reaches diagnostics.
  it('projects every split as its own session entry with its own transcript and state', async () => {
    const parent = tm.createSession();
    const splitA = tm.createSplitSession(parent);
    assert.ok(splitA);
    tm.getSession(parent)!.buffer = 'PARENT_OUTPUT\r\n';
    tm.getSession(splitA)!.buffer = 'SPLIT_A_OUTPUT\r\n';
    tm.getSession(splitA)!.altScreen = true;

    // A parent with two splits only exists after a restart restore, so the second one
    // is injected the way the restore path builds it.
    const splitB = 'split-restored-1';
    tmInternal.sessions.set(splitB, {
      id: splitB,
      cwd: 'E:/Work/split-b',
      name: 'Terminal (Split)',
      splitOf: parent,
      capsuleId: 'default',
      disposed: false,
      pty: { cols: 120, rows: 30, kill: () => {}, write: () => {}, resize: () => {} },
    });
    const restoredSplit = tm.getSession(splitB)!;
    restoredSplit.buffer = 'SPLIT_B_OUTPUT\r\n';
    restoredSplit.state = 'running';

    const list = tm.listSessions();
    const baseEntry = list.find((s) => s.id === parent);
    const entryA = list.find((s) => s.id === splitA);
    const entryB = list.find((s) => s.id === splitB);

    assert.strictEqual(baseEntry?.splitSessionId, splitA);
    assert.match(baseEntry?.splitBuffer || '', /SPLIT_A_OUTPUT/);
    assert.ok(entryA && entryB, 'both splits of the parent must be listed');
    assert.strictEqual(entryA!.splitOf, parent);
    assert.strictEqual(entryB!.splitOf, parent);
    assert.strictEqual(entryA!.active, false);
    assert.match(entryA!.buffer, /SPLIT_A_OUTPUT/);
    assert.match(entryB!.buffer, /SPLIT_B_OUTPUT/);
    assert.strictEqual(entryA!.altScreen, true);
    assert.strictEqual(
      tm.getDiagnostics().sessions.find((s) => s.sessionId === splitA)?.altScreen,
      true
    );

    await tm.closeSession(parent);
    assert.strictEqual(tm.listSessions().find((s) => s.id === splitB), undefined);
  });
});

describe('PTY mint vs dispose — no orphan shells', () => {
  /**
   * Rows share ONE manager deliberately: row 1 disposes it mid-flight, rows 2
   * and 3 assert the disposed state stays authoritative over everything that
   * can still mint a shell. Only node-pty is stubbed (the same seam
   * terminal-stream-invariants uses); materialization, dispose and the kill
   * path are the shipped code.
   */
  class DeferredFakePty {
    public cols: number;
    public rows: number;
    public readonly pid = 0;
    public killed = false;

    constructor(public readonly shell: string, options: Record<string, unknown>) {
      this.cols = Number(options.cols) || 120;
      this.rows = Number(options.rows) || 30;
    }

    onData(_cb: (data: string) => void): { dispose: () => void } {
      return { dispose: () => {} };
    }

    onExit(_cb: (event: { exitCode: number; signal?: number }) => void): { dispose: () => void } {
      return { dispose: () => {} };
    }

    kill(): void {
      this.killed = true;
    }

    write(_input: string): void {}

    resize(cols: number, rows: number): void {
      this.cols = cols;
      this.rows = rows;
    }
  }

  type DeferredManagerInternals = {
    sessions: Map<string, {
      id: string;
      pty: { kill: () => void } | null;
      state: string;
      disposed?: boolean;
      cwd?: string;
      name?: string;
      splitOf?: string;
      capsuleId?: string;
      restoredPendingPty?: boolean;
    }>;
    sessionGenerations: Map<string, number>;
    activePersistPromise: Promise<void> | null;
    ensureSessionPty: (id: string) => unknown;
    createSessionRecord: (
      id: string,
      cwd: string,
      restoredBuffer: string,
      initialCols: number | undefined,
      initialRows: number | undefined,
      minimumRows: number,
      parentSessionId: string | undefined,
      generation: number,
      parentGeneration?: number,
    ) => { restoredPendingPty?: boolean };
    spawn: (...args: unknown[]) => unknown;
    statePath: () => string;
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-deferred-dispose-'));
  const testStateFile = path.join(tempDir, 'terminal-sessions.json');
  const deferredSpawnedPtys: DeferredFakePty[] = [];
  const ptyModule = require('node-pty') as unknown as {
    spawn: (shell: string, args: string[], options: Record<string, unknown>) => DeferredFakePty;
  };
  const realPtySpawn = ptyModule.spawn;
  let tm!: TerminalManager;
  let internals!: DeferredManagerInternals;

  before(() => {
    ptyModule.spawn = (shell: string, _args: string[], options: Record<string, unknown>) => {
      const p = new DeferredFakePty(shell, options);
      deferredSpawnedPtys.push(p);
      return p;
    };
    if (ptyModule.spawn === realPtySpawn) {
      throw new Error('node-pty spawn stub was not installed; the lane would exercise the real PTY');
    }
    // The prior suite disposed the singleton, so getInstance() yields a fresh,
    // undisposed canonical — constructionCount was reset by that teardown.
    tm = TerminalManager.getInstance();
    internals = tm as unknown as DeferredManagerInternals;
    internals.statePath = () => testStateFile;
  });

  after(async () => {
    await tm.dispose();
    ptyModule.spawn = realPtySpawn;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not mint a PTY when a materialization request races dispose', async () => {
    // Hold the persist drain open so a touch can arrive while dispose() is
    // still suspended inside its own first await — the window where an
    // in-flight restore used to mint a shell that survived the kill pass.
    const drainGate = Promise.withResolvers<void>();
    internals.activePersistPromise = drainGate.promise;
    const record = internals.createSessionRecord('terminal-deferred-1', 'E:/Work', '', 120, 30, 8, undefined, 1);
    record.restoredPendingPty = true;
    const disposal = tm.dispose();

    internals.ensureSessionPty.call(tm, 'terminal-deferred-1');
    drainGate.resolve();
    await disposal;

    assert.equal(deferredSpawnedPtys.length, 0, 'dispose must stay authoritative over a mid-flight materialization');
    const session = tm.getSession('terminal-deferred-1');
    assert.equal(session?.pty ?? null, null, 'a post-dispose record may exist but must never own a shell');
  });

  it('refuses a late materialization reaching ensureSessionPty after disposal completed', () => {
    // The same refusal the pump needs, driven through the keystroke path:
    // writeTo → resolveWritableSession → ensureSessionPty on a record that
    // survived teardown without a shell.
    internals.createSessionRecord('terminal-late-1', 'E:/Work', '', 120, 30, 8, undefined, 1);
    tm.writeTo('terminal-late-1', 'echo hi\r');

    assert.equal(deferredSpawnedPtys.length, 0, 'no keystroke may mint a shell on a disposed manager');
    const session = tm.getSession('terminal-late-1');
    assert.equal(session?.pty ?? null, null, 'the late record stays shell-less');
  });

  it('keeps every mint entry point closed after dispose: capsule switch, createSession, and the spawn seam', () => {
    assert.throws(
      () => tm.setCapsule('capsule-post-dispose', 'E:/Work'),
      CapabilityError,
      'a capsule switch on a dead manager must fail closed, not resurrect it',
    );
    assert.throws(
      () => tm.createSession('E:/Work'),
      CapabilityError,
      'createSession on a dead manager must fail closed, not resurrect it',
    );
    assert.throws(
      () => internals.spawn.call(tm, 'terminal-orphan-1', 'E:/Work'),
      CapabilityError,
      'the PTY mint itself refuses on a disposed manager',
    );
    assert.equal(deferredSpawnedPtys.length, 0, 'nothing may reach node-pty after disposal');
  });
});

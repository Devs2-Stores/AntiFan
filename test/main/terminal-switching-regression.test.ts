import { describe, it, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TerminalManager } from '../../src/main/browser/terminal-manager';

const ROOT = path.resolve(__dirname, '../../..');

describe('Terminal Switching Regression & Viewport Integrity', () => {
  const tm = TerminalManager.getInstance();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-term-test-'));
  const testStateFile = path.join(tempDir, 'terminal-sessions.json');

  type TerminalManagerInternals = {
    spawn: (id: string, cwd: string, restoredBuffer?: string) => unknown;
    statePath: () => string;
    sessions: Map<string, unknown>;
    activeSessionId?: string;
    currentCapsuleId?: string;
    persistAsync: () => Promise<void>;
    readSavedSessions: () => { activeSessionId?: string; sessions?: Array<{ id: string; buffer?: string; name?: string }> };
  };

  const tmInternal = tm as unknown as TerminalManagerInternals;
  const originalSpawn = tmInternal.spawn.bind(tm);
  const originalStatePath = tmInternal.statePath.bind(tm);

  tmInternal.statePath = () => testStateFile;
  tmInternal.spawn = function (id: string, cwd: string, restoredBuffer = '') {
    const mockPty = {
      pid: undefined,
      cols: undefined as number | undefined,
      rows: undefined as number | undefined,
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      kill: () => {},
      write: () => {},
      resize: (cols: number, rows: number) => {
        mockPty.cols = cols;
        mockPty.rows = rows;
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

  after(async () => {
    await tm.dispose();
    tmInternal.spawn = originalSpawn;
    tmInternal.statePath = originalStatePath;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });
  it('preserves multi-session buffers and states across switching with long scrollback and background streams', async () => {
    const s1Id = tm.createSession();
    const s2Id = tm.createSession();
    const s3Id = tm.createSession();
    assert.ok(s1Id);
    assert.ok(s2Id);
    assert.ok(s3Id);

    // 2. Populate Session 1 with long scrollback buffer (simulate large output)
    const longOutput = Array.from({ length: 200 }, (_, i) => `[Session 1 - Line ${i + 1}] Output payload for scrollback test\r\n`).join('');
    const s1 = tm.getSession(s1Id);
    assert.ok(s1);
    s1.buffer = longOutput;

    // 3. Populate Session 2 with background streaming output
    const s2 = tm.getSession(s2Id);
    assert.ok(s2);
    s2.buffer = '⚡ [Session 2] Background AI stream chunk 1\r\n⚡ [Session 2] Background AI stream chunk 2\r\n';

    // 4. Switch to Session 1
    assert.strictEqual(tm.switchSession(s1Id), true);
    assert.strictEqual(tm.getActiveSessionId(), s1Id);
    const sessionsAfterS1 = tm.listSessions();
    const listedS1 = sessionsAfterS1.find((s) => s.id === s1Id);
    const listedS2 = sessionsAfterS2(sessionsAfterS1, s2Id);
    assert.strictEqual(listedS1?.active, true);
    assert.strictEqual(listedS2?.active, false);
    assert.ok(listedS1?.buffer.includes('Line 200'));

    // 5. Append background streaming output to Session 2 while Session 1 is active
    s2.buffer += '⚡ [Session 2] Background AI stream chunk 3 while S1 is active\r\n';

    // 6. Switch to Session 2
    assert.strictEqual(tm.switchSession(s2Id), true);
    assert.strictEqual(tm.getActiveSessionId(), s2Id);
    const sessionsAfterS2List = tm.listSessions();
    const activeS2 = sessionsAfterS2List.find((s) => s.id === s2Id);
    assert.strictEqual(activeS2?.active, true);
    assert.ok(activeS2?.buffer.includes('chunk 3'));

    // 7. Switch to Session 3 (newly created)
    assert.strictEqual(tm.switchSession(s3Id), true);
    assert.strictEqual(tm.getActiveSessionId(), s3Id);

    // 8. Switch back to Session 1 and verify long scrollback is intact without truncation or race
    assert.strictEqual(tm.switchSession(s1Id), true);
    const s1Restored = tm.listSessions().find((s) => s.id === s1Id);
    assert.ok(s1Restored?.buffer.includes('Line 1'));
    assert.ok(s1Restored?.buffer.includes('Line 200'));

    // Cleanup created test sessions
    await tm.closeSession(s1Id);
    await tm.closeSession(s2Id);
    await tm.closeSession(s3Id);
  });

  it('validates standalone.css and standalone.js contracts for zero-flash visibility and scroll preservation', () => {
    const cssPath = path.join(ROOT, 'src/renderer/standalone.css');
    const jsPath = path.join(ROOT, 'src/renderer/standalone.js');
    const cssContent = fs.readFileSync(cssPath, 'utf8');
    const jsContent = fs.readFileSync(jsPath, 'utf8');

    // 1. Ensure .terminal-session-pane uses visibility: hidden + box-sizing: border-box without contain: strict (NOT display: none)
    assert.match(cssContent, /\.terminal-session-pane\s*\{[^}]*visibility:\s*hidden/);
    assert.match(cssContent, /\.terminal-session-pane\s*\{[^}]*box-sizing:\s*border-box/);
    assert.doesNotMatch(cssContent, /\.terminal-session-pane\s*\{[^}]*contain:\s*strict/);
    assert.match(cssContent, /\.terminal-session-pane\.active\s*\{[^}]*visibility:\s*visible/);
    assert.doesNotMatch(cssContent, /\.terminal-session-pane\s*\{[^}]*display:\s*none/);
    // 2. Ensure .xterm-screen does NOT have width: 100% !important (which destroys xterm canvas pixel alignment)
    assert.doesNotMatch(cssContent, /\.terminal-session-pane\s+\.xterm-screen\s*\{[^}]*width:\s*100%\s*!important/);

    // 3. Ensure standalone.js has explicit snapshot hydration state and pendingChunks queue
    assert.match(jsContent, /isHydrated/);
    assert.match(jsContent, /pendingChunks/);
    // 4. Ensure standalone.js preserves per-tab scroll positions using xterm v6 buffer viewportY API
    assert.match(jsContent, /savedViewportY/);
    assert.match(jsContent, /scrollToLine/);
    // 5. Ensure tab scrolling does not use window-level scrollIntoView
    assert.doesNotMatch(jsContent, /scrollIntoView\(\s*\{\s*behavior:\s*'smooth'/);
    // 6. Ensure split terminal attaches onData input forwarder and cleans up resources on unmount
    assert.match(jsContent, /splitTerm\.onData\(/);
    assert.match(jsContent, /api\?\.sendTerminalInputTo\(splitId,\s*data\)/);
    assert.match(jsContent, /splitTerm\?\.dispose\(\)/);
    // 7. Ensure convertEol is false so ConPTY redraws don't create phantom empty lines on cls
    assert.doesNotMatch(jsContent, /convertEol:\s*true/);
    assert.match(jsContent, /convertEol:\s*false/);
    // 8. Ensure applySplitRatio enforces minPx bound to prevent mainPane collapse
    assert.match(jsContent, /minPx\s*=\s*90/);
    assert.match(jsContent, /minHeight\s*=\s*`\$\{minPx\}px`/);
  });
  it('verifies split terminal lifecycle: resizeTo custom ratios, session events, close persistence, switch normalization, and recreate', async () => {
    const p1 = tm.createSession();
    assert.ok(p1);

    const sessionEvents: Array<Array<{ id: string; splitSessionId?: string; active: boolean }>> = [];
    const onSession = (payload: any) => {
      const sessions = Array.isArray(payload) ? payload : (payload?.sessions || []);
      sessionEvents.push(sessions);
    };
    tm.on('session', onSession);

    try {
      // 1. Create split session
      const split1 = tm.createSplitSession(p1);
      assert.ok(split1);
      assert.match(split1, /^split-/);

      // Verify event was emitted for split creation
      const lastEventAfterCreate = sessionEvents[sessionEvents.length - 1];
      const parentInEvent = lastEventAfterCreate?.find((s) => s.id === p1);
      assert.strictEqual(parentInEvent?.splitSessionId, split1);

      // 2. Verify listSessions reflects split relation
      let list = tm.listSessions();
      let parentEntry = list.find((s) => s.id === p1);
      assert.strictEqual(parentEntry?.splitSessionId, split1);

      // 3. Test resize applies to all sessions
      tm.resize(100, 30);
      const parentSession = tm.getSession(p1);
      const splitSession = tm.getSession(split1);
      assert.ok(parentSession);
      assert.ok(splitSession);
      assert.strictEqual((parentSession as any).pty.cols, 100);
      assert.strictEqual((parentSession as any).pty.rows, 30);
      assert.strictEqual((splitSession as any).pty.cols, 100);
      assert.strictEqual((splitSession as any).pty.rows, 30);

      // 4. Test resizeTo with custom 70/30 split ratio
      tm.resizeTo(p1, 120, 35);
      tm.resizeTo(split1, 120, 15);
      assert.strictEqual((parentSession as any).pty.cols, 120);
      assert.strictEqual((parentSession as any).pty.rows, 35);
      assert.strictEqual((splitSession as any).pty.cols, 120);
      assert.strictEqual((splitSession as any).pty.rows, 15);

      // 5. Test switchSession with split ID normalizes to parent ID
      assert.strictEqual(tm.switchSession(split1), true);
      assert.strictEqual(tm.getActiveSessionId(), p1);
      list = tm.listSessions();
      parentEntry = list.find((s) => s.id === p1);
      assert.strictEqual(parentEntry?.active, true);

      // 6. Test closeSplitSession removes split and persists deletion
      const closed = await tm.closeSplitSession(p1);
      assert.strictEqual(closed, true);
      list = tm.listSessions();
      parentEntry = list.find((s) => s.id === p1);
      assert.strictEqual(parentEntry?.splitSessionId, undefined);

      // Verify event was emitted for split close
      const lastEventAfterClose = sessionEvents[sessionEvents.length - 1];
      const parentInCloseEvent = lastEventAfterClose?.find((s) => s.id === p1);
      assert.strictEqual(parentInCloseEvent?.splitSessionId, undefined);

      // Flush debounced persist timer deterministically to disk and verify file snapshot
      tm.persistSync();
      const saved = (tm as any).readSavedSessions();
      const savedSplit = saved.sessions?.find((s: any) => s.id === split1 || s.splitOf === p1);
      assert.strictEqual(savedSplit, undefined);

      // 7. Test recreating split session on same parent works cleanly
      const split2 = tm.createSplitSession(p1);
      assert.ok(split2);
      list = tm.listSessions();
      parentEntry = list.find((s) => s.id === p1);
      assert.strictEqual(parentEntry?.splitSessionId, split2);

      // Verify event was emitted for recreate
      const lastEventAfterRecreate = sessionEvents[sessionEvents.length - 1];
      const parentInRecreateEvent = lastEventAfterRecreate?.find((s) => s.id === p1);
      assert.strictEqual(parentInRecreateEvent?.splitSessionId, split2);
    } finally {
      tm.off('session', onSession);
      // Cleanup
      await tm.closeSession(p1);
    }
  });

  it('preserves tab state when dispose() is called immediately within debounce interval before shutdown', async () => {
    const sId = tm.createSession();
    assert.ok(sId);
    const s = tm.getSession(sId);
    assert.ok(s);
    s.buffer = 'unique-quit-test-marker-54321\r\n';
    (tm as any).schedulePersist();
    assert.ok((tm as any).persistTimer !== null, 'persistTimer should be scheduled');

    // Immediately dispose without waiting for the 2000ms timer
    await tm.dispose();

    // Verify on-disk state contains the tab and its buffer
    const saved = (tm as any).readSavedSessions();
    const savedSession = saved.sessions?.find((item: any) => item.id === sId);
    assert.ok(savedSession, 'Session should be saved on disk even when disposed during debounce');
    assert.ok(savedSession.buffer?.includes('unique-quit-test-marker-54321'));
  });

  it('race-resilient: ensures in-flight persistAsync does not overwrite fresh persistSync on exit when paused between write and rename', async () => {
    const sId = tm.createSession();
    assert.ok(sId);
    const s = tm.getSession(sId);
    assert.ok(s);
    s.buffer = 'stale-async-buffer-at-T0\r\n';

    let resumeRename: () => void = () => {};
    let onRenameEnter: () => void = () => {};
    const renameGate = new Promise<void>((resolve) => { resumeRename = resolve; });
    const renameEntered = new Promise<void>((resolve) => { onRenameEnter = resolve; });
    const origRename = fs.promises.rename;
    (fs.promises as unknown as { rename: typeof fs.promises.rename }).rename = async function (oldPath: fs.PathLike, newPath: fs.PathLike) {
      if (String(oldPath).includes('.tmp-async-')) {
        onRenameEnter();
        await renameGate;
      }
      return origRename.call(fs.promises, oldPath, newPath);
    };

    try {
      // 1. Kick off async persist (T0)
      const asyncJob = tmInternal.persistAsync();

      // Wait with bounded timeout for async persist to reach rename step
      let timer1: NodeJS.Timeout;
      await Promise.race([
        renameEntered,
        new Promise<void>((_, rej) => { timer1 = setTimeout(() => rej(new Error('Timeout waiting for renameEntry in persistAsync')), 2000); timer1.unref?.(); }),
      ]).finally(() => clearTimeout(timer1));
      // 2. Fresh state arrives at T1 (e.g. user types new command or creates tab right before quit)
      s.buffer = 'fresh-sync-buffer-at-T1-FINAL\r\n';
      tm.persistSync();

      // Verify sync wrote T1 to disk
      let diskState = tmInternal.readSavedSessions();
      let savedSession = diskState.sessions?.find((item) => item.id === sId);
      assert.ok(savedSession?.buffer?.includes('fresh-sync-buffer-at-T1-FINAL'));

      // 3. Now let the paused async persist (T0) complete
      resumeRename?.();
      await asyncJob;

      // 4. Verify disk STILL has T1 and was NOT overwritten by T0
      diskState = tmInternal.readSavedSessions();
      savedSession = diskState.sessions?.find((item) => item.id === sId);
      assert.ok(
        savedSession?.buffer?.includes('fresh-sync-buffer-at-T1-FINAL'),
        'Disk should retain fresh T1 sync buffer, not stale T0 async buffer'
      );
      assert.ok(
        !savedSession?.buffer?.includes('stale-async-buffer-at-T0'),
        'Stale T0 buffer should not overwrite fresh T1 file'
      );
    } finally {
      (fs.promises as unknown as { rename: typeof fs.promises.rename }).rename = origRename;
      await tm.closeSession(sId);
    }
  });
  it('race-resilient: ensures failed rename fallback in persistAsync does not overwrite fresh persistSync', async () => {
    const sId = tm.createSession();
    assert.ok(sId);
    const s = tm.getSession(sId);
    assert.ok(s);
    s.buffer = 'stale-async-buffer-at-T0\r\n';

    let resumeRename: () => void = () => {};
    let onRenameEnter: () => void = () => {};
    let renameEnteredFlag = false;
    const renameGate = new Promise<void>((resolve) => { resumeRename = resolve; });
    const renameEntered = new Promise<void>((resolve) => { onRenameEnter = resolve; });
    const origRename = fs.promises.rename;
    (fs.promises as unknown as { rename: typeof fs.promises.rename }).rename = async function (oldPath: fs.PathLike, newPath: fs.PathLike) {
      if (String(oldPath).includes('.tmp-async-')) {
        renameEnteredFlag = true;
        onRenameEnter();
        await renameGate;
        // Force rename failure to trigger fallback branch
        const err = new Error('EPERM: operation not permitted, rename');
        (err as unknown as { code: string }).code = 'EPERM';
        throw err;
      }
      return origRename.call(fs.promises, oldPath, newPath);
    };

    try {
      // 1. Kick off async persist (T0)
      const asyncJob = tmInternal.persistAsync();

      // Wait with bounded timeout for async persist to reach rename step
      let timer2: NodeJS.Timeout;
      await Promise.race([
        renameEntered,
        new Promise<void>((_, rej) => { timer2 = setTimeout(() => rej(new Error('Timeout waiting for renameEntry in fallback test')), 2000); timer2.unref?.(); }),
      ]).finally(() => clearTimeout(timer2));
      // 2. Fresh state arrives at T1
      s.buffer = 'fresh-sync-buffer-at-T1-FINAL\r\n';
      tm.persistSync();

      // Verify sync wrote T1 to disk
      let diskState = tmInternal.readSavedSessions();
      let savedSession = diskState.sessions?.find((item) => item.id === sId);
      assert.ok(savedSession?.buffer?.includes('fresh-sync-buffer-at-T1-FINAL'));

      // 3. Now let the paused async persist (T0) fail rename and attempt fallback
      resumeRename?.();
      await asyncJob;
      assert.strictEqual(renameEnteredFlag, true, 'Mocked rename must have been entered during in-flight async job');

      // 4. Verify disk STILL has T1 and was NOT overwritten by T0 fallback
      diskState = tmInternal.readSavedSessions();
      savedSession = diskState.sessions?.find((item) => item.id === sId);
      assert.ok(
        savedSession?.buffer?.includes('fresh-sync-buffer-at-T1-FINAL'),
        'Disk should retain fresh T1 sync buffer even if T0 async rename failed'
      );
      assert.ok(
        !savedSession?.buffer?.includes('stale-async-buffer-at-T0'),
        'Stale T0 buffer should not overwrite fresh T1 file via fallback write'
      );
    } finally {
      (fs.promises as unknown as { rename: typeof fs.promises.rename }).rename = origRename;
      await tm.closeSession(sId);
    }
  });
  it('persists multiple sessions and restores all tabs intact after restart', async () => {
    // 0. Ensure completely empty manager state before test
    tmInternal.sessions.clear();
    (tm as unknown as { activeSessionId: string }).activeSessionId = '';
    assert.strictEqual(tm.listSessions().length, 0);

    // 1. Setup initial sessions
    const s1 = tm.createSession();
    const s2 = tm.createSession();
    const s3 = tm.createSession();
    assert.ok(s1 && s2 && s3);

    tm.getSession(s1)!.name = 'Backend Dev';
    tm.getSession(s2)!.name = 'Frontend Vite';
    tm.getSession(s3)!.name = 'AI Runner';
    tm.switchSession(s2);

    // 2. Persist to isolated state file (simulating app shutdown persist)
    tm.persistSync();

    // 3. Clear all in-memory sessions (simulating fresh app process launch)
    tmInternal.sessions.clear();
    tmInternal.activeSessionId = '';

    // 4. Simulate app boot / renderer init calling startTerminal()
    const started = tm.startTerminal('E:/Work/project');
    assert.strictEqual(started, true);

    // 5. Verify all tabs are restored in-memory with names, order, and active tab
    const restoredSessions = tm.listSessions();
    assert.strictEqual(restoredSessions.length, 3);
    assert.strictEqual(tm.getActiveSessionId(), s2);
    assert.ok(restoredSessions.some((s) => s.id === s1 && s.name === 'Backend Dev'));
    assert.ok(restoredSessions.some((s) => s.id === s2 && s.name === 'Frontend Vite' && s.active));
    assert.ok(restoredSessions.some((s) => s.id === s3 && s.name === 'AI Runner'));

    // 6. Clean up
    await tm.closeSession(s1);
    await tm.closeSession(s2);
    await tm.closeSession(s3);
  });

  it('handles Windows rename failure gracefully with fallback in-place write across repeated overwrites', async () => {
    // 0. Clean state
    tmInternal.sessions.clear();
    tmInternal.activeSessionId = '';
    const s1 = tm.createSession();
    assert.ok(s1);
    tm.getSession(s1)!.name = 'Rename Fallback Test';
    // Simulate Windows rename failure (e.g. EPERM / locked file)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rawFs = require('node:fs') as { renameSync: typeof fs.renameSync };
    const origRenameSync = rawFs.renameSync;
    rawFs.renameSync = function () {
      const err = new Error('EPERM: operation not permitted, rename');
      (err as unknown as { code: string }).code = 'EPERM';
      throw err;
    };

    try {
      // Should not throw, should fall back to direct file write
      tm.persistSync();

      const saved = tmInternal.readSavedSessions();
      assert.ok(saved.sessions?.some((s) => s.id === s1 && s.name === 'Rename Fallback Test'));
    } finally {
      rawFs.renameSync = origRenameSync;
      await tm.closeSession(s1);
    }
  });
  it('setCapsule targets the specified session when targetSessionId is passed and leaves other tabs intact', async () => {
    // 0. Clean state
    tmInternal.sessions.clear();
    tmInternal.activeSessionId = '';

    const s1 = tm.createSession('E:/Work/project-1');
    const s2 = tm.createSession('E:/Work/project-2');
    assert.ok(s1 && s2);

    // Set active in manager initially to s1
    tm.switchSession(s1);
    assert.strictEqual(tm.getActiveSessionId(), s1);

    // User in Terminal 2 opens workspace 'E:/Work/project-target'
    tm.setCapsule('capsule-target', 'E:/Work/project-target', s2);

    // Verify Terminal 2 was targeted and activated, while s1 was untouched
    assert.strictEqual(tm.getActiveSessionId(), s2);
    assert.strictEqual(tm.getSession(s2)?.cwd, 'E:/Work/project-target');
    assert.strictEqual(tm.getSession(s1)?.cwd, 'E:/Work/project-1');

    await tm.closeSession(s1);
    await tm.closeSession(s2);
  });

  it('prevents post-dispose persistSync from wiping on-disk sessions when app quits or tabHost disposes', async () => {
    // 1. Setup multi-tab session state
    tmInternal.sessions.clear();
    tmInternal.activeSessionId = '';

    const t1 = tm.createSession('E:/Work/project-a');
    const t2 = tm.createSession('E:/Work/project-b');
    const t3 = tm.createSession('E:/Work/project-c');
    const t4 = tm.createSession('E:/Work/project-d');
    tm.renameSession(t1, 'Terminal 1');
    tm.renameSession(t2, 'Terminal 2');
    tm.renameSession(t3, 'Terminal 3');
    tm.renameSession(t4, 'Terminal 4');
    tm.switchSession(t1);

    // 2. Shutdown phase 1: dispose called
    await tm.dispose();

    // Verify on-disk file immediately after dispose
    const savedAfterDispose = tmInternal.readSavedSessions();
    assert.strictEqual(savedAfterDispose.sessions?.length, 4, 'Should have written 4 sessions before clearing in-memory map');

    // 3. Shutdown phase 2: Electron will-quit fires and triggers extraneous persistSync()
    // Prior bug: persistSync() serialized empty in-memory map and wiped on-disk file to []
    tm.persistSync();

    const savedAfterPostDispose = tmInternal.readSavedSessions();
    assert.strictEqual(savedAfterPostDispose.sessions?.length, 4, 'Post-dispose persistSync MUST NOT overwrite on-disk file with empty array');
    assert.ok(savedAfterPostDispose.sessions?.some((s) => s.id === t1 && s.name === 'Terminal 1'));
    assert.ok(savedAfterPostDispose.sessions?.some((s) => s.id === t2 && s.name === 'Terminal 2'));
    assert.ok(savedAfterPostDispose.sessions?.some((s) => s.id === t3 && s.name === 'Terminal 3'));
    assert.ok(savedAfterPostDispose.sessions?.some((s) => s.id === t4 && s.name === 'Terminal 4'));

    // 4. App Reopen phase: new startup invokes setCapsule() or startTerminal()
    tm.setCapsule('capsule-reopen', 'E:/Work/project-a');
    const restoredSessions = tm.listSessions();
    assert.strictEqual(restoredSessions.length, 4, 'All 4 terminal tabs must be completely restored upon app reopen');
    assert.strictEqual(restoredSessions[0]?.name, 'Terminal 1');
    assert.strictEqual(restoredSessions[1]?.name, 'Terminal 2');
    assert.strictEqual(restoredSessions[2]?.name, 'Terminal 3');
    assert.strictEqual(restoredSessions[3]?.name, 'Terminal 4');

    // Cleanup
    await tm.closeSession(t1);
    await tm.closeSession(t2);
    await tm.closeSession(t3);
    await tm.closeSession(t4);
  });

  it('supports getCurrentCwd, getSession, and findSessionForWorkspace queries', async () => {
    tmInternal.sessions.clear();
    tmInternal.activeSessionId = '';

    const wsPath = 'E:/Work/apps/antifan-browser-desktop';
    tm.setCwd(wsPath);
    assert.strictEqual(tm.getCurrentCwd(), wsPath);

    const s1 = tm.createSession(wsPath);
    const sessionObj = tm.getSession(s1);
    assert.ok(sessionObj, 'Session object must be returned by getSession');
    assert.strictEqual(sessionObj?.cwd, wsPath);

    const foundId = tm.findSessionForWorkspace(wsPath);
    assert.strictEqual(foundId, s1, 'findSessionForWorkspace must match session with matching cwd');

    await tm.closeSession(s1);
  });

  it('does not re-emit session event when switching to already active session', async () => {
    tmInternal.sessions.clear();
    tmInternal.activeSessionId = '';

    const s1 = tm.createSession();
    const s2 = tm.createSession();
    assert.strictEqual(tm.getActiveSessionId(), s2);

    let emitCount = 0;
    const listener = () => { emitCount++; };
    tm.on('session', listener);

    try {
      // Switching to s2 (already active) must return true without emitting
      const res1 = tm.switchSession(s2);
      assert.strictEqual(res1, true);
      assert.strictEqual(emitCount, 0, 'No session event should be emitted when target is already active');

      // Switching to s1 (different session) must emit exactly once
      const res2 = tm.switchSession(s1);
      assert.strictEqual(res2, true);
      assert.strictEqual(emitCount, 1, 'Should emit exactly once when switching to a different session');
      assert.strictEqual(tm.getActiveSessionId(), s1);

      // Switching to s1 again must not emit
      const res3 = tm.switchSession(s1);
      assert.strictEqual(res3, true);
      assert.strictEqual(emitCount, 1, 'Should not re-emit when switching to current active session again');
    } finally {
      tm.removeListener('session', listener);
      await tm.closeSession(s1);
      await tm.closeSession(s2);
    }
  });

  it('guarantees standalone popout renderer does not mutate global active session via setActiveTerminalSession on tab clicks', () => {
    const standaloneJsPath = path.resolve(process.cwd(), 'src/renderer/standalone.js');
    const content = fs.readFileSync(standaloneJsPath, 'utf8');
    // Ensure standalone.js has zero remaining calls to setActiveTerminalSession
    assert.strictEqual(
      content.includes('setActiveTerminalSession'),
      false,
      'standalone.js must not contain any setActiveTerminalSession calls that pollute singleton active tab state'
    );
  });

  it('verifies NativeTabHost popout lifecycle correctly tracks wasSidebarOpenBeforePopout', () => {
    const nativeTabHostPath = path.resolve(process.cwd(), 'src/main/browser/native-tab-host.ts');
    const content = fs.readFileSync(nativeTabHostPath, 'utf8');
    assert.ok(
      content.includes('wasSidebarOpenBeforePopout'),
      'NativeTabHost must track wasSidebarOpenBeforePopout to avoid reopening sidebars that were closed before popout'
    );
    assert.ok(
      content.includes('this.broadcastPopoutState(true)'),
      'NativeTabHost must broadcast popout state active on creation'
    );
    assert.ok(
      content.includes('this.broadcastPopoutState(false)'),
      'NativeTabHost must broadcast popout state inactive on teardown'
    );
  });

  it('verifies createSplitSession creates and closes split sessions cleanly regardless of capsule mismatch', async () => {
    const s1 = tm.createSession();
    const splitId = tm.createSplitSession(s1);
    assert.ok(splitId, 'Split session ID must be generated');
    assert.ok(splitId.startsWith('split-'), 'Split session ID format must be split-N');

    const sessionList = tm.listSessions();
    const parentSession = sessionList.find(s => s.id === s1);
    assert.strictEqual(parentSession?.splitSessionId, splitId, 'Parent session must reference splitSessionId');

    const closed = await tm.closeSplitSession(s1);
    assert.strictEqual(closed, true, 'closeSplitSession must succeed');
    await tm.closeSession(s1);
  });

  it('verifies standalone.html preserves canonical header actions and removes duplicate tab strip buttons', () => {
    const standaloneHtmlPath = path.resolve(process.cwd(), 'src/renderer/standalone.html');
    const html = fs.readFileSync(standaloneHtmlPath, 'utf8');
    assert.ok(html.includes('id="btnFullscreenHeader"'), 'btnFullscreenHeader must exist in header-actions');
    assert.ok(html.includes('id="btnNewTerminalWindow"'), 'btnNewTerminalWindow must exist in header-actions');
    assert.ok(html.includes('id="btnPopoutWindow"'), 'btnPopoutWindow must exist in header-actions');
    assert.ok(html.includes('id="btnOpenFolder"'), 'btnOpenFolder must exist in header-actions');
    assert.ok(html.includes('id="btnSplitTerminal"'), 'btnSplitTerminal must exist in controls');
    assert.ok(html.includes('id="btnNewTerminal"'), 'btnNewTerminal must exist in controls');

    assert.strictEqual(html.includes('id="btnFullscreenTerminalTab"'), false, 'btnFullscreenTerminalTab must be removed');
    assert.strictEqual(html.includes('id="btnNewWindowTerminalTab"'), false, 'btnNewWindowTerminalTab must be removed');
    assert.strictEqual(html.includes('id="btnPopoutTerminalTab"'), false, 'btnPopoutTerminalTab must be removed');
  });

});

function sessionsAfterS2(sessions: Array<{ id: string; active: boolean }>, s2Id: string) {
  return sessions.find((s) => s.id === s2Id);
}

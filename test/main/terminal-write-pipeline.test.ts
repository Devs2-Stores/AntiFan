import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  TerminalWriteDispatcher,
  sliceUtf8Bytes,
  getUtf8ByteLength,
  MAX_FRAME_WRITE_BYTES,
  type TerminalWritable,
} from '../../src/shared/terminal-write-dispatcher';
import { NativeTabHost, type TabHostCloseAdmission } from '../../src/main/browser/native-tab-host';
import type { IpcRoute } from '../../src/main/browser/ipc-router';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
import { TERMINAL_CHANNELS } from '../../src/shared/contracts';
import { CapabilityError } from '../../src/shared/control-plane-contracts';

describe('TerminalWriteDispatcher (Production Engine Test)', () => {
  it('executes 0ms fast-path write for single interactive chunks when idle', () => {
    const written: string[] = [];
    const mockTerm: TerminalWritable = {
      write(data: string, cb?: () => void) {
        written.push(data);
        cb?.();
      },
    };

    const dispatcher = new TerminalWriteDispatcher();
    const target = dispatcher.createTarget(mockTerm);

    dispatcher.queueWrite(target, 'ls -la\n');

    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0], 'ls -la\n');
    assert.strictEqual(target.isWriting, false);
    assert.strictEqual(target.writeQueue.length, 0);
  });

  it('guarantees strict FIFO ordering and in-flight backpressure when chunks arrive while writing', () => {
    const written: string[] = [];
    let finishInFlightWrite: (() => void) | null = null;

    const mockTerm: TerminalWritable = {
      write(data: string, cb?: () => void) {
        written.push(data);
        finishInFlightWrite = cb || null;
      },
    };

    const frameCallbacks: (() => void)[] = [];
    const dispatcher = new TerminalWriteDispatcher({
      requestFrame(cb) {
        frameCallbacks.push(cb);
        return frameCallbacks.length;
      },
      cancelFrame() {},
    });
    const target = dispatcher.createTarget(mockTerm);

    // 1. Send first chunk
    dispatcher.queueWrite(target, 'chunk-1');
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0], 'chunk-1');
    assert.strictEqual(target.isWriting, true);

    // 2. While write 1 is in-flight, send 3 more chunks
    dispatcher.queueWrite(target, 'chunk-2');
    dispatcher.queueWrite(target, 'chunk-3');
    dispatcher.queueWrite(target, 'chunk-4');

    // Verify chunks are queued, not sent yet
    assert.strictEqual(written.length, 1);
    assert.strictEqual(target.writeQueue.length, 3);
    assert.strictEqual(target.isWriting, true);

    // 3. Complete write 1
    assert.ok(finishInFlightWrite);
    const cb1 = finishInFlightWrite as () => void;
    finishInFlightWrite = null;
    cb1();
    // Advance frame for queued chunks
    assert.strictEqual(frameCallbacks.length, 1);
    frameCallbacks.shift()!();
    // Verify write 2 executed with all 3 chunks coalesced in strict FIFO order
    assert.strictEqual(written.length, 2);
    assert.strictEqual(written[1], 'chunk-2chunk-3chunk-4');
    assert.strictEqual(target.isWriting, true);

    // 4. Complete write 2
    assert.ok(finishInFlightWrite);
    const cb2 = finishInFlightWrite as () => void;
    finishInFlightWrite = null;
    cb2();

    assert.strictEqual(target.isWriting, false);
    assert.strictEqual(target.writeQueue.length, 0);
  });

  it('correctly slices strings at UTF-8 code-point and surrogate-pair boundaries without corruption', () => {
    // Mixed ASCII, Vietnamese (3 bytes per char), and Emoji surrogate pairs (4 bytes, 2 UTF-16 code units)
    const testStr = 'Xin chào Việt Nam 🇻🇳 🚀🔥✨!';
    const totalBytes = getUtf8ByteLength(testStr);

    // Test slicing at every single byte boundary from 1 to totalBytes + 5
    for (let budget = 1; budget <= totalBytes + 5; budget++) {
      const { head, tail, bytes } = sliceUtf8Bytes(testStr, budget);
      assert.ok(bytes <= budget, `Bytes ${bytes} must not exceed budget ${budget}`);
      assert.strictEqual(head + tail, testStr, 'head + tail must perfectly reconstruct original string with zero loss');
      assert.ok(!head.includes('\uFFFD'), 'head must never contain Unicode replacement character');
      assert.ok(!tail.includes('\uFFFD'), 'tail must never contain Unicode replacement character');
    }
  });

  it('bounds large multi-frame writes to 64KB per frame and yields to browser frame schedule', () => {
    const frameCallbacks: (() => void)[] = [];
    const dispatcher = new TerminalWriteDispatcher({
      requestFrame(cb) {
        frameCallbacks.push(cb);
        return frameCallbacks.length;
      },
      cancelFrame() {},
    });

    const writtenSlices: string[] = [];
    let inFlightCb: (() => void) | null = null;

    const mockTerm: TerminalWritable = {
      write(data: string, cb?: () => void) {
        writtenSlices.push(data);
        inFlightCb = cb || null;
      },
    };

    const target = dispatcher.createTarget(mockTerm);

    // Create a 150K-unit payload consisting of mixed Unicode text (the frame
    // budget is measured in UTF-16 code units, not UTF-8 bytes)
    const pattern = 'Line [TEST] - Chào mừng đến với AntiFan Browser 🚀\n';
    let largePayload = '';
    while (largePayload.length < 150 * 1024) {
      largePayload += pattern;
    }
    const totalExpectedBytes = getUtf8ByteLength(largePayload);

    // Queue the 150KB payload
    dispatcher.queueWrite(target, largePayload);

    // Slice 1: Must be sent immediately (queue >= 64K units) but capped to <= 64K UTF-16 code units
    assert.strictEqual(writtenSlices.length, 1);
    assert.ok(writtenSlices[0]!.length <= MAX_FRAME_WRITE_BYTES);
    assert.strictEqual(target.isWriting, true);

    // Complete Frame 1 write in xterm
    assert.ok(inFlightCb);
    const cb1 = inFlightCb as () => void;
    inFlightCb = null;
    cb1();

    // Verify next slice was scheduled via requestFrame
    assert.strictEqual(frameCallbacks.length, 1);
    // Execute Frame 2 callback
    const frameCb1 = frameCallbacks.shift()!;
    frameCb1();

    // Slice 2: Sent to xterm, capped to <= 64K UTF-16 code units
    assert.strictEqual(writtenSlices.length, 2);
    assert.ok(writtenSlices[1]!.length <= MAX_FRAME_WRITE_BYTES);

    // Complete Frame 2 write in xterm
    assert.ok(inFlightCb);
    const cb2 = inFlightCb as () => void;
    inFlightCb = null;
    cb2();

    // Verify Frame 3 scheduled
    assert.strictEqual(frameCallbacks.length, 1);
    const frameCb2 = frameCallbacks.shift()!;
    frameCb2();

    // Slice 3: Remaining payload sent
    assert.strictEqual(writtenSlices.length, 3);

    // Complete Frame 3 write
    assert.ok(inFlightCb);
    const cb3 = inFlightCb as () => void;
    inFlightCb = null;
    cb3();

    // Verify queue is now empty and all data reconstructed with 100% fidelity
    assert.strictEqual(target.isWriting, false);
    assert.strictEqual(target.writeQueue.length, 0);
    const reconstructed = writtenSlices.join('');
    assert.strictEqual(reconstructed, largePayload);
    assert.strictEqual(getUtf8ByteLength(reconstructed), totalExpectedBytes);
  });

  it('supports isolated multi-target queues (main and split) without interference', () => {
    const mainWritten: string[] = [];
    const splitWritten: string[] = [];

    const dispatcher = new TerminalWriteDispatcher();
    const mainTarget = dispatcher.createTarget({
      write(data, cb) {
        mainWritten.push(data);
        cb?.();
      },
    });
    const splitTarget = dispatcher.createTarget({
      write(data, cb) {
        splitWritten.push(data);
        cb?.();
      },
    });

    dispatcher.queueWrite(mainTarget, 'main-1');
    dispatcher.queueWrite(splitTarget, 'split-1');

    assert.deepStrictEqual(mainWritten, ['main-1']);
    assert.deepStrictEqual(splitWritten, ['split-1']);
  });
});

describe('Terminal route admission — write settlement and restart gate', () => {
  /** The close-admission seam as the coordinator implements it: reservations plus in-flight accounting. */
  class StubAdmission implements TabHostCloseAdmission {
    public began = 0;
    public cleared = 0;
    public inFlight = 0;
    public applicationReserved = false;
    public ownerReserved = false;
    public isPageReserved(_tabId: string): boolean {
      return false;
    }
    public isApplicationAdmissionReserved(): boolean {
      return this.applicationReserved;
    }
    public isOwnerReserved(_ownerKey: string): boolean {
      return this.ownerReserved;
    }
    public beginAdmittedOperation(): () => void {
      this.began += 1;
      this.inFlight += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.cleared += 1;
        this.inFlight -= 1;
      };
    }
  }

  /** A prototype-built host carrying only the seam these routes read; rows that need an owner attribution or method stubs pre-seed them. */
  function buildRouteHost(admission: StubAdmission, ownerKey?: string, stubs?: Record<string, unknown>): NativeTabHost {
    const host = Object.create(NativeTabHost.prototype) as Record<string, unknown>;
    host.closeAdmission = admission;
    // Field initializers do not run on a prototype-built double; the terminal-window meta
    // map is the one a route reads while it resolves the session this window presents.
    host.terminalWindowMeta = new Map();
    if (ownerKey !== undefined) {
      // The shell/sender plumbing is not what these rows measure — only the admission gate is.
      host.shellOwnerKeyForSender = () => ownerKey;
    }
    if (stubs) Object.assign(host, stubs);
    return host as unknown as NativeTabHost;
  }

  function chromeRoute(channel: string): IpcRoute {
    const route = NativeTabHost.CHROME_ROUTES.find((r) => r.channel === channel);
    if (!route) throw new Error(`route not registered: ${channel}`);
    return route;
  }

  it('holds the input route\'s close admission until the write\'s own promise settles, releasing on resolve and on rejection', async () => {
    const admission = new StubAdmission();
    const host = buildRouteHost(admission);

    // The singleton is installed by cast in production, so the route must hold whatever
    // the write returns — here a deferred promise, exactly what the daemon proxy answers.
    // The session the window presents is named through the same scope seam production uses.
    const writes: Array<{ sessionId: string; input: string; deferred: PromiseWithResolvers<boolean> }> = [];
    const fakeManager = {
      sessionCapsuleId: (_sessionId: string) => undefined,
      getSessionState: () => ({
        activeSessionId: 'terminal-own',
        sessions: [{ id: 'terminal-own' }],
        snapshot: '',
        snapshotThroughSeq: 0,
      }),
      getActiveSessionId: () => 'terminal-own',
      writeTo(sessionId: string, input: string) {
        const deferred = Promise.withResolvers<boolean>();
        writes.push({ sessionId, input, deferred });
        return deferred.promise;
      },
    };
    TerminalManager.setInstance(fakeManager);
    try {
      const inputRoute = chromeRoute(TERMINAL_CHANNELS.INPUT);

      // Resolve path: the admission stays measured while the write's promise is pending.
      const pending = inputRoute.run({ host, surface: 'sidebar' }, undefined, ['echo hi\n']) as Promise<boolean>;
      assert.equal(writes.length, 1);
      assert.equal(writes[0]!.sessionId, 'terminal-own', 'the write names the session this window presents');
      assert.equal(writes[0]!.input, 'echo hi\n');
      assert.equal(admission.began, 1, 'the write is registered before control leaves the route');
      assert.equal(admission.inFlight, 1, 'the close seam still reports the write in flight while its promise is pending');
      writes[0]!.deferred.resolve(true);
      assert.equal(await pending, true, 'the route returns the write\'s own result');
      assert.equal(admission.inFlight, 0);
      assert.equal(admission.cleared, 1, 'released exactly once on settle');

      // Rejection path: the seam must release too — a stuck admission would hold every
      // later close open for a write that already failed.
      const failing = inputRoute.run({ host, surface: 'sidebar' }, undefined, ['bad write\n']) as Promise<boolean>;
      assert.equal(admission.inFlight, 1);
      writes[1]!.deferred.reject(new Error('daemon socket closed'));
      await assert.rejects(failing, /daemon socket closed/);
      assert.equal(admission.inFlight, 0, 'the admission releases on rejection too');
      assert.equal(admission.cleared, 2);
      assert.equal(admission.began, 2);
    } finally {
      TerminalManager.setInstance(undefined);
    }
  });

  it('refuses RESTART while a quit holds application admission, without touching the manager', async () => {
    const admission = new StubAdmission();
    admission.applicationReserved = true;
    const host = buildRouteHost(admission);
    let restartCalls = 0;
    TerminalManager.setInstance({ restart: async () => { restartCalls += 1; return true; } });
    try {
      const restartRoute = chromeRoute(TERMINAL_CHANNELS.RESTART);
      let refusal: unknown;
      try {
        await restartRoute.run({ host, surface: 'sidebar' }, undefined, [undefined]);
      } catch (err) {
        refusal = err;
      }
      if (!(refusal instanceof CapabilityError)) assert.fail('the route must refuse with a CapabilityError');
      assert.equal(refusal.code, 'RUNTIME_DRAINING');
      assert.equal(restartCalls, 0, 'a refused restart never reaches the manager');
      assert.equal(admission.began, 0, 'a refused restart is never registered as admitted work');
    } finally {
      TerminalManager.setInstance(undefined);
    }
  });

  it('refuses RESTART while the asking window is closing, without touching the manager', async () => {
    const admission = new StubAdmission();
    admission.ownerReserved = true;
    const host = buildRouteHost(admission, 'project:test');
    let restartCalls = 0;
    TerminalManager.setInstance({ restart: async () => { restartCalls += 1; return true; } });
    try {
      const restartRoute = chromeRoute(TERMINAL_CHANNELS.RESTART);
      let refusal: unknown;
      try {
        await restartRoute.run({ host, surface: 'sidebar' }, undefined, [undefined]);
      } catch (err) {
        refusal = err;
      }
      if (!(refusal instanceof CapabilityError)) assert.fail('the route must refuse with a CapabilityError');
      assert.equal(refusal.code, 'TARGET_STALE');
      assert.equal(restartCalls, 0);
      assert.equal(admission.began, 0);
    } finally {
      TerminalManager.setInstance(undefined);
    }
  });

  it('lets RESTART run when admission is open, measured for its duration and released once it settles', async () => {
    const admission = new StubAdmission();
    const host = buildRouteHost(admission);
    let restartCalls = 0;
    let inFlightDuringRestart = -1;
    TerminalManager.setInstance({
      sessionCapsuleId: (_sessionId: string) => undefined,
      getSessionState: () => ({
        activeSessionId: 'terminal-own',
        sessions: [{ id: 'terminal-own' }],
        snapshot: '',
        snapshotThroughSeq: 0,
      }),
      getActiveSessionId: () => 'terminal-own',
      getSession: (id: string) => (id === 'terminal-own' ? { id } : undefined),
      restart: async () => {
        restartCalls += 1;
        inFlightDuringRestart = admission.inFlight;
        return true;
      },
    });
    try {
      const restartRoute = chromeRoute(TERMINAL_CHANNELS.RESTART);
      const result = await restartRoute.run({ host, surface: 'sidebar' }, undefined, [undefined]);
      assert.equal(result, true);
      assert.equal(restartCalls, 1);
      assert.equal(inFlightDuringRestart, 1, 'the mint stays measurable while the restart runs');
      assert.equal(admission.inFlight, 0, 'and its admission is released once it settles');
      assert.equal(admission.cleared, 1);
    } finally {
      TerminalManager.setInstance(undefined);
    }
  });

  it('refuses popout/new-window mints while the asking window is closing, and runs them once it is open', () => {
    const admission = new StubAdmission();
    admission.ownerReserved = true;
    let popoutCalls = 0;
    let newWindowCalls = 0;
    const host = buildRouteHost(admission, 'project:test', {
      togglePopoutTerminal: () => { popoutCalls += 1; return true; },
      openNewTerminalWindow: () => { newWindowCalls += 1; return {}; },
    });
    const popoutRoute = chromeRoute(TERMINAL_CHANNELS.POPOUT);
    const newWindowRoute = chromeRoute(TERMINAL_CHANNELS.NEW_WINDOW);

    for (const [name, route] of [['popout', popoutRoute], ['new-window', newWindowRoute]] as const) {
      let refusal: unknown;
      try {
        route.run({ host, surface: 'sidebar' }, undefined, [undefined]);
      } catch (err) {
        refusal = err;
      }
      if (!(refusal instanceof CapabilityError)) assert.fail(`${name} must refuse with a CapabilityError`);
      assert.equal(refusal.code, 'TARGET_STALE', `${name} must refuse for its own closing window, not only for a quit`);
    }
    assert.equal(popoutCalls, 0, 'a refused popout never reaches the mint');
    assert.equal(newWindowCalls, 0, 'a refused window never reaches the mint');

    admission.ownerReserved = false;
    assert.equal(popoutRoute.run({ host, surface: 'sidebar' }, undefined, [undefined]), true);
    assert.equal(popoutCalls, 1);
    newWindowRoute.run({ host, surface: 'sidebar' }, undefined, [{ sessionId: 'terminal-1' }]);
    assert.equal(newWindowCalls, 1);
  });

  it('refuses capsule:switch into a draining or closing window before any mutation, and holds its setCapsule admission until the call settles', async () => {
    const admission = new StubAdmission();
    admission.applicationReserved = true;
    const capsules: string[] = [];
    let setCapsuleCalls = 0;
    const setCapsuleDeferreds: Array<PromiseWithResolvers<void>> = [];
    const host = buildRouteHost(admission, 'project:test', {
      capsuleManager: {
        switchTo: (id: string) => { capsules.push(id); },
        getActive: () => ({ workspacePath: '/ws' }),
      },
    });
    TerminalManager.setInstance({
      setCapsule: () => {
        setCapsuleCalls += 1;
        const deferred = Promise.withResolvers<void>();
        setCapsuleDeferreds.push(deferred);
        return deferred.promise;
      },
    });
    try {
      const switchRoute = chromeRoute('antifan:capsule:switch');

      // A quit holds application admission: the route refuses before any mint work.
      let refusal: unknown;
      try {
        switchRoute.run({ host, surface: 'sidebar' }, undefined, [{ capsuleId: 'cap-1' }]);
      } catch (err) {
        refusal = err;
      }
      if (!(refusal instanceof CapabilityError)) assert.fail('the route must refuse with a CapabilityError');
      assert.equal(refusal.code, 'RUNTIME_DRAINING');
      assert.deepStrictEqual(capsules, [], 'a refused switch leaves the active capsule unchanged');
      assert.equal(setCapsuleCalls, 0, 'a refused switch never spawns terminal work');
      assert.equal(admission.began, 0);

      // The asking window's own close is the second refusal — it must refuse before
      // switchTo, or the reservation would throw with the capsule already moved.
      admission.applicationReserved = false;
      admission.ownerReserved = true;
      refusal = undefined;
      try {
        switchRoute.run({ host, surface: 'sidebar' }, undefined, [{ capsuleId: 'cap-1' }]);
      } catch (err) {
        refusal = err;
      }
      if (!(refusal instanceof CapabilityError)) assert.fail('the route must refuse with a CapabilityError');
      assert.equal(refusal.code, 'TARGET_STALE');
      assert.deepStrictEqual(capsules, [], 'the owner refusal precedes the mutation, not follows it');
      assert.equal(setCapsuleCalls, 0);
      assert.equal(admission.began, 0);

      // Open admission: the synchronous route returns true immediately while its
      // admission rides setCapsule's own settlement — here the daemon shape, a pending
      // promise — and releases on rejection too, without an unhandled rejection.
      admission.ownerReserved = false;
      const answer = switchRoute.run({ host, surface: 'sidebar' }, undefined, [{ capsuleId: 'cap-1', sessionId: 'terminal-9' }]);
      assert.equal(answer, true, 'the synchronous wire answer stays a literal true');
      assert.deepStrictEqual(capsules, ['cap-1']);
      assert.equal(setCapsuleCalls, 1);
      assert.equal(admission.inFlight, 1, 'the mint stays visible to the close while setCapsule is in flight');
      setCapsuleDeferreds[0]!.reject(new Error('daemon socket closed'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(admission.inFlight, 0, 'the admission releases on rejection too');
      assert.equal(admission.cleared, 1);
      assert.equal(admission.began, 1);

      // Resolve path: a delivered setCapsule releases the same admission once.
      switchRoute.run({ host, surface: 'sidebar' }, undefined, [{ capsuleId: 'cap-1' }]);
      assert.equal(admission.inFlight, 1);
      setCapsuleDeferreds[1]!.resolve();
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(admission.inFlight, 0);
      assert.equal(admission.cleared, 2);
      assert.equal(admission.began, 2);
    } finally {
      TerminalManager.setInstance(undefined);
    }
  });

  it('binds agent affinity from the start settlement in daemon mode, and synchronously in-process', async () => {
    const admission = new StubAdmission();
    const bound: Array<{ sessionId: string; generation: number | undefined; tabId: string }> = [];
    const host = buildRouteHost(admission, undefined, {
      findTabByWebContents: () => ({ tabId: 'tab-agent', tab: { state: { ephemeral: true } } }),
      bindTerminalAgentAffinity: (sessionId: string, generation: number | undefined, tabId: string) => {
        bound.push({ sessionId, generation, tabId });
      },
    });
    const startRoute = chromeRoute(TERMINAL_CHANNELS.START);

    // Daemon shape: startTerminal is a round-trip. The session it mints must not be
    // observable until the promise resolves, so a binding that reads active state early
    // would attach to the previous session.
    const startDeferred = Promise.withResolvers<boolean>();
    let live = false;
    TerminalManager.setInstance({
      startTerminal: () => startDeferred.promise,
      getActiveSessionId: () => (live ? 'terminal-5' : ''),
      getSession: (id: string) => (live && id === 'terminal-5' ? { sessionGeneration: 3 } : undefined),
    });
    try {
      const pending = startRoute.run({ host, surface: 'sidebar' }, undefined, ['cwd-x']) as Promise<boolean>;
      assert.equal(admission.inFlight, 1, 'the mint stays visible while the daemon round-trips');
      await Promise.resolve();
      assert.deepStrictEqual(bound, [], 'no binding may happen before the session exists');

      live = true;
      startDeferred.resolve(true);
      assert.equal(await pending, true);
      assert.deepStrictEqual(bound, [{ sessionId: 'terminal-5', generation: 3, tabId: 'tab-agent' }],
        'the affinity names the session the daemon just minted, with its generation');
      assert.equal(admission.inFlight, 0);
      assert.equal(admission.cleared, 1);
    } finally {
      TerminalManager.setInstance(undefined);
    }

    // In-process shape: a boolean answer binds in the same tick — no promise, no drift.
    const admission2 = new StubAdmission();
    const bound2: Array<{ sessionId: string; generation: number | undefined; tabId: string }> = [];
    const host2 = buildRouteHost(admission2, undefined, {
      findTabByWebContents: () => ({ tabId: 'tab-agent', tab: { state: { ephemeral: true } } }),
      bindTerminalAgentAffinity: (sessionId: string, generation: number | undefined, tabId: string) => {
        bound2.push({ sessionId, generation, tabId });
      },
    });
    TerminalManager.setInstance({
      startTerminal: () => true,
      getActiveSessionId: () => 'terminal-1',
      getSession: () => ({ sessionGeneration: 1 }),
    });
    try {
      const answer = startRoute.run({ host: host2, surface: 'sidebar' }, undefined, ['cwd-x']);
      assert.equal(answer, true, 'the in-process route keeps its synchronous boolean');
      assert.deepStrictEqual(bound2, [{ sessionId: 'terminal-1', generation: 1, tabId: 'tab-agent' }],
        'the binding still happens synchronously in the same tick');
      assert.equal(admission2.inFlight, 0);
      assert.equal(admission2.cleared, 1);
    } finally {
      TerminalManager.setInstance(undefined);
    }
  });

  it('aims the agent restart at the owned session and restores the previous active session only after it settles', async () => {
    const admission = new StubAdmission();
    const calls: string[] = [];
    const switchDeferreds: Array<PromiseWithResolvers<boolean>> = [];
    const restartDeferreds: Array<PromiseWithResolvers<void>> = [];
    const host = buildRouteHost(admission, undefined, {
      findTabByWebContents: () => ({ tabId: 'tab-agent', tab: { state: { ephemeral: true } } }),
      getOwnedTerminalSession: () => 'terminal-9',
      assertTerminalAccess: () => {},
    });
    TerminalManager.setInstance({
      getActiveSessionId: () => 'terminal-1',
      getSession: (id: string) => (id === 'terminal-1' ? {} : undefined),
      switchSession: (id: string) => {
        calls.push(`switch:${id}`);
        const deferred = Promise.withResolvers<boolean>();
        switchDeferreds.push(deferred);
        return deferred.promise;
      },
      restart: () => {
        calls.push('restart');
        const deferred = Promise.withResolvers<void>();
        restartDeferreds.push(deferred);
        return deferred.promise;
      },
    });
    try {
      const restartRoute = chromeRoute(TERMINAL_CHANNELS.RESTART);
      const pending = restartRoute.run({ host, surface: 'sidebar' }, undefined, [undefined]) as Promise<boolean>;

      // The switch to the owned session is a daemon round-trip: until it resolves the
      // restart must not fire, or it would restart the previously active PTY.
      await Promise.resolve();
      await Promise.resolve();
      assert.deepStrictEqual(calls, ['switch:terminal-9'], 'the owned session switch happens first');
      assert.equal(admission.inFlight, 1);

      switchDeferreds[0]!.resolve(true);
      await Promise.resolve();
      await Promise.resolve();
      assert.deepStrictEqual(calls, ['switch:terminal-9', 'restart'], 'restart waits for the switch to settle');

      restartDeferreds[0]!.resolve();
      await Promise.resolve();
      await Promise.resolve();
      assert.deepStrictEqual(calls, ['switch:terminal-9', 'restart', 'switch:terminal-1'],
        'the previous active session is restored only after the restart settles');

      switchDeferreds[1]!.resolve(true);
      assert.equal(await pending, true);
      assert.equal(admission.inFlight, 0, 'the admission spans the whole sequence, restore included');
      assert.equal(admission.cleared, 1);
    } finally {
      TerminalManager.setInstance(undefined);
    }
  });
});

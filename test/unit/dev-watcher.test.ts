import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { WebSocket as WsInterface } from 'ws';
import type { TscLineState } from '../../scripts/dev-watcher-helpers.d.mts';
import {
  isHotSwappable,
  processTscLine,
  sendSoftReload,
  resolveDevBridgeInfo,
  createChangeDispatcher,
} from '../../scripts/dev-watcher-helpers.mjs';

describe('Dev Watcher Helpers', () => {
  describe('isHotSwappable classifier', () => {
    it('accurately identifies external cdp override scripts', () => {
      assert.strictEqual(isHotSwappable('scripts/cdp/media-freeze.source.js'), true);
      assert.strictEqual(isHotSwappable('scripts/cdp/custom-probe.source.js'), true);
      assert.strictEqual(isHotSwappable('scripts\\cdp\\windows-path.source.js'), true);
      assert.strictEqual(isHotSwappable('/scripts/cdp/leading-slash.source.js'), true);
    });

    it('rejects compiled source files, nested paths, and non-source extensions', () => {
      assert.strictEqual(isHotSwappable('src/main/browser/scripts/injected-script-store.ts'), false);
      assert.strictEqual(isHotSwappable('src/main/tools/browser-control-port.ts'), false);
      assert.strictEqual(isHotSwappable('scripts/cdp/nested/deep.source.js'), false);
      assert.strictEqual(isHotSwappable('scripts/cdp/plain.js'), false);
      assert.strictEqual(isHotSwappable('scripts/cdp/plain.ts'), false);
      assert.strictEqual(isHotSwappable('scripts/cdp/plain.source.ts'), false);
      assert.strictEqual(isHotSwappable(''), false);
      assert.strictEqual(isHotSwappable(null as unknown as string), false);
      assert.strictEqual(isHotSwappable(undefined as unknown as string), false);
    });
  });

  describe('processTscLine state transitions', () => {
    it('detects compilation start and resets error flag', () => {
      const s1 = processTscLine('Starting compilation in watch mode...', { isTscCompiling: false, tscHasErrors: true });
      assert.strictEqual(s1.isTscCompiling, true);
      assert.strictEqual(s1.tscHasErrors, false);
      assert.strictEqual(s1.settled, false);

      const s2 = processTscLine('File change detected. Starting incremental compilation...', { isTscCompiling: false, tscHasErrors: true });
      assert.strictEqual(s2.isTscCompiling, true);
      assert.strictEqual(s2.tscHasErrors, false);
    });

    it('detects compiler errors and gates error state', () => {
      let state: TscLineState = { isTscCompiling: true, tscHasErrors: false, settled: false };
      state = processTscLine('src/main/foo.ts(12,5): error TS2322: Type "string" is not assignable to type "number".', state);
      assert.strictEqual(state.tscHasErrors, true);
      assert.strictEqual(state.isTscCompiling, true);

      state = processTscLine('Found 1 error. Watching for file changes.', state);
      assert.strictEqual(state.isTscCompiling, false);
      assert.strictEqual(state.tscHasErrors, true, 'Error state must persist across settle when errors were found');
      assert.strictEqual(state.settled, true);
    });

    it('detects clean zero-error compilation', () => {
      let state: TscLineState = { isTscCompiling: true, tscHasErrors: true, settled: false };
      state = processTscLine('Found 0 errors. Watching for file changes.', state);
      assert.strictEqual(state.isTscCompiling, false);
      assert.strictEqual(state.tscHasErrors, false, 'Zero errors must clear tscHasErrors');
      assert.strictEqual(state.settled, true);
    });
  });

  describe('sendSoftReload client', () => {
    class MockWs extends EventEmitter {
      public sent: string[] = [];
      public closed = false;
      constructor(public url: string) {
        super();
        queueMicrotask(() => this.emit('open'));
      }
      send(data: string) {
        this.sent.push(data);
      }
      close() {
        this.closed = true;
      }
    }

    it('resolves true on matching reqId and success response', async () => {
      let clientWs: MockWs | null = null;
      const wsFactory = function (url: string) {
        clientWs = new MockWs(url);
        clientWs.on('open', () => {
          queueMicrotask(() => {
            const req = JSON.parse(clientWs!.sent[0] || '{}');
            // Send unrelated message first (broadcast frame)
            clientWs!.emit('message', Buffer.from(JSON.stringify({ event: 'antifan:broadcast', seq: 1 })));
            // Then send matching response
            clientWs!.emit('message', Buffer.from(JSON.stringify({ id: req.id, success: true, data: { reloaded: true } })));
          });
        });
        return clientWs;
      };

      const result = await sendSoftReload({
        bridgeInfo: { port: 20130, token: 'test-tok' },
        wsFactory: wsFactory as unknown as typeof WsInterface,
        timeoutMs: 500,
      });

      assert.strictEqual(result, true);
      assert.strictEqual(clientWs!.closed, true, 'WebSocket should be closed after successful reload');
    });

    it('resolves false on matching reqId and error response', async () => {
      const wsFactory = function (url: string) {
        const clientWs = new MockWs(url);
        clientWs.on('open', () => {
          queueMicrotask(() => {
            const req = JSON.parse(clientWs!.sent[0] || '{}');
            clientWs!.emit('message', Buffer.from(JSON.stringify({ id: req.id, success: false, error: 'FORBIDDEN' })));
          });
        });
        return clientWs;
      };

      const result = await sendSoftReload({
        bridgeInfo: { port: 20130, token: 'test-tok' },
        wsFactory: wsFactory as unknown as typeof WsInterface,
        timeoutMs: 500,
      });

      assert.strictEqual(result, false);
    });

    it('fails closed and returns false when connection fails', async () => {
      const failingWsFactory = function () {
        const clientWs = new MockWs('ws://invalid');
        queueMicrotask(() => clientWs.emit('error', new Error('ECONNREFUSED')));
        return clientWs;
      };

      const result = await sendSoftReload({
        bridgeInfo: { port: 20130, token: 'test-token' },
        wsFactory: failingWsFactory as unknown as typeof WsInterface,
        timeoutMs: 100,
      });

      assert.strictEqual(result, false);
    });

    it('fails closed and returns false immediately when bridgeInfo, token, or port is invalid', async () => {
      let factoryCalled = false;
      const wsFactory = function () {
        factoryCalled = true;
        return new MockWs('ws://invalid');
      };

      // 1. Missing bridgeInfo
      const res1 = await sendSoftReload({ bridgeInfo: null, wsFactory: wsFactory as unknown as typeof WsInterface });
      assert.strictEqual(res1, false);

      // 2. Empty or whitespace token
      const res2 = await sendSoftReload({ bridgeInfo: { port: 20130, token: '   ' }, wsFactory: wsFactory as unknown as typeof WsInterface });
      assert.strictEqual(res2, false);

      // 3. Out-of-range port (> 65535, < 1, 0, non-integer)
      const res3 = await sendSoftReload({ bridgeInfo: { port: 99999, token: 'valid-tok' }, wsFactory: wsFactory as unknown as typeof WsInterface });
      assert.strictEqual(res3, false);
      const res4 = await sendSoftReload({ bridgeInfo: { port: 0, token: 'valid-tok' }, wsFactory: wsFactory as unknown as typeof WsInterface });
      assert.strictEqual(res4, false);
      const res5 = await sendSoftReload({ bridgeInfo: { port: -1, token: 'valid-tok' }, wsFactory: wsFactory as unknown as typeof WsInterface });
      assert.strictEqual(res5, false);
      const res6 = await sendSoftReload({ bridgeInfo: { port: 20130.5, token: 'valid-tok' }, wsFactory: wsFactory as unknown as typeof WsInterface });
      assert.strictEqual(res6, false);

      assert.strictEqual(factoryCalled, false, 'Should fail closed before creating WebSocket on any invalid config');
    });

    it('resolves false promptly when socket closes before response', async () => {
      const wsFactory = function (url: string) {
        const clientWs = new MockWs(url);
        clientWs.on('open', () => {
          queueMicrotask(() => clientWs.emit('close'));
        });
        return clientWs;
      };

      const result = await sendSoftReload({
        bridgeInfo: { port: 20130, token: 'test-tok' },
        wsFactory: wsFactory as unknown as typeof WsInterface,
        timeoutMs: 500,
      });

      assert.strictEqual(result, false);
    });
  });

  describe('resolveDevBridgeInfo', () => {
    it('discovers config from custom directory list and parses valid JSON', () => {
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-bridge-test-'));
      try {
        fs.writeFileSync(path.join(tmpDir, 'bridge-dev.json'), JSON.stringify({ port: 20130, token: 'custom-tok' }));
        const found = resolveDevBridgeInfo([tmpDir]);
        assert.notStrictEqual(found, null);
        assert.strictEqual(found?.port, 20130);
        assert.strictEqual(found?.token, 'custom-tok');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('returns null when candidates have missing or malformed files', () => {
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-bridge-malformed-'));
      try {
        fs.writeFileSync(path.join(tmpDir, 'bridge-dev.json'), 'invalid-json{{{');
        const found = resolveDevBridgeInfo([tmpDir]);
        assert.strictEqual(found, null);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('createChangeDispatcher', () => {
    it('coalesces rapid sequential calls and resolves all callers with the same result without leaking promises', async () => {
      let reloadCalls = 0;
      const dispatcher = createChangeDispatcher({
        isHotSwappableFn: () => true,
        sendSoftReloadFn: async () => {
          reloadCalls++;
          return true;
        },
        getElectronProc: () => ({ pid: 1234 }),
        debounceMs: 50,
      });

      // Fire 3 rapid calls in same debounce cycle
      const p1 = dispatcher.scheduleRelaunch('scripts/cdp/1.source.js');
      const p2 = dispatcher.scheduleRelaunch('scripts/cdp/2.source.js');
      const p3 = dispatcher.scheduleRelaunch('scripts/cdp/3.source.js');

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      assert.strictEqual(reloadCalls, 1, 'Should coalesce into exactly 1 reload call');
      assert.deepStrictEqual(r1, { action: 'soft_reload', success: true });
      assert.deepStrictEqual(r2, { action: 'soft_reload', success: true });
      assert.deepStrictEqual(r3, { action: 'soft_reload', success: true });
    });

    it('routes cold changes through compiler gate, static copy, and electron relaunch', async () => {
      let staticCopied = false;
      let electronRelaunched = false;

      const dispatcher = createChangeDispatcher({
        isHotSwappableFn: () => false,
        copyStaticFn: () => {
          staticCopied = true;
        },
        relaunchElectronFn: async () => {
          electronRelaunched = true;
        },
        getTscCompiling: () => false,
        getTscErrors: () => false,
        debounceMs: 30,
      });

      const result = await dispatcher.scheduleRelaunch('src/main/index.ts');
      assert.deepStrictEqual(result, { action: 'relaunch', success: true });
      assert.strictEqual(staticCopied, true);
      assert.strictEqual(electronRelaunched, true);
    });

    it('skips relaunch when tsc has errors', async () => {
      let electronRelaunched = false;
      const dispatcher = createChangeDispatcher({
        isHotSwappableFn: () => false,
        relaunchElectronFn: async () => {
          electronRelaunched = true;
        },
        getTscCompiling: () => false,
        getTscErrors: () => true, // active errors
        debounceMs: 20,
      });

      const result = await dispatcher.scheduleRelaunch('src/main/foo.ts');
      assert.deepStrictEqual(result, { action: 'skip_compiler_error', success: false });
      assert.strictEqual(electronRelaunched, false);
    });

    it('cancels active timer, rejects pending promises, and prevents post-dispose scheduling', async () => {
      let reloadCalls = 0;
      const dispatcher = createChangeDispatcher({
        isHotSwappableFn: () => true,
        sendSoftReloadFn: async () => {
          reloadCalls++;
          return true;
        },
        debounceMs: 200,
      });

      const p1 = dispatcher.scheduleRelaunch('scripts/cdp/1.source.js');
      const p2 = dispatcher.scheduleRelaunch('scripts/cdp/2.source.js');

      assert.strictEqual(dispatcher.getPendingFiles().length, 2);

      // Cancel before debounce fires - pending promises must reject
      dispatcher.cancel('Test cancellation');

      assert.strictEqual(dispatcher.getPendingFiles().length, 0);

      await assert.rejects(p1, /Test cancellation/);
      await assert.rejects(p2, /Test cancellation/);
      assert.strictEqual(reloadCalls, 0, 'No reload call should have occurred');

      // Test dispose: pending promises must reject with disposed
      const p3 = dispatcher.scheduleRelaunch('scripts/cdp/3.source.js');
      dispatcher.dispose();
      assert.strictEqual(dispatcher.isDisposed(), true);
      await assert.rejects(p3, /disposed/i);

      // Test post-dispose call: must immediately reject without creating timer or queuing files
      await assert.rejects(dispatcher.scheduleRelaunch('scripts/cdp/4.source.js'), /disposed/i);
      assert.strictEqual(dispatcher.getPendingFiles().length, 0);
      assert.strictEqual(reloadCalls, 0);
    });

    it('aborts in-flight soft reload without calling relaunch if disposed while awaiting reload response', async () => {
      let softReloadStarted = false;
      let resumeSoftReload: ((val: boolean) => void) | null = null;
      let electronRelaunched = false;

      const dispatcher = createChangeDispatcher({
        isHotSwappableFn: () => true,
        sendSoftReloadFn: () => {
          softReloadStarted = true;
          return new Promise<boolean>((resolve) => {
            resumeSoftReload = resolve;
          });
        },
        relaunchElectronFn: async () => {
          electronRelaunched = true;
        },
        getElectronProc: () => ({ pid: 1234 }),
        debounceMs: 20,
      });

      const schedulePromise = dispatcher.scheduleRelaunch('scripts/cdp/1.source.js');

      // Wait until soft reload starts executing
      while (!softReloadStarted) {
        await new Promise((r) => setTimeout(r, 5));
      }

      // Dispose while awaiting softReloadFn
      dispatcher.dispose();

      // Now complete the pending soft reload as false (which would normally trigger fallback relaunch)
      if (typeof resumeSoftReload === 'function') {
        (resumeSoftReload as (v: boolean) => void)(false);
      }
      await assert.rejects(schedulePromise, /disposed/i);
      assert.strictEqual(electronRelaunched, false, 'Should NEVER trigger fallback relaunch after disposal');
    });

    it('aborts in-flight compiler wait without calling copyStatic or relaunch if disposed while awaiting compiler', async () => {
      let compilerStarted = false;
      let resumeCompiler: ((val: boolean) => void) | null = null;
      let staticCopied = false;
      let electronRelaunched = false;

      const dispatcher = createChangeDispatcher({
        isHotSwappableFn: () => false,
        copyStaticFn: () => {
          staticCopied = true;
        },
        relaunchElectronFn: async () => {
          electronRelaunched = true;
        },
        getTscCompiling: () => true,
        getTscErrors: () => false,
        getTscSettledPromise: () => {
          compilerStarted = true;
          return new Promise<boolean>((resolve) => {
            resumeCompiler = resolve;
          });
        },
        debounceMs: 20,
      });

      const schedulePromise = dispatcher.scheduleRelaunch('src/main/index.ts');

      while (!compilerStarted) {
        await new Promise((r) => setTimeout(r, 5));
      }

      // Dispose while awaiting compiler settlement
      dispatcher.dispose();

      // Complete compiler successfully
      if (typeof resumeCompiler === 'function') {
        (resumeCompiler as (v: boolean) => void)(true);
      }
      await assert.rejects(schedulePromise, /disposed/i);
      assert.strictEqual(staticCopied, false, 'Should NEVER copy static assets after disposal');
      assert.strictEqual(electronRelaunched, false, 'Should NEVER relaunch electron after disposal');
    });

    it('times out safely when tsc watch compiler hangs and skips relaunch', async () => {
      let loggedMessage = '';
      let electronRelaunched = false;

      const dispatcher = createChangeDispatcher({
        isHotSwappableFn: () => false,
        relaunchElectronFn: async () => {
          electronRelaunched = true;
        },
        getTscCompiling: () => true,
        getTscErrors: () => false,
        getTscSettledPromise: () => new Promise<boolean>(() => {}), // hangs forever
        debounceMs: 10,
        tscTimeoutMs: 30, // 30ms timeout
        log: (msg) => {
          loggedMessage = msg;
        },
      });

      const result = await dispatcher.scheduleRelaunch('src/main/foo.ts');
      assert.deepStrictEqual(result, { action: 'skip_compiler_error', success: false });
      assert.strictEqual(electronRelaunched, false, 'Should skip relaunch on timeout');
      assert.match(loggedMessage, /timed out/i);
    });
  });
});

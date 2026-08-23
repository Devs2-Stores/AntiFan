import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  TerminalWriteDispatcher,
  sliceUtf8Bytes,
  getUtf8ByteLength,
  MAX_FRAME_WRITE_BYTES,
  type TerminalWritable,
} from '../../src/shared/terminal-write-dispatcher';

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

    // Create a 150KB payload consisting of mixed Unicode text
    const pattern = 'Line [TEST] - Chào mừng đến với AntiFan Browser 🚀\n';
    let largePayload = '';
    while (getUtf8ByteLength(largePayload) < 150 * 1024) {
      largePayload += pattern;
    }
    const totalExpectedBytes = getUtf8ByteLength(largePayload);

    // Queue the 150KB payload
    dispatcher.queueWrite(target, largePayload);

    // Slice 1: Must be sent immediately (queue >= 64KB) but capped to <= 64KB
    assert.strictEqual(writtenSlices.length, 1);
    assert.ok(getUtf8ByteLength(writtenSlices[0]!) <= MAX_FRAME_WRITE_BYTES);
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

    // Slice 2: Sent to xterm, capped to <= 64KB
    assert.strictEqual(writtenSlices.length, 2);
    assert.ok(getUtf8ByteLength(writtenSlices[1]!) <= MAX_FRAME_WRITE_BYTES);

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

var exports = exports || {};
var module = { exports: exports };
"use strict";
/**
 * AntiFan Terminal High-Throughput Write Dispatcher
 *
 * Implements:
 * 1. Interactive Fast-Path: 0ms latency for small interactive keystrokes (<= 256 bytes) when idle.
 * 2. In-Flight Backpressure Guard: Guarantees strict FIFO ordering with zero interleaving during async xterm parser ticks.
 * 3. Bounded 64KB UTF-8 Dequeue & Frame Yielding: Caches up to 64KB UTF-8 bytes per frame, safely splitting large or multibyte Unicode strings without splitting code points or surrogate pairs.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.globalTerminalWriteDispatcher = exports.TerminalWriteDispatcher = exports.MAX_FRAME_WRITE_BYTES = void 0;
exports.getUtf8ByteLength = getUtf8ByteLength;
exports.sliceUtf8Bytes = sliceUtf8Bytes;
exports.MAX_FRAME_WRITE_BYTES = 65536; // 64KB per frame render budget
/**
 * Accurately measures the UTF-8 byte length of a string by iterating code points.
 */
function getUtf8ByteLength(str) {
    if (!str)
        return 0;
    let bytes = 0;
    const len = str.length;
    for (let i = 0; i < len; i++) {
        const code = str.charCodeAt(i);
        if (code <= 0x7f) {
            bytes += 1;
        }
        else if (code <= 0x7ff) {
            bytes += 2;
        }
        else if (code >= 0xd800 && code <= 0xdbff) {
            if (i + 1 < len) {
                const next = str.charCodeAt(i + 1);
                if (next >= 0xdc00 && next <= 0xdfff) {
                    bytes += 4;
                    i++;
                    continue;
                }
            }
            bytes += 3;
        }
        else {
            bytes += 3;
        }
    }
    return bytes;
}
/**
 * Safely slices a string so its UTF-8 encoded byte length does not exceed maxBytes.
 * Iterates full Unicode code points, strictly guaranteeing that:
 * 1. No multibyte code points, surrogate pairs, or emoji sequences are split in half.
 * 2. head + tail === str exactly (zero data loss, no U+FFFD corruption).
 * 3. bytes <= maxBytes.
 */
function sliceUtf8Bytes(str, maxBytes) {
    if (!str || maxBytes <= 0) {
        return { head: '', tail: str || '', bytes: 0 };
    }
    let accumulatedBytes = 0;
    let charCount = 0;
    const len = str.length;
    for (let i = 0; i < len; i++) {
        const code = str.charCodeAt(i);
        let charBytes = 1;
        let codeUnits = 1;
        if (code <= 0x7f) {
            charBytes = 1;
            codeUnits = 1;
        }
        else if (code <= 0x7ff) {
            charBytes = 2;
            codeUnits = 1;
        }
        else if (code >= 0xd800 && code <= 0xdbff) {
            if (i + 1 < len) {
                const next = str.charCodeAt(i + 1);
                if (next >= 0xdc00 && next <= 0xdfff) {
                    charBytes = 4;
                    codeUnits = 2;
                }
                else {
                    charBytes = 3;
                    codeUnits = 1;
                }
            }
            else {
                charBytes = 3;
                codeUnits = 1;
            }
        }
        else {
            charBytes = 3;
            codeUnits = 1;
        }
        if (accumulatedBytes + charBytes > maxBytes) {
            break;
        }
        accumulatedBytes += charBytes;
        charCount += codeUnits;
        if (codeUnits === 2) {
            i++;
        }
    }
    const head = str.slice(0, charCount);
    const tail = str.slice(charCount);
    return { head, tail, bytes: accumulatedBytes };
}
class TerminalWriteDispatcher {
    requestFrame;
    cancelFrame;
    maxFrameBytes;
    constructor(options) {
        this.maxFrameBytes = options?.maxFrameBytes ?? exports.MAX_FRAME_WRITE_BYTES;
        if (options?.requestFrame) {
            this.requestFrame = options.requestFrame;
        }
        else if (typeof requestAnimationFrame === 'function') {
            this.requestFrame = (cb) => {
                let fired = false;
                let timeoutId = null;
                const rafId = requestAnimationFrame(() => {
                    if (!fired) {
                        fired = true;
                        if (timeoutId)
                            clearTimeout(timeoutId);
                        cb();
                    }
                });
                timeoutId = setTimeout(() => {
                    if (!fired) {
                        fired = true;
                        try {
                            cancelAnimationFrame(rafId);
                        }
                        catch { }
                        cb();
                    }
                }, 16);
                return rafId;
            };
        }
        else {
            this.requestFrame = (cb) => setTimeout(cb, 16);
        }
        if (options?.cancelFrame) {
            this.cancelFrame = options.cancelFrame;
        }
        else if (typeof cancelAnimationFrame === 'function') {
            this.cancelFrame = (id) => {
                try {
                    cancelAnimationFrame(id);
                }
                catch { }
            };
        }
        else {
            this.cancelFrame = (id) => clearTimeout(id);
        }
    }
    createTarget(term, onPostWrite) {
        return {
            term,
            writeQueue: [],
            queueByteLength: 0,
            isWriting: false,
            writeRafId: null,
            onPostWrite,
            writeQueueBytes: [],
        };
    }
    queueWrite(target, chunk) {
        if (!target || !chunk)
            return;
        const chunkBytes = getUtf8ByteLength(chunk);
        target.writeQueue.push(chunk);
        if (!target.writeQueueBytes) {
            target.writeQueueBytes = [];
        }
        target.writeQueueBytes.push(chunkBytes);
        target.queueByteLength += chunkBytes;
        // If a write is currently in-flight in xterm, let the in-flight callback drain the queue to maintain strict FIFO
        if (target.isWriting) {
            return;
        }
        // Fast-path: single small interactive keystroke/chunk (<= 256 bytes) and no pending RAF -> flush immediately (0ms latency)
        if (target.writeQueue.length === 1 && target.queueByteLength <= 256 && target.writeRafId === null) {
            this.flushWrite(target);
            return;
        }
        // If accumulated data exceeds frame budget (>= 64KB) and no RAF is running, flush bounded slice immediately
        if (target.queueByteLength >= this.maxFrameBytes && target.writeRafId === null) {
            this.flushWrite(target);
            return;
        }
        // Schedule RAF batching
        if (target.writeRafId === null) {
            target.writeRafId = this.requestFrame(() => {
                this.flushWrite(target);
            });
        }
    }
    flushWrite(target) {
        if (target.writeRafId !== null) {
            this.cancelFrame(target.writeRafId);
            target.writeRafId = null;
        }
        if (target.writeQueue.length === 0 || target.isWriting) {
            return;
        }
        // Bounded UTF-8 dequeue: extract at most maxFrameBytes across queue items, splitting if necessary
        let payload = '';
        let accumulatedBytes = 0;
        while (target.writeQueue.length > 0 && accumulatedBytes < this.maxFrameBytes) {
            const head = target.writeQueue[0];
            const headBytes = (target.writeQueueBytes && target.writeQueueBytes.length > 0)
                ? target.writeQueueBytes[0]
                : getUtf8ByteLength(head);
            const budget = this.maxFrameBytes - accumulatedBytes;
            if (headBytes <= budget) {
                payload += head;
                accumulatedBytes += headBytes;
                target.writeQueue.shift();
                if (target.writeQueueBytes) {
                    target.writeQueueBytes.shift();
                }
            }
            else {
                const { head: sliceHead, tail: sliceTail, bytes: sliceBytes } = sliceUtf8Bytes(head, budget);
                payload += sliceHead;
                accumulatedBytes += sliceBytes;
                target.writeQueue[0] = sliceTail;
                if (target.writeQueueBytes) {
                    target.writeQueueBytes[0] = Math.max(0, headBytes - sliceBytes);
                }
                break;
            }
        }
        target.queueByteLength = Math.max(0, target.queueByteLength - accumulatedBytes);
        target.isWriting = true;
        let writeCallbackSettled = false;
        const onComplete = () => {
            if (writeCallbackSettled)
                return;
            writeCallbackSettled = true;
            target.isWriting = false;
            try {
                target.onPostWrite?.();
            }
            catch { }
            // If more data remains in queue, schedule next frame slice to keep UI responsive
            if (target.writeQueue.length > 0 && target.writeRafId === null) {
                target.writeRafId = this.requestFrame(() => {
                    this.flushWrite(target);
                });
            }
        };
        try {
            target.term.write(payload, onComplete);
        }
        catch {
            onComplete();
        }
    }
    cancel(target) {
        if (target.writeRafId !== null) {
            this.cancelFrame(target.writeRafId);
            target.writeRafId = null;
        }
        target.writeQueue = [];
        target.writeQueueBytes = [];
        target.queueByteLength = 0;
        target.isWriting = false;
    }
}
exports.TerminalWriteDispatcher = TerminalWriteDispatcher;
exports.globalTerminalWriteDispatcher = new TerminalWriteDispatcher();
//# sourceMappingURL=terminal-write-dispatcher.js.map
window.TerminalWriteDispatcher = exports.TerminalWriteDispatcher;
window.globalTerminalWriteDispatcher = exports.globalTerminalWriteDispatcher;

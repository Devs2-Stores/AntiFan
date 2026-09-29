/**
 * Per-session output coalescing for the Terminal Host daemon.
 *
 * A PTY under load emits thousands of small chunks per second; framing each one as its own
 * WebSocket message makes the GUI main thread pay JSON parse + dispatch per chunk. Chunks for one
 * session are joined into a single payload carrying the contiguous `{fromSeq, throughSeq}` range
 * (`seq` aliases `throughSeq`), the envelope `TerminalDataPayload` and the renderer already accept.
 *
 * Latency rules:
 * - A chunk for a session that emitted nothing during the last `flushMs` goes out immediately, so a
 *   keystroke echo never waits on the timer. The rule is time-based rather than size-based on
 *   purpose: a size bypass lets every small chunk of a small-chunk stream (the common PTY shape)
 *   skip the batch, which is no batching at all, while this rule still caps a session at roughly
 *   one frame per `flushMs` and never adds more than `flushMs` of latency.
 * - Otherwise the chunk joins the session's batch, emitted after `flushMs` or as soon as it holds
 *   `maxChars` UTF-16 code units (the unit xterm and the renderer write budget count in).
 * - A generation change emits the previous generation's batch first; a batch never spans two.
 */
import type { TerminalDataPayload } from '../../shared/contracts';

export interface OutputBatcherOptions {
  flushMs?: number;
  maxChars?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface PendingBatch {
  parts: string[];
  chars: number;
  fromSeq: number;
  throughSeq: number;
  generation?: number;
}

export const DAEMON_OUTPUT_FLUSH_MS = 8;
export const DAEMON_OUTPUT_MAX_CHARS = 64 * 1024;

/**
 * Chunks arriving inside `flushMs` of the last emit coalesce into one frame; anything
 * past the window emits immediately so echo never waits. A ~16 ms winpty cadence is
 * therefore a stream of single-chunk frames — that is the intended latency contract,
 * not a lost optimization.
 */

export class OutputBatcher {
  private readonly pending = new Map<string, PendingBatch>();
  private readonly lastEmitAt = new Map<string, number>();
  private timer: unknown = null;
  private readonly flushMs: number;
  private readonly maxChars: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly emit: (payload: TerminalDataPayload) => void, options: OutputBatcherOptions = {}) {
    this.flushMs = options.flushMs ?? DAEMON_OUTPUT_FLUSH_MS;
    this.maxChars = options.maxChars ?? DAEMON_OUTPUT_MAX_CHARS;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /** Accepts a single chunk or an already-coalesced range; either way the range stays contiguous. */
  push(payload: TerminalDataPayload): void {
    const { sessionId } = payload;
    const throughSeq = payload.throughSeq ?? payload.seq;
    const fromSeq = payload.fromSeq ?? payload.seq;
    const now = this.now();

    // Coalescing applies only to chunks arriving inside one flush window; the fast
    // path below already emits anything past flushMs immediately (a ~16 ms winpty
    // cadence is a stream of single-chunk frames — correct, not a bug).

    let batch = this.pending.get(sessionId);
    if (batch && batch.generation !== payload.generation) {
      this.flushSession(sessionId);
      batch = undefined;
    }
    if (!batch) {
      const last = this.lastEmitAt.get(sessionId);
      if (last === undefined || now - last >= this.flushMs) {
        this.send({ ...payload, seq: throughSeq, fromSeq, throughSeq });
        return;
      }
      batch = { parts: [], chars: 0, fromSeq, throughSeq, generation: payload.generation };
      this.pending.set(sessionId, batch);
    }
    batch.parts.push(payload.data);
    batch.chars += payload.data.length;
    batch.throughSeq = throughSeq;
    if (batch.chars >= this.maxChars) {
      this.flushSession(sessionId);
      return;
    }
    if (this.timer === null) {
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.flushAll();
      }, this.flushMs);
    }
  }

  /** Emits one session's pending batch, if any. Call before any event that must follow its output. */
  flushSession(sessionId: string): void {
    const batch = this.pending.get(sessionId);
    if (!batch) return;
    this.pending.delete(sessionId);
    this.send({
      sessionId,
      data: batch.parts.join(''),
      seq: batch.throughSeq,
      fromSeq: batch.fromSeq,
      throughSeq: batch.throughSeq,
      generation: batch.generation,
    });
    if (this.pending.size === 0 && this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  flushAll(): void {
    for (const sessionId of [...this.pending.keys()]) this.flushSession(sessionId);
  }

  /** Flushes, then drops idle bookkeeping for a session that no longer exists. */
  forget(sessionId: string): void {
    this.flushSession(sessionId);
    this.lastEmitAt.delete(sessionId);
  }

  private send(payload: TerminalDataPayload): void {
    this.lastEmitAt.set(payload.sessionId, this.now());
    this.emit(payload);
  }
}

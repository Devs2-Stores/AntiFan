/**
 * node-pty (1.1.0, Windows) relays ConPTY output through its own worker thread
 * (`lib/worker/conoutSocketWorker.js`): the thread pipes the console's output pipe into a local
 * socket that the agent's `_outSocket` reads. The thread puts no 'error' listener on its end of
 * that pipe, so once the reader is gone (teardown destroys `_outSocket`; a shell exit runs
 * `_cleanUpProcess`) a chunk still in flight fails with EPIPE, kills the relay thread, and
 * re-surfaces as an 'error' event on the parent's `Worker`. node-pty has no listener there either,
 * so the parent thread throws it as an uncaught exception: a test process or the terminal daemon
 * dies, and inside the pty worker thread every shell it hosts is lost with it.
 *
 * Measured: 25 create/sleep/wake/close cycles hit it 1-9 times (more under CPU load), each one
 * uncaught; with this listener in place the same EPIPE fires on the Worker and nothing escapes.
 */
type RelayWorker = { on?: (event: 'error', listener: (err: unknown) => void) => unknown };
type ConoutRelayOwner = { _agent?: { _conoutSocketWorker?: { _worker?: RelayWorker } } };

/** Pipe errors are the relay's normal end once its reader is gone; anything else is worth a line. */
const RELAY_SHUTDOWN_CODES = new Set(['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED']);

export function absorbConoutRelayErrors(child: unknown): void {
  const worker = (child as ConoutRelayOwner | null)?._agent?._conoutSocketWorker?._worker;
  if (!worker || typeof worker.on !== 'function') return;
  worker.on('error', (err) => {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && RELAY_SHUTDOWN_CODES.has(code)) return;
    console.warn('[antifan:terminal] node-pty output relay failed:', err);
  });
}

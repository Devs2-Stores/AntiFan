/**
 * Main-thread side of the PTY worker (see `pty-worker.ts`): one worker per process, and a `WorkerPty`
 * proxy per shell that exposes the slice of `pty.IPty` TerminalManager drives.
 *
 * The proxy is returned synchronously; the shell starts on the worker. Until the worker reports
 * `spawned`, `pid` is 0 - writes, resizes and a kill posted in that window are ordered after the
 * spawn by the message port, so none of them is lost or reordered.
 */
import { Worker } from 'node:worker_threads';
import type * as pty from 'node-pty';
import type { PtyWorkerEvent, PtyWorkerRequest } from './pty-worker';

// Static specifier so the daemon host stager copies the worker beside this module.
const WORKER_SCRIPT = require.resolve('./pty-worker');

/** Three worker deaths inside this window stop the host from respawning it; spawns go inline. */
const CRASH_WINDOW_MS = 30_000;
const CRASH_LIMIT = 3;
/**
 * The worker kills its shells synchronously, ~125 ms each under ConPTY, so the wait for `drained`
 * scales with the count. node-pty then finishes each kill asynchronously (a console-list agent
 * with its own 5 s timeout, the conout worker); `terminate()` while that is in flight takes the
 * whole host process down (exit 9, measured with 25 shells). The worker closes its port after
 * `drained` and exits on its own; `terminate()` is only the fallback for a wedged thread.
 */
const SHUTDOWN_DRAIN_BASE_MS = 1_500;
const SHUTDOWN_DRAIN_PER_SHELL_MS = 500;
// node-pty's console-list agent gives up after 5 s; measured exit 4.9 s after `drained` (25 shells).
const SHUTDOWN_EXIT_MS = 8_000;

type Listener<T> = (value: T) => void;
type ExitEvent = { exitCode: number; signal?: number };

export interface WorkerPtySpawnOptions {
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  useConpty: boolean;
  fallbackCwd: string;
  /** ConPTY refused and the worker fell back to winpty for this spawn. */
  onConptyFailed?: (message: string) => void;
}

export class WorkerPty implements pty.IPty {
  public pid = 0;
  public cols: number;
  public rows: number;
  public readonly process: string;
  public handleFlowControl = false;
  private readonly dataListeners = new Set<Listener<string>>();
  private readonly exitListeners = new Set<Listener<ExitEvent>>();
  private exited = false;

  constructor(
    private readonly host: PtyWorkerHost,
    public readonly token: number,
    file: string,
    cols: number,
    rows: number,
  ) {
    this.process = file;
    this.cols = cols;
    this.rows = rows;
  }

  public readonly onData: pty.IEvent<string> = (listener) => {
    this.dataListeners.add(listener);
    return { dispose: () => { this.dataListeners.delete(listener); } };
  };

  public readonly onExit: pty.IEvent<ExitEvent> = (listener) => {
    this.exitListeners.add(listener);
    return { dispose: () => { this.exitListeners.delete(listener); } };
  };

  public write(data: string | Buffer): void {
    if (this.exited) return;
    this.host.post({ op: 'write', token: this.token, data: typeof data === 'string' ? data : data.toString('utf8') });
  }

  public resize(columns: number, rows: number): void {
    if (this.exited) return;
    this.cols = columns;
    this.rows = rows;
    this.host.post({ op: 'resize', token: this.token, cols: columns, rows });
  }

  public clear(): void {}

  public kill(): void {
    if (this.exited) return;
    this.host.post({ op: 'kill', token: this.token });
  }

  public pause(): void {
    if (!this.exited) this.host.post({ op: 'pause', token: this.token });
  }

  public resume(): void {
    if (!this.exited) this.host.post({ op: 'resume', token: this.token });
  }

  /** @internal worker event delivery */
  public deliverData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  /** @internal worker event delivery; idempotent so a worker death never double-reports */
  public deliverExit(event: ExitEvent): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener(event);
    this.dataListeners.clear();
    this.exitListeners.clear();
  }
}

export class PtyWorkerHost {
  private worker: Worker | null = null;
  private nextToken = 1;
  private readonly live = new Map<number, WorkerPty>();
  private readonly pendingConptyCallbacks = new Map<number, (message: string) => void>();
  private crashTimes: number[] = [];
  private disposed = false;
  private drainWaiter: (() => void) | null = null;

  constructor(private readonly log: (message: string) => void = (m) => console.warn(m)) {}

  /**
   * Starts a shell on the worker. `null` means the worker is unavailable (disposed, or it crashed
   * repeatedly) and the caller must spawn inline instead.
   */
  public spawn(file: string, options: WorkerPtySpawnOptions): WorkerPty | null {
    if (this.disposed || this.circuitOpen()) return null;
    const worker = this.ensureWorker();
    if (!worker) return null;
    const token = this.nextToken++;
    const proxy = new WorkerPty(this, token, file, options.cols, options.rows);
    this.live.set(token, proxy);
    if (options.onConptyFailed) this.pendingConptyCallbacks.set(token, options.onConptyFailed);
    this.post({
      op: 'spawn',
      token,
      file,
      options: { cols: options.cols, rows: options.rows, cwd: options.cwd, env: options.env },
      useConpty: options.useConpty,
      fallbackCwd: options.fallbackCwd,
    });
    return proxy;
  }

  /** @internal */
  public post(request: PtyWorkerRequest): void {
    this.worker?.postMessage(request);
  }

  /**
   * Kills every shell the worker still owns, waits for it to confirm and exit, then lets it go.
   * `terminate()` alone would skip node-pty's teardown and leave consoles behind.
   */
  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const worker = this.worker;
    if (!worker) return;
    const exited = new Promise<boolean>((resolve) => worker.once('exit', () => resolve(true)));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SHUTDOWN_DRAIN_BASE_MS + SHUTDOWN_DRAIN_PER_SHELL_MS * this.live.size);
      timer.unref?.();
      this.drainWaiter = () => { clearTimeout(timer); resolve(); };
      worker.postMessage({ op: 'shutdown' } satisfies PtyWorkerRequest);
    });
    this.drainWaiter = null;
    this.failLive();
    this.worker = null;
    let exitTimer: NodeJS.Timeout | undefined;
    const exitedInTime = await Promise.race([
      exited,
      new Promise<boolean>((resolve) => { exitTimer = setTimeout(() => resolve(false), SHUTDOWN_EXIT_MS); exitTimer.unref?.(); }),
    ]);
    clearTimeout(exitTimer);
    if (!exitedInTime) {
      this.log('[pty-worker] did not exit after shutdown; terminating');
      await worker.terminate().catch(() => 0);
    }
  }

  private circuitOpen(): boolean {
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS);
    return this.crashTimes.length >= CRASH_LIMIT;
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SCRIPT);
    } catch (err) {
      this.log(`[pty-worker] failed to start: ${err instanceof Error ? err.message : String(err)}`);
      this.crashTimes.push(Date.now());
      return null;
    }
    worker.on('message', (event: PtyWorkerEvent) => this.onEvent(event));
    worker.on('error', (err) => this.log(`[pty-worker] error: ${err && err.stack ? err.stack : String(err)}`));
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (this.disposed) return;
      this.crashTimes.push(Date.now());
      this.log(`[pty-worker] exited unexpectedly code=${code}; ${this.live.size} shell(s) lost`);
      this.failLive();
    });
    // The host process must still be able to exit on its own once every shell is gone.
    worker.unref();
    this.worker = worker;
    return worker;
  }

  /** Every shell the worker owned is gone with it: report each as exited exactly once. */
  private failLive(): void {
    const lost = [...this.live.values()];
    this.live.clear();
    this.pendingConptyCallbacks.clear();
    for (const proxy of lost) proxy.deliverExit({ exitCode: -1 });
  }

  private onEvent(event: PtyWorkerEvent): void {
    if (event.type === 'drained') {
      this.drainWaiter?.();
      return;
    }
    const proxy = this.live.get(event.token);
    if (!proxy) return;
    switch (event.type) {
      case 'spawned': {
        proxy.pid = event.pid;
        const onConptyFailed = this.pendingConptyCallbacks.get(event.token);
        this.pendingConptyCallbacks.delete(event.token);
        if (event.conptyFailed && onConptyFailed) onConptyFailed(event.conptyError || 'ConPTY spawn failed');
        return;
      }
      case 'spawnError':
        this.live.delete(event.token);
        this.pendingConptyCallbacks.delete(event.token);
        proxy.deliverData(`\r\n[Terminal failed to start: ${event.message}]\r\n`);
        proxy.deliverExit({ exitCode: -1 });
        return;
      case 'data':
        proxy.deliverData(event.data);
        return;
      case 'exit':
        this.live.delete(event.token);
        proxy.deliverExit({ exitCode: event.exitCode, ...(event.signal !== undefined ? { signal: event.signal } : {}) });
        return;
    }
  }
}

import * as childProcess from 'node:child_process';
import * as readline from 'node:readline';
import { BackendSessionRef, RunState } from '../../shared/control-plane-contracts';
import { ExecutionBackend, RunEvent, StartRunInput } from './execution-backend';

export interface CodexExecutionBackendOptions {
  executable?: string;
  spawn?: typeof childProcess.spawn;
  env?: NodeJS.ProcessEnv;
  defaultTimeoutMs?: number;
}

export class CodexExecutionBackend implements ExecutionBackend {
  readonly id = 'codex';
  private readonly processes = new Map<string, childProcess.ChildProcess>();
  private readonly executable: string;
  private readonly spawn: typeof childProcess.spawn;
  private readonly env: NodeJS.ProcessEnv;
  private readonly defaultTimeoutMs: number;

  constructor(options: CodexExecutionBackendOptions = {}) {
    this.executable = options.executable || 'codex';
    this.spawn = options.spawn || childProcess.spawn;
    this.env = options.env || { ...process.env };
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
  }

  async *startRun(input: StartRunInput): AsyncIterable<RunEvent> {
    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    const args = ['exec', '--json', input.promptText];
    const runId = input.runId;
    const attemptId = input.attemptId;
    const child = this.spawn(this.executable, args, { cwd: input.cwd, env: this.env, windowsHide: true, shell: false });
    this.processes.set(runId, child);
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.killOwned(child);
    }, timeoutMs);
    if (input.signal) input.signal.addEventListener('abort', () => this.killOwned(child), { once: true });
    yield { type: 'status', runId, attemptId, state: 'starting' };

    const sessionRef: BackendSessionRef = { backendId: this.id, opaqueRef: `${runId}:${attemptId}`, createdAt: Date.now() };
    yield { type: 'session/ref', runId, attemptId, sessionRef };

    const lines = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(line) as Record<string, unknown>; } catch { yield { type: 'error', runId, attemptId, errorCode: 'MALFORMED_CODEX_JSON', errorMessage: 'Codex emitted malformed JSON' }; continue; }
      const mapped = mapCodexEvent(event, runId, attemptId);
      if (mapped) yield mapped;
    }
    const stderr = await readStream(child.stderr);
    const exitCode = await waitForExit(child);
    clearTimeout(timer);
    this.processes.delete(runId);
    if (timedOut) yield { type: 'status', runId, attemptId, state: 'unknown', errorCode: 'CODEX_TIMEOUT', errorMessage: `Codex exceeded ${timeoutMs}ms deadline` };
    else if (exitCode === 0) yield { type: 'status', runId, attemptId, state: 'completed' };
    else yield { type: 'status', runId, attemptId, state: 'failed', errorCode: 'CODEX_EXIT', errorMessage: limit(stderr || `Codex exited with code ${exitCode}`, 8192) };
    settled = true;
    void settled;
  }

  async cancel(runId: string): Promise<void> {
    const child = this.processes.get(runId);
    if (child) this.killOwned(child);
  }

  private killOwned(child: childProcess.ChildProcess): void {
    if (!child.pid || child.killed) return;
    if (process.platform === 'win32') {
      try { childProcess.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { child.kill(); }
    } else child.kill('SIGTERM');
  }
}

function mapCodexEvent(event: Record<string, unknown>, runId: string, attemptId: string): RunEvent | null {
  const type = typeof event.type === 'string' ? event.type : '';
  if (type === 'thread.started' || type === 'session.started') return { type: 'status', runId, attemptId, state: 'streaming' };
  if (type === 'item.completed' || type === 'message' || type === 'assistant.message') {
    const text = typeof event.text === 'string' ? event.text : typeof event.content === 'string' ? event.content : '';
    return text ? { type: 'text', runId, attemptId, text, stream: 'stdout' } : null;
  }
  if (type === 'tool.call') return { type: 'tool/call', runId, attemptId, toolName: typeof event.name === 'string' ? event.name : 'unknown', args: (event.arguments && typeof event.arguments === 'object' ? event.arguments : {}) as Record<string, unknown> };
  if (type === 'tool.result') return { type: 'tool/result', runId, attemptId, toolName: typeof event.name === 'string' ? event.name : 'unknown', result: event.result };
  return null;
}

function waitForExit(child: childProcess.ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('close', (code) => resolve(code));
  });
}

function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => { let value = ''; stream.on('data', (chunk) => { value += chunk.toString(); }); stream.on('end', () => resolve(value)); stream.on('error', () => resolve(value)); });
}

function limit(value: string, max: number): string { return value.length > max ? `${value.slice(0, max)}...[truncated]` : value; }

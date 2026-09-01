import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import {
  BackendSessionRef,
  CapabilityError,
  RunState,
  validateLaunchPath,
} from '../../shared/control-plane-contracts';
import { ExecutionBackend, RunEvent, StartRunInput } from './execution-backend';

export interface CodexExecutionBackendOptions {
  executable?: string;
  approvedExecutables?: string[];
  spawn?: typeof childProcess.spawn;
  env?: NodeJS.ProcessEnv;
  defaultTimeoutMs?: number;
}

export function resolveApprovedExecutable(candidate?: string, approvedExecutables?: string[]): string {
  if (!approvedExecutables || approvedExecutables.length === 0) {
    throw new CapabilityError('LAUNCH_ERROR', 'No approved executable installation records configured');
  }
  if (!candidate || typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw new CapabilityError('LAUNCH_ERROR', 'Executable path is required and must be an approved absolute path');
  }
  if (!path.isAbsolute(candidate)) {
    throw new CapabilityError('LAUNCH_ERROR', `Bare commands and relative executable paths are not permitted: ${candidate}`);
  }
  const resolved = path.resolve(candidate);
  let realCandidate: string;
  try {
    realCandidate = fs.realpathSync.native(resolved);
  } catch {
    throw new CapabilityError('LAUNCH_ERROR', `Executable does not exist or cannot be resolved: ${candidate}`);
  }
  const stat = fs.statSync(realCandidate);
  if (!stat.isFile()) {
    throw new CapabilityError('LAUNCH_ERROR', `Executable path is not a file: ${candidate}`);
  }
  const isWin = process.platform === 'win32' || /^[A-Za-z]:[\\/]/.test(realCandidate);
  const normCandidate = isWin ? realCandidate.toLowerCase() : realCandidate;

  const isApproved = approvedExecutables.some((approved) => {
    try {
      const realApproved = fs.realpathSync.native(path.resolve(approved));
      const normApproved = isWin ? realApproved.toLowerCase() : realApproved;
      return normApproved === normCandidate;
    } catch {
      return false;
    }
  });

  if (!isApproved) {
    throw new CapabilityError('LAUNCH_ERROR', `Executable is not in the approved installation record: ${candidate}`);
  }
  return realCandidate;
}

export class CodexExecutionBackend implements ExecutionBackend {
  readonly id = 'codex';
  private readonly processes = new Map<string, childProcess.ChildProcess>();
  private readonly executable: string;
  private readonly spawn: typeof childProcess.spawn;
  private readonly env: NodeJS.ProcessEnv;
  private readonly defaultTimeoutMs: number;

  constructor(options: CodexExecutionBackendOptions = {}) {
    this.executable = resolveApprovedExecutable(options.executable, options.approvedExecutables);
    this.spawn = options.spawn || childProcess.spawn;
    this.env = options.env || { ...process.env };
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
  }
  async *startRun(input: StartRunInput): AsyncIterable<RunEvent> {
    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    const args = ['exec', '--json', input.promptText];
    const runId = input.runId;
    const attemptId = input.attemptId;
    const { canonicalLaunchCwd } = validateLaunchPath(input.canonicalWorkspaceRoot || input.cwd, input.cwd);
    const childEnv: NodeJS.ProcessEnv = { ...this.env };
    if (input.attachmentLaunch) {
      childEnv.ANTIFAN_ATTACHMENT_SECRET = input.attachmentLaunch.secret;
      childEnv.ANTIFAN_ATTACHMENT_ID = input.attachmentLaunch.attachmentId;
      childEnv.ANTIFAN_AUTHORITY_REVISION = input.attachmentLaunch.authorityRevision;
      childEnv.ANTIFAN_RUN_ID = input.runId;
      childEnv.ANTIFAN_ATTEMPT_ID = input.attemptId;
    }
    const child = this.spawn(this.executable, args, { cwd: canonicalLaunchCwd, env: childEnv, windowsHide: true, shell: false });
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.killOwned(child);
    }, timeoutMs);
    if (input.signal) input.signal.addEventListener('abort', () => this.killOwned(child), { once: true });
    yield { type: 'status', runId, attemptId, state: 'starting' };

    const sessionRef: BackendSessionRef = { backendId: this.id, opaqueRef: `${runId}:${attemptId}`, processPid: child.pid, createdAt: Date.now() };
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

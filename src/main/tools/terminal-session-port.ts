import * as childProcess from 'node:child_process';
import { CapabilityError } from '../../shared/control-plane-contracts';

export interface TerminalCommandResult { commandId: string; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; }

export class TerminalSessionPort {
  private readonly children = new Map<string, childProcess.ChildProcess>();
  constructor(private readonly maxOutputBytes = 256 * 1024) {}

  async run(owner: { projectId: string; workspaceId: string; runId: string; attemptId: string }, root: string, command: string, args: string[] = [], timeoutMs = 30_000): Promise<TerminalCommandResult> {
    if (!command || command.includes('..')) throw new CapabilityError('INVALID_ARGUMENT', 'Command executable is invalid');
    const commandId = `terminal-${owner.runId}-${Date.now()}`;
    const env = scrubEnvironment();
    const child = childProcess.spawn(command, args, { cwd: root, env, shell: false, windowsHide: true });
    this.children.set(commandId, child);
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const append = (target: 'stdout' | 'stderr', value: Buffer): void => {
      const current = target === 'stdout' ? stdout : stderr;
      const next = current + value.toString('utf8');
      if (Buffer.byteLength(next) > this.maxOutputBytes) { truncated = true; const bounded = next.slice(0, this.maxOutputBytes); if (target === 'stdout') stdout = bounded; else stderr = bounded; } else if (target === 'stdout') stdout = next; else stderr = next;
    };
    child.stdout?.on('data', (value: Buffer) => append('stdout', value));
    child.stderr?.on('data', (value: Buffer) => append('stderr', value));
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; this.kill(commandId); }, timeoutMs);
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    clearTimeout(timeout);
    this.children.delete(commandId);
    return { commandId, exitCode, stdout, stderr, timedOut, truncated };
  }

  kill(commandId: string): void {
    const child = this.children.get(commandId);
    if (!child?.pid) return;
    if (process.platform === 'win32') { try { childProcess.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { child.kill(); } } else child.kill('SIGTERM');
  }

  async drain(): Promise<void> { for (const id of this.children.keys()) this.kill(id); }
}

function scrubEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|COOKIE|AUTH/i.test(key)) delete env[key];
  return { ...env, TERM: 'dumb', NO_COLOR: '1' };
}

/**
 * AntiFan Browser Desktop — Embedded Terminal Manager
 * Interactive PowerShell / Command Shell for running `hrv theme dev`, scripts, and CLI tools.
 */

import * as cp from 'child_process';
import { EventEmitter } from 'events';

export class TerminalManager extends EventEmitter {
  private static instance: TerminalManager;
  private ptyProcess: cp.ChildProcessWithoutNullStreams | null = null;
  private isRunning = false;
  private currentCwd: string = process.cwd();

  private constructor() {
    super();
  }

  public static getInstance(): TerminalManager {
    if (!TerminalManager.instance) {
      TerminalManager.instance = new TerminalManager();
    }
    return TerminalManager.instance;
  }

  public setCwd(cwd: string): void {
    this.currentCwd = cwd;
  }

  public startTerminal(cwd?: string): boolean {
    if (this.isRunning && this.ptyProcess) {
      return true;
    }

    if (cwd) {
      this.currentCwd = cwd;
    }

    try {
      const isWin = process.platform === 'win32';
      const shellCmd = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
      const shellArgs: string[] = [];

      this.ptyProcess = cp.spawn(shellCmd, shellArgs, {
        cwd: this.currentCwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          FORCE_COLOR: '1',
        },
      });

      this.isRunning = true;

      this.ptyProcess.stdout.on('data', (data: Buffer) => {
        this.emit('data', data.toString('utf8'));
      });

      this.ptyProcess.stderr.on('data', (data: Buffer) => {
        this.emit('data', data.toString('utf8'));
      });

      this.ptyProcess.on('exit', (code: number) => {
        this.isRunning = false;
        this.ptyProcess = null;
        this.emit('data', `\r\n[Process exited with code ${code}]\r\n`);
        this.emit('exit', code);
      });

      this.ptyProcess.on('error', (err: Error) => {
        this.emit('data', `\r\n[Terminal Error: ${err.message}]\r\n`);
      });

      return true;
    } catch (err: any) {
      this.emit('data', `\r\n[Failed to spawn terminal: ${err.message}]\r\n`);
      return false;
    }
  }

  public write(input: string): void {
    if (!this.isRunning || !this.ptyProcess) {
      this.startTerminal();
    }
    try {
      this.ptyProcess?.stdin.write(input);
    } catch (err: any) {
      this.emit('data', `\r\n[Write error: ${err.message}]\r\n`);
    }
  }

  public kill(): void {
    if (this.ptyProcess) {
      try {
        if (process.platform === 'win32' && this.ptyProcess.pid) {
          cp.execSync(`taskkill /pid ${this.ptyProcess.pid} /T /F`);
        } else {
          this.ptyProcess.kill('SIGTERM');
        }
      } catch {}
      this.ptyProcess = null;
      this.isRunning = false;
    }
  }

  public restart(cwd?: string): void {
    this.kill();
    this.startTerminal(cwd || this.currentCwd);
  }
}

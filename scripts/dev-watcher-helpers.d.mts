export interface TscLineState {
  isTscCompiling: boolean;
  tscHasErrors: boolean;
  settled: boolean;
}

export interface ChangeDispatcherResult {
  action: 'soft_reload' | 'ui_reload' | 'relaunch' | 'skip_compiler_error' | 'noop';
  success: boolean;
}

export interface ChangeDispatcherOptions {
  isHotSwappableFn?: (relPath?: string | null) => boolean;
  isUiHotSwappableFn?: (relPath?: string | null) => boolean;
  sendSoftReloadFn?: () => Promise<boolean>;
  sendUiReloadFn?: () => Promise<boolean>;
  copyStaticFn?: () => Promise<void> | void;
  relaunchElectronFn?: () => Promise<void> | void;
  getTscCompiling?: () => boolean;
  getTscErrors?: () => boolean;
  getTscSettledPromise?: () => Promise<boolean>;
  getElectronProc?: () => { pid: number } | null;
  debounceMs?: number;
  tscTimeoutMs?: number;
  log?: (msg: string) => void;
  isFileFn?: (relPath?: string | null) => boolean;
}

export interface ChangeDispatcher {
  scheduleRelaunch(filename?: string | null): Promise<ChangeDispatcherResult>;
  handleBatch(files: string[]): Promise<ChangeDispatcherResult>;
  cancel(reason?: string): void;
  dispose(): void;
  isDisposed(): boolean;
  getPendingFiles(): string[];
}

export function isHotSwappable(relPath?: string | null): boolean;
export function isUiHotSwappable(relPath?: string | null): boolean;
export function defaultIsFile(relPath?: string | null): boolean;
export function resolveElectronArgs(argv?: string[] | null): string[];
export function processTscLine(line: string, state?: { isTscCompiling: boolean; tscHasErrors: boolean }): TscLineState;
export function resolveDevBridgeInfo(customDirs?: string[] | null): { port: number; token: string } | null;
export function sendSoftReload(options?: {
  bridgeInfo?: { port: number; token: string } | null;
  scriptId?: string | null;
  wsFactory?: unknown;
  timeoutMs?: number;
}): Promise<boolean>;
export function sendUiReload(options?: {
  bridgeInfo?: { port: number; token: string } | null;
  wsFactory?: unknown;
  timeoutMs?: number;
}): Promise<boolean>;

export function createChangeDispatcher(options?: ChangeDispatcherOptions): ChangeDispatcher;

export function defaultIsProcAlive(pid: number): boolean;

export interface DevLockResult {
  ok: boolean;
  existingPid?: number;
  existingStartedAt?: number | null;
}

export function acquireDevLock(options: {
  lockPath: string;
  pid: number;
  isProcAlive?: (pid: number) => boolean;
}): DevLockResult;

export function releaseDevLock(lockPath: string, pid: number): void;

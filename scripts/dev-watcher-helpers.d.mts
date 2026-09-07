export interface TscLineState {
  isTscCompiling: boolean;
  tscHasErrors: boolean;
  settled: boolean;
}

export interface ChangeDispatcherResult {
  action: 'soft_reload' | 'relaunch' | 'skip_compiler_error' | 'cancelled';
  success: boolean;
  reason?: string;
}

export interface ChangeDispatcherOptions {
  isHotSwappableFn?: (relPath?: string | null) => boolean;
  sendSoftReloadFn?: () => Promise<boolean>;
  copyStaticFn?: () => void;
  relaunchElectronFn?: () => Promise<void> | void;
  getTscCompiling?: () => boolean;
  getTscErrors?: () => boolean;
  getTscSettledPromise?: () => Promise<boolean>;
  getElectronProc?: () => { pid: number } | null;
  debounceMs?: number;
  tscTimeoutMs?: number;
  log?: (msg: string) => void;
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
export function processTscLine(line: string, state?: { isTscCompiling: boolean; tscHasErrors: boolean }): TscLineState;
export function resolveDevBridgeInfo(customDirs?: string[] | null): { port: number; token: string } | null;
export function sendSoftReload(options?: {
  bridgeInfo?: { port: number; token: string } | null;
  scriptId?: string | null;
  wsFactory?: unknown;
  timeoutMs?: number;
}): Promise<boolean>;

export function createChangeDispatcher(options?: ChangeDispatcherOptions): ChangeDispatcher;

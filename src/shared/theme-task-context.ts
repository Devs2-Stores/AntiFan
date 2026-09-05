/**
 * AntiFan Core — Theme Task Context Contract
 *
 * Lineage Anchor:
 * Connects OMP reasoning intent with AntiFan observation, monotonic element refs (@e1..@eN),
 * and local theme workspace root.
 */

export interface ThemeTaskContext {
  taskId: string;
  url: string;
  targetRef?: string;
  workspaceRoot: string;
  timestamp: number;
}

export function isThemeTaskContext(value: unknown): value is ThemeTaskContext {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  const hasTaskId = typeof obj.taskId === 'string' && obj.taskId.trim().length > 0;
  const hasUrl = typeof obj.url === 'string' && obj.url.trim().length > 0;
  const hasWorkspaceRoot = typeof obj.workspaceRoot === 'string' && obj.workspaceRoot.trim().length > 0;
  const hasTimestamp = typeof obj.timestamp === 'number' && Number.isFinite(obj.timestamp) && obj.timestamp > 0;
  const validRef = obj.targetRef === undefined || (typeof obj.targetRef === 'string' && obj.targetRef.trim().length > 0);

  return hasTaskId && hasUrl && hasWorkspaceRoot && hasTimestamp && validRef;
}

export function assertValidThemeTaskContext(value: unknown): asserts value is ThemeTaskContext {
  if (!isThemeTaskContext(value)) {
    throw new Error(
      'Invalid ThemeTaskContext: must be an object with non-empty taskId, url, workspaceRoot, positive timestamp, and optional targetRef'
    );
  }
}

export type ThemePlatformDialect = 'haravan' | 'sapo' | 'shopify';

export interface ThemeWorkspaceContext {
  readonly storeId: string;
  readonly storeDomain: string;
  readonly themeId: string;
  readonly workspaceRoot: string;
  readonly targetTabId: string;
  readonly platform: ThemePlatformDialect;
  readonly adminOrigin?: string;
  readonly terminalSessionId?: string;
}

export function isThemeWorkspaceContext(value: unknown): value is ThemeWorkspaceContext {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  const hasStoreId = typeof obj.storeId === 'string' && obj.storeId.trim().length > 0;
  const hasStoreDomain = typeof obj.storeDomain === 'string' && obj.storeDomain.trim().length > 0;
  const hasThemeId = typeof obj.themeId === 'string' && obj.themeId.trim().length > 0;
  const hasWorkspaceRoot = typeof obj.workspaceRoot === 'string' && obj.workspaceRoot.trim().length > 0;
  const hasTargetTabId = typeof obj.targetTabId === 'string' && obj.targetTabId.trim().length > 0;
  const validPlatform = obj.platform === 'haravan' || obj.platform === 'sapo' || obj.platform === 'shopify';
  return hasStoreId && hasStoreDomain && hasThemeId && hasWorkspaceRoot && hasTargetTabId && validPlatform;
}

export function assertValidThemeWorkspaceContext(value: unknown): asserts value is ThemeWorkspaceContext {
  if (!isThemeWorkspaceContext(value)) {
    throw new Error(
      'Invalid ThemeWorkspaceContext: requires storeId, storeDomain, themeId, workspaceRoot, targetTabId, and platform ("haravan"|"sapo"|"shopify")'
    );
  }
}

export interface ThemeLineage {
  readonly workspaceGen: number;
  readonly syncGen: number;
  readonly documentGeneration: number;
  readonly browserEpoch: number;
}

export type VerificationPolicy = 'HARD_FAIL_ROLLBACK' | 'EXPLORATORY_HOLD' | 'PERMISSIVE';

export interface CasFileWrite {
  readonly relativePath: string;
  readonly content: string | Buffer;
  readonly expectedSha256?: string;
}

export interface CasFileResult {
  readonly path: string;
  readonly relativePath: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly previousSha256?: string;
  readonly workspaceGen: number;
}

export interface ThemeTransactionReceipt {
  readonly receiptId: string;
  readonly sessionId: string;
  readonly context: ThemeWorkspaceContext;
  readonly lineage: ThemeLineage;
  readonly verdict: 'VERIFIED' | 'REJECTED' | 'HELD';
  readonly policy: VerificationPolicy;
  readonly rolledBack: boolean;
  readonly details?: Record<string, unknown>;
  readonly timestamp: number;
}

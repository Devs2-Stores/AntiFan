/**
 * Haravan Platform Adapter (v1.0.0)
 * Derived from AntiFan - Deep Haravan Platform & Codebase Audit (§7 - §9, §47 - §50, §62)
 *
 * Implements PlatformAdapter contract for Haravan store and theme lifecycle orchestration:
 * - Store context discovery
 * - Theme and theme asset inspection
 * - Safe atomic transactions with fail-closed policy enforcement (allowedFiles, forbiddenFiles, diffBudget)
 * - In-memory rollback buffer with automatic and manual atomic revert
 * - CLI transport delegation for theme dev/preview/watch workflows (§9)
 */

import { spawn, ChildProcess } from 'node:child_process';
import {
  StoreContext,
  ThemeAsset,
  ThemeTransaction,
  ThemeTransactionPolicy,
} from './types.js';
import { CleanupAction } from './entity-resolver.js';

// ============================================================================
// Core Platform Adapter Interface (§7 - §8)
// ============================================================================

export interface PlatformAdapter {
  getStoreContext(): Promise<StoreContext>;
  listThemes(): Promise<Array<{ id: number | string; name: string; role: string }>>;
  getTheme(id: number | string): Promise<{ id: number | string; name: string; role: string }>;
  getThemeAssets(themeId: number | string): Promise<ThemeAsset[]>;
  getThemeAsset(themeId: number | string, key: string): Promise<ThemeAsset | null>;
  assertThemeIsMutable(themeId: number | string): Promise<{ id: number | string; name: string; role: string }>;
  beginTransaction(themeId: number | string, policy: ThemeTransactionPolicy): Promise<ThemeTransaction>;
  stageAssetMutation(
    transactionId: string,
    op: { type: 'create' | 'update' | 'delete'; key: string; value?: string }
  ): Promise<void>;
  commitTransaction(transactionId: string): Promise<void>;
  rollbackTransaction(transactionId: string): Promise<void>;
}

// ============================================================================
// Transport Contracts (§8 - §9)
// ============================================================================

export interface HaravanApiTransport {
  getStoreContext(): Promise<StoreContext>;
  listThemes(): Promise<Array<{ id: number | string; name: string; role: string }>>;
  getTheme(id: number | string): Promise<{ id: number | string; name: string; role: string }>;
  getThemeAssets(themeId: number | string): Promise<ThemeAsset[]>;
  getThemeAsset(themeId: number | string, key: string): Promise<ThemeAsset | null>;
  putThemeAsset(
    themeId: number | string,
    asset: { key: string; value?: string; attachment?: string }
  ): Promise<ThemeAsset>;
  deleteThemeAsset(themeId: number | string, key: string): Promise<{ key: string; deleted: boolean }>;

  // Data discovery endpoints
  getProducts?(params?: Record<string, unknown>): Promise<unknown[]>;
  getCollections?(params?: Record<string, unknown>): Promise<unknown[]>;
  getArticles?(params?: Record<string, unknown>): Promise<unknown[]>;
  getBlogs?(): Promise<unknown[]>;
  getPages?(params?: Record<string, unknown>): Promise<unknown[]>;
  getMenus?(): Promise<unknown[]>;
  getThemeSettings?(themeId: number | string): Promise<unknown>;

  // Canary deletion endpoints (Audit §43)
  deleteProduct?(id: number | string): Promise<{ id: number | string; deleted: boolean }>;
  deleteCollection?(id: number | string): Promise<{ id: number | string; deleted: boolean }>;
  deleteArticle?(id: number | string, blogId?: number | string): Promise<{ id: number | string; deleted: boolean }>;
  deletePage?(id: number | string): Promise<{ id: number | string; deleted: boolean }>;
}

export type { CleanupAction };

export type CleanupPlan = CleanupAction[];

export interface CleanupExecutionResult {
  executed: number;
  failed: number;
  errors: Array<{ targetId: string; error: string }>;
}

export interface ThemeCliPreviewOptions {
  port?: number;
  openBrowser?: boolean;
  themeId?: number | string;
  env?: string;
  dir?: string;
  timeoutMs?: number;
  waitForReady?: boolean;
}

export interface ThemeCliSyncOptions {
  dir?: string;
  themeId?: number | string;
  env?: string;
  files?: string[];
  force?: boolean;
  timeoutMs?: number;
}

export interface ThemeCliWatchOptions {
  dir?: string;
  themeId?: number | string;
  env?: string;
  notify?: boolean;
  timeoutMs?: number;
}
export interface ThemeCliProcessResult {
  command: string;
  args: string[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  url?: string;
  processId?: number;
  stop?: () => Promise<void>;
}

export interface HaravanCliTransport {
  preview(themeId: number | string, options?: ThemeCliPreviewOptions): Promise<ThemeCliProcessResult>;
  sync(themeId: number | string, options?: ThemeCliSyncOptions): Promise<ThemeCliProcessResult>;
  watch(themeId: number | string, options?: ThemeCliWatchOptions): Promise<ThemeCliProcessResult>;
  exec?(args: string[], options?: { cwd?: string; env?: Record<string, string> }): Promise<ThemeCliProcessResult>;
}

// ============================================================================
// Error Types
// ============================================================================

export class HaravanAdapterError extends Error {
  public override name = 'HaravanAdapterError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export class ThemeTransactionNotFoundError extends HaravanAdapterError {
  public override name = 'ThemeTransactionNotFoundError';
  constructor(public readonly transactionId: string) {
    super(`Theme transaction not found: "${transactionId}"`);
  }
}

export class ThemeTransactionStateError extends HaravanAdapterError {
  public override name = 'ThemeTransactionStateError';
  constructor(public readonly transactionId: string, public readonly status: string, message: string) {
    super(`Transaction "${transactionId}" in invalid state "${status}": ${message}`);
  }
}

export class ThemeTransactionPolicyError extends HaravanAdapterError {
  public override name = 'ThemeTransactionPolicyError';
  constructor(
    public readonly reason: 'FORBIDDEN_FILE' | 'NOT_ALLOWED_FILE' | 'DIFF_BUDGET_FILES' | 'DIFF_BUDGET_BYTES' | 'LIVE_THEME_MUTATION_FORBIDDEN',
    public readonly violatingKey: string,
    message: string
  ) {
    super(message);
  }
}

export class ThemeAssetNotFoundError extends HaravanAdapterError {
  public override name = 'ThemeAssetNotFoundError';
  constructor(public readonly themeId: number | string, public readonly key: string) {
    super(`Theme asset not found for theme ${themeId}: "${key}"`);
  }
}

// ============================================================================
// Pattern Matching Helper
// ============================================================================

export function matchGlobPattern(key: string, pattern: string): boolean {
  if (pattern === key) return true;
  if (pattern === '*' || pattern === '**') return true;
  if (pattern.endsWith('/') && key.startsWith(pattern)) return true;

  let regexStr = '';
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          regexStr += '(?:.+/)?';
          i += 3;
          continue;
        } else {
          regexStr += '.*';
          i += 2;
          continue;
        }
      } else {
        regexStr += '[^/]*';
        i += 1;
        continue;
      }
    } else if (char === '?') {
      regexStr += '[^/]';
      i += 1;
      continue;
    } else if (['.', '+', '^', '$', '(', ')', '[', ']', '{', '}', '|', '\\'].includes(char)) {
      regexStr += '\\' + char;
      i += 1;
      continue;
    } else {
      regexStr += char;
      i += 1;
      continue;
    }
  }

  const re = new RegExp(`^${regexStr}$`);
  return re.test(key);
}

// ============================================================================
// In-Memory Rollback Buffer & State Tracking
// ============================================================================

interface BaseAssetSnapshot {
  exists: boolean;
  value?: string;
  attachment?: string;
}

interface StagedOpRecord {
  type: 'create' | 'update' | 'delete';
  key: string;
  value?: string;
  previousValue?: string;
}
interface AppliedOperationRecord {
  key: string;
  previousExists: boolean;
  previousValue?: string;
  previousAttachment?: string;
}

interface InternalTransactionRecord {
  id: string;
  themeId: number | string;
  policy: ThemeTransactionPolicy;
  operations: StagedOpRecord[];
  status: 'pending' | 'committed' | 'rolled_back';
  createdAt: string;
  committedAt?: string;
  baseSnapshots: Map<string, BaseAssetSnapshot>;
}

// ============================================================================
// Haravan Adapter Implementation
// ============================================================================

export class HaravanAdapter implements PlatformAdapter {
  private apiTransport: HaravanApiTransport;
  private cliTransport?: HaravanCliTransport;
  private transactions: Map<string, InternalTransactionRecord> = new Map();
  private txCounter = 0;

  constructor(options: { apiTransport?: HaravanApiTransport; cliTransport?: HaravanCliTransport } = {}) {
    this.apiTransport = options.apiTransport ?? new InMemoryHaravanApiTransport();
    this.cliTransport = options.cliTransport;
  }

  public getApiTransport(): HaravanApiTransport {
    return this.apiTransport;
  }

  public getCliTransport(): HaravanCliTransport | undefined {
    return this.cliTransport;
  }

  // --------------------------------------------------------------------------
  // PlatformAdapter: Store Context & Theme Discovery (§8)
  // --------------------------------------------------------------------------

  public async getStoreContext(): Promise<StoreContext> {
    return this.apiTransport.getStoreContext();
  }

  public async listThemes(): Promise<Array<{ id: number | string; name: string; role: string }>> {
    return this.apiTransport.listThemes();
  }

  public async getTheme(id: number | string): Promise<{ id: number | string; name: string; role: string }> {
    return this.apiTransport.getTheme(id);
  }

  public async getThemeAssets(themeId: number | string): Promise<ThemeAsset[]> {
    return this.apiTransport.getThemeAssets(themeId);
  }

  public async getThemeAsset(themeId: number | string, key: string): Promise<ThemeAsset | null> {
    return this.apiTransport.getThemeAsset(themeId, key);
  }

  // --------------------------------------------------------------------------
  // PlatformAdapter: Atomic Theme Transactions (§8)
  // --------------------------------------------------------------------------

  public async assertThemeIsMutable(
    themeId: number | string
  ): Promise<{ id: number | string; name: string; role: string }> {
    const targetTheme = await this.getTheme(themeId);
    if (!targetTheme) {
      throw new HaravanAdapterError(`Theme with ID ${themeId} not found.`);
    }
    const role = String(targetTheme.role || '').toLowerCase().trim();
    if (role === 'main') {
      throw new ThemeTransactionPolicyError(
        'LIVE_THEME_MUTATION_FORBIDDEN',
        String(themeId),
        `Direct mutations on live production theme ${themeId} (role: 'main') are strictly forbidden (Audit §33, §64).`
      );
    }
    return targetTheme;
  }

  public async beginTransaction(
    themeId: number | string,
    policy: ThemeTransactionPolicy
  ): Promise<ThemeTransaction> {
    await this.assertThemeIsMutable(themeId);

    this.txCounter += 1;
    const transactionId = `tx_${Date.now()}_${this.txCounter}_${Math.random().toString(36).slice(2, 8)}`;

    const txRecord: InternalTransactionRecord = {
      id: transactionId,
      themeId,
      policy: {
        allowedFiles: policy.allowedFiles ? [...policy.allowedFiles] : undefined,
        forbiddenFiles: policy.forbiddenFiles ? [...policy.forbiddenFiles] : undefined,
        diffBudget: policy.diffBudget ? { ...policy.diffBudget } : undefined,
      },
      operations: [],
      status: 'pending',
      createdAt: new Date().toISOString(),
      baseSnapshots: new Map(),
    };

    this.transactions.set(transactionId, txRecord);
    return this.toPublicTransaction(txRecord);
  }

  public async stageAssetMutation(
    transactionId: string,
    op: { type: 'create' | 'update' | 'delete'; key: string; value?: string }
  ): Promise<void> {
    const tx = this.transactions.get(transactionId);
    if (!tx) {
      throw new ThemeTransactionNotFoundError(transactionId);
    }
    if (tx.status !== 'pending') {
      throw new ThemeTransactionStateError(
        transactionId,
        tx.status,
        'Cannot stage mutations on a transaction that is not pending.'
      );
    }
    if (!op.key || typeof op.key !== 'string' || op.key.trim() === '') {
      throw new HaravanAdapterError(`Invalid asset mutation key: "${op.key}"`);
    }

    const key = op.key.trim();
    const policy = tx.policy;

    // 1. Fail-closed check: forbiddenFiles
    if (policy.forbiddenFiles && policy.forbiddenFiles.length > 0) {
      for (const pattern of policy.forbiddenFiles) {
        if (matchGlobPattern(key, pattern)) {
          throw new ThemeTransactionPolicyError(
            'FORBIDDEN_FILE',
            key,
            `Asset mutation rejected: "${key}" matches forbidden pattern "${pattern}".`
          );
        }
      }
    }

    // 2. Fail-closed check: allowedFiles
    if (policy.allowedFiles !== undefined) {
      let isAllowed = false;
      for (const pattern of policy.allowedFiles) {
        if (matchGlobPattern(key, pattern)) {
          isAllowed = true;
          break;
        }
      }
      if (!isAllowed) {
        throw new ThemeTransactionPolicyError(
          'NOT_ALLOWED_FILE',
          key,
          `Asset mutation rejected: "${key}" is not permitted by allowedFiles policy.`
        );
      }
    }

    // 3. Load baseline value if not already captured in rollback buffer
    if (!tx.baseSnapshots.has(key)) {
      const existingAsset = await this.getThemeAsset(tx.themeId, key);
      tx.baseSnapshots.set(key, {
        exists: existingAsset !== null,
        value: existingAsset?.value,
        attachment: existingAsset?.attachment,
      });
    }
    const baseSnapshot = tx.baseSnapshots.get(key)!;

    // 4. Diff Budget: maxFilesChanged check
    const currentKeys = new Set(tx.operations.map((o) => o.key));
    currentKeys.add(key);

    if (
      policy.diffBudget?.maxFilesChanged !== undefined &&
      currentKeys.size > policy.diffBudget.maxFilesChanged
    ) {
      throw new ThemeTransactionPolicyError(
        'DIFF_BUDGET_FILES',
        key,
        `Asset mutation rejected: diffBudget.maxFilesChanged exceeded (budget=${policy.diffBudget.maxFilesChanged}, attempted=${currentKeys.size}).`
      );
    }

    // 5. Diff Budget: maxBytesDelta check
    if (policy.diffBudget?.maxBytesDelta !== undefined) {
      // Simulate cumulative bytes delta across all proposed operations
      const proposedMap = new Map<string, { type: 'create' | 'update' | 'delete'; value?: string }>();
      for (const priorOp of tx.operations) {
        proposedMap.set(priorOp.key, { type: priorOp.type, value: priorOp.value });
      }
      proposedMap.set(key, { type: op.type, value: op.value });

      let totalBytesDelta = 0;
      for (const [fileKey, proposed] of proposedMap.entries()) {
        const base = tx.baseSnapshots.get(fileKey) ?? { exists: false, value: undefined };
        const baseBytes = base.value ? Buffer.byteLength(base.value, 'utf8') : 0;
        const proposedBytes =
          proposed.type === 'delete' ? 0 : proposed.value ? Buffer.byteLength(proposed.value, 'utf8') : 0;
        totalBytesDelta += Math.abs(proposedBytes - baseBytes);
      }

      if (totalBytesDelta > policy.diffBudget.maxBytesDelta) {
        throw new ThemeTransactionPolicyError(
          'DIFF_BUDGET_BYTES',
          key,
          `Asset mutation rejected: diffBudget.maxBytesDelta exceeded (budget=${policy.diffBudget.maxBytesDelta} bytes, calculated=${totalBytesDelta} bytes).`
        );
      }
    }

    // Capture previous value: if previously modified in this transaction, use that; else use baseline
    const previousOp = [...tx.operations].reverse().find((o) => o.key === key);
    const previousValue = previousOp ? previousOp.value : baseSnapshot.value;

    tx.operations.push({
      type: op.type,
      key,
      value: op.value,
      previousValue,
    });
  }

  public async commitTransaction(transactionId: string): Promise<void> {
    const tx = this.transactions.get(transactionId);
    if (!tx) {
      throw new ThemeTransactionNotFoundError(transactionId);
    }
    if (tx.status !== 'pending') {
      throw new ThemeTransactionStateError(
        transactionId,
        tx.status,
        'Only pending transactions can be committed.'
      );
    }

    const appliedOps: AppliedOperationRecord[] = [];

    try {
      for (const op of tx.operations) {
        const base = tx.baseSnapshots.get(op.key) ?? { exists: false, value: undefined };
        appliedOps.push({
          key: op.key,
          previousExists: base.exists,
          previousValue: base.value,
          previousAttachment: base.attachment,
        });

        if (op.type === 'create' || op.type === 'update') {
          await this.apiTransport.putThemeAsset(tx.themeId, {
            key: op.key,
            value: op.value,
          });
        } else if (op.type === 'delete') {
          await this.apiTransport.deleteThemeAsset(tx.themeId, op.key);
        }
      }
      tx.status = 'committed';
      tx.committedAt = new Date().toISOString();
    } catch (commitError) {
      // Atomic rollback of partially applied operations
      for (const applied of appliedOps.reverse()) {
        try {
          if (applied.previousExists && (applied.previousValue !== undefined || applied.previousAttachment !== undefined)) {
            await this.apiTransport.putThemeAsset(tx.themeId, {
              key: applied.key,
              value: applied.previousValue,
              attachment: applied.previousAttachment,
            });
          } else {
            await this.apiTransport.deleteThemeAsset(tx.themeId, applied.key);
          }
        } catch {
          // Swallow secondary revert errors to surface original failure
        }
      }

      tx.status = 'rolled_back';
      throw new HaravanAdapterError(
        `Failed to commit transaction "${transactionId}". Staged operations were atomically rolled back.`,
        { cause: commitError }
      );
    }
  }

  public async rollbackTransaction(transactionId: string): Promise<void> {
    const tx = this.transactions.get(transactionId);
    if (!tx) {
      throw new ThemeTransactionNotFoundError(transactionId);
    }

    if (tx.status === 'rolled_back') {
      return;
    }

    if (tx.status === 'pending') {
      // Simply discard staged operations
      tx.status = 'rolled_back';
      return;
    }

    if (tx.status === 'committed') {
      // Revert committed changes in reverse order using the base rollback snapshots
      const distinctKeys = Array.from(new Set(tx.operations.map((o) => o.key))).reverse();

      let revertFailure: unknown = null;
      for (const key of distinctKeys) {
        const base = tx.baseSnapshots.get(key);
        if (!base) continue;

        try {
          if (base.exists && (base.value !== undefined || base.attachment !== undefined)) {
            await this.apiTransport.putThemeAsset(tx.themeId, {
              key,
              value: base.value,
              attachment: base.attachment,
            });
          } else {
            await this.apiTransport.deleteThemeAsset(tx.themeId, key);
          }
        } catch (err) {
          revertFailure = err;
        }
      }
      tx.status = 'rolled_back';
      if (revertFailure) {
        throw new HaravanAdapterError(
          `Rollback partially succeeded for transaction "${transactionId}", but encountered errors during asset reversion.`,
          { cause: revertFailure }
        );
      }
    }
  }

  public getTransaction(transactionId: string): ThemeTransaction | null {
    const tx = this.transactions.get(transactionId);
    return tx ? this.toPublicTransaction(tx) : null;
  }

  private toPublicTransaction(record: InternalTransactionRecord): ThemeTransaction {
    return {
      id: record.id,
      themeId: record.themeId,
      policy: {
        allowedFiles: record.policy.allowedFiles ? [...record.policy.allowedFiles] : undefined,
        forbiddenFiles: record.policy.forbiddenFiles ? [...record.policy.forbiddenFiles] : undefined,
        diffBudget: record.policy.diffBudget ? { ...record.policy.diffBudget } : undefined,
      },
      operations: record.operations.map((o) => ({
        type: o.type,
        key: o.key,
        value: o.value,
        previousValue: o.previousValue,
      })),
      status: record.status,
      createdAt: record.createdAt,
      committedAt: record.committedAt,
    };
  }

  // --------------------------------------------------------------------------
  // Data Discovery Delegates (§47 - §48, §62)
  // --------------------------------------------------------------------------

  public async getProducts(params?: Record<string, unknown>): Promise<unknown[]> {
    if (this.apiTransport.getProducts) {
      return this.apiTransport.getProducts(params);
    }
    return [];
  }

  public async getCollections(params?: Record<string, unknown>): Promise<unknown[]> {
    if (this.apiTransport.getCollections) {
      return this.apiTransport.getCollections(params);
    }
    return [];
  }

  public async getArticles(params?: Record<string, unknown>): Promise<unknown[]> {
    if (this.apiTransport.getArticles) {
      return this.apiTransport.getArticles(params);
    }
    return [];
  }

  public async getBlogs(): Promise<unknown[]> {
    if (this.apiTransport.getBlogs) {
      return this.apiTransport.getBlogs();
    }
    return [];
  }

  public async getPages(params?: Record<string, unknown>): Promise<unknown[]> {
    if (this.apiTransport.getPages) {
      return this.apiTransport.getPages(params);
    }
    return [];
  }

  public async getMenus(): Promise<unknown[]> {
    if (this.apiTransport.getMenus) {
      return this.apiTransport.getMenus();
    }
    return [];
  }

  public async getThemeSettings(themeId: number | string): Promise<unknown> {
    if (this.apiTransport.getThemeSettings) {
      return this.apiTransport.getThemeSettings(themeId);
    }
    const settingsAsset = await this.getThemeAsset(themeId, 'config/settings_data.json');
    if (settingsAsset && settingsAsset.value) {
      try {
        return JSON.parse(settingsAsset.value);
      } catch {
        return null;
      }
    }
    return null;
  }

  // --------------------------------------------------------------------------
  // Canary Fixture Cleanup Execution (Audit §43)
  // --------------------------------------------------------------------------

  public async executeCleanupPlan(
    plan: CleanupPlan | { generateCleanupPlan?: () => CleanupAction[]; actions?: CleanupAction[] }
  ): Promise<CleanupExecutionResult> {
    let actions: CleanupAction[] = [];
    if (Array.isArray(plan)) {
      actions = plan;
    } else if (plan && typeof plan === 'object') {
      if ('generateCleanupPlan' in plan && typeof plan.generateCleanupPlan === 'function') {
        actions = plan.generateCleanupPlan();
      } else if ('actions' in plan && Array.isArray(plan.actions)) {
        actions = plan.actions;
      }
    }
    let executed = 0;
    let failed = 0;
    const errors: Array<{ targetId: string; error: string }> = [];

    for (const step of actions) {
      if (step.action !== 'delete') {
        continue;
      }
      const targetId = String(step.id);
      const entityType = String(step.type || '').toLowerCase();

      try {
        let deleted = false;
        switch (entityType) {
          case 'product':
            if (this.apiTransport.deleteProduct) {
              const res = await this.apiTransport.deleteProduct(step.id);
              deleted = res.deleted !== false;
            } else {
              throw new Error(`API transport does not support deleteProduct for ${targetId}`);
            }
            break;
          case 'collection':
            if (this.apiTransport.deleteCollection) {
              const res = await this.apiTransport.deleteCollection(step.id);
              deleted = res.deleted !== false;
            } else {
              throw new Error(`API transport does not support deleteCollection for ${targetId}`);
            }
            break;
          case 'article':
            if (this.apiTransport.deleteArticle) {
              const res = await this.apiTransport.deleteArticle(step.id);
              deleted = res.deleted !== false;
            } else {
              throw new Error(`API transport does not support deleteArticle for ${targetId}`);
            }
            break;
          case 'page':
            if (this.apiTransport.deletePage) {
              const res = await this.apiTransport.deletePage(step.id);
              deleted = res.deleted !== false;
            } else {
              throw new Error(`API transport does not support deletePage for ${targetId}`);
            }
            break;
          default:
            throw new Error(`Unsupported entity type for cleanup deletion: ${step.type}`);
        }

        if (deleted) {
          executed++;
        } else {
          failed++;
          errors.push({
            targetId,
            error: `Failed to delete ${step.type} fixture ${targetId}: deletion returned false`,
          });
        }
      } catch (err: unknown) {
        failed++;
        errors.push({
          targetId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { executed, failed, errors };
  }

  public async deleteProduct(id: number | string): Promise<{ id: number | string; deleted: boolean }> {
    if (this.apiTransport.deleteProduct) {
      return this.apiTransport.deleteProduct(id);
    }
    throw new HaravanAdapterError('API transport does not implement deleteProduct');
  }

  public async deleteCollection(id: number | string): Promise<{ id: number | string; deleted: boolean }> {
    if (this.apiTransport.deleteCollection) {
      return this.apiTransport.deleteCollection(id);
    }
    throw new HaravanAdapterError('API transport does not implement deleteCollection');
  }

  public async deleteArticle(id: number | string, blogId?: number | string): Promise<{ id: number | string; deleted: boolean }> {
    if (this.apiTransport.deleteArticle) {
      return this.apiTransport.deleteArticle(id, blogId);
    }
    throw new HaravanAdapterError('API transport does not implement deleteArticle');
  }

  public async deletePage(id: number | string): Promise<{ id: number | string; deleted: boolean }> {
    if (this.apiTransport.deletePage) {
      return this.apiTransport.deletePage(id);
    }
    throw new HaravanAdapterError('API transport does not implement deletePage');
  }

  // --------------------------------------------------------------------------
  // CLI Transport Delegation (§9)
  // --------------------------------------------------------------------------

  public async previewTheme(
    themeId: number | string,
    options?: ThemeCliPreviewOptions
  ): Promise<ThemeCliProcessResult> {
    const cli = this.cliTransport ?? new HaravanCliProcessTransport();
    return cli.preview(themeId, options);
  }

  public async syncTheme(
    themeId: number | string,
    options?: ThemeCliSyncOptions
  ): Promise<ThemeCliProcessResult> {
    const cli = this.cliTransport ?? new HaravanCliProcessTransport();
    return cli.sync(themeId, options);
  }

  public async watchTheme(
    themeId: number | string,
    options?: ThemeCliWatchOptions
  ): Promise<ThemeCliProcessResult> {
    const cli = this.cliTransport ?? new HaravanCliProcessTransport();
    return cli.watch(themeId, options);
  }
}

// ============================================================================
// Concrete In-Memory Haravan API Transport (Zero-mock full fidelity)
// ============================================================================

export interface InMemoryHaravanSeedData {
  storeContext?: Partial<StoreContext>;
  themes?: Array<{ id: number | string; name: string; role: string }>;
  assets?: Record<string | number, Record<string, ThemeAsset>>;
  products?: unknown[];
  collections?: unknown[];
  articles?: unknown[];
  blogs?: unknown[];
  pages?: unknown[];
  menus?: unknown[];
  settings?: Record<string | number, unknown>;
}

export class InMemoryHaravanApiTransport implements HaravanApiTransport {
  private storeContext: StoreContext;
  private themes: Map<string, { id: number | string; name: string; role: string }> = new Map();
  private assets: Map<string, Map<string, ThemeAsset>> = new Map();
  private products: unknown[] = [];
  private collections: unknown[] = [];
  private articles: unknown[] = [];
  private blogs: unknown[] = [];
  private pages: unknown[] = [];
  private menus: unknown[] = [];
  private settings: Map<string, unknown> = new Map();

  constructor(seed?: InMemoryHaravanSeedData) {
    this.storeContext = {
      store: seed?.storeContext?.store ?? 'haravan-demo-store',
      domain: seed?.storeContext?.domain ?? 'haravan-demo-store.myharavan.com',
      organization: seed?.storeContext?.organization ?? 'Haravan Demo Corp',
      theme: seed?.storeContext?.theme ?? 'Main Theme',
      themeId: seed?.storeContext?.themeId ?? 1001,
      environment: seed?.storeContext?.environment ?? 'development',
      adminOrigin: seed?.storeContext?.adminOrigin ?? 'https://admin.myharavan.com',
    };

    if (seed?.themes && seed.themes.length > 0) {
      for (const t of seed.themes) {
        this.themes.set(String(t.id), { ...t });
      }
    } else {
      this.themes.set('1001', { id: 1001, name: 'Main Theme', role: 'main' });
      this.themes.set('1002', { id: 1002, name: 'Staging Theme', role: 'unpublished' });
    }

    if (seed?.assets) {
      for (const [tId, assetMap] of Object.entries(seed.assets)) {
        const themeAssetMap = new Map<string, ThemeAsset>();
        for (const [key, asset] of Object.entries(assetMap)) {
          themeAssetMap.set(key, { ...asset });
        }
        this.assets.set(String(tId), themeAssetMap);
      }
    }

    this.products = seed?.products ? [...seed.products] : [];
    this.collections = seed?.collections ? [...seed.collections] : [];
    this.articles = seed?.articles ? [...seed.articles] : [];
    this.blogs = seed?.blogs ? [...seed.blogs] : [];
    this.pages = seed?.pages ? [...seed.pages] : [];
    this.menus = seed?.menus ? [...seed.menus] : [];

    if (seed?.settings) {
      for (const [tId, s] of Object.entries(seed.settings)) {
        this.settings.set(String(tId), s);
      }
    }
  }

  public async getStoreContext(): Promise<StoreContext> {
    return { ...this.storeContext };
  }

  public async listThemes(): Promise<Array<{ id: number | string; name: string; role: string }>> {
    return Array.from(this.themes.values()).map((t) => ({ ...t }));
  }

  public async getTheme(id: number | string): Promise<{ id: number | string; name: string; role: string }> {
    const theme = this.themes.get(String(id));
    if (!theme) {
      throw new HaravanAdapterError(`Theme with ID ${id} not found.`);
    }
    return { ...theme };
  }

  public async getThemeAssets(themeId: number | string): Promise<ThemeAsset[]> {
    const themeAssetMap = this.assets.get(String(themeId));
    if (!themeAssetMap) {
      return [];
    }
    return Array.from(themeAssetMap.values()).map((a) => ({ ...a }));
  }

  public async getThemeAsset(themeId: number | string, key: string): Promise<ThemeAsset | null> {
    const themeAssetMap = this.assets.get(String(themeId));
    if (!themeAssetMap) {
      return null;
    }
    const asset = themeAssetMap.get(key);
    return asset ? { ...asset } : null;
  }

  public async putThemeAsset(
    themeId: number | string,
    asset: { key: string; value?: string; attachment?: string }
  ): Promise<ThemeAsset> {
    let themeAssetMap = this.assets.get(String(themeId));
    if (!themeAssetMap) {
      themeAssetMap = new Map();
      this.assets.set(String(themeId), themeAssetMap);
    }

    const savedAsset: ThemeAsset = {
      key: asset.key,
      value: asset.value,
      attachment: asset.attachment,
      size: asset.value ? Buffer.byteLength(asset.value, 'utf8') : 0,
      updatedAt: new Date().toISOString(),
    };
    themeAssetMap.set(asset.key, savedAsset);
    return { ...savedAsset };
  }

  public async deleteThemeAsset(
    themeId: number | string,
    key: string
  ): Promise<{ key: string; deleted: boolean }> {
    const themeAssetMap = this.assets.get(String(themeId));
    if (!themeAssetMap) {
      return { key, deleted: false };
    }
    const deleted = themeAssetMap.delete(key);
    return { key, deleted };
  }

  public async getProducts(params?: Record<string, unknown>): Promise<unknown[]> {
    if (params?.limit && typeof params.limit === 'number') {
      return this.products.slice(0, params.limit);
    }
    return [...this.products];
  }

  public async getCollections(params?: Record<string, unknown>): Promise<unknown[]> {
    if (params?.limit && typeof params.limit === 'number') {
      return this.collections.slice(0, params.limit);
    }
    return [...this.collections];
  }

  public async getArticles(): Promise<unknown[]> {
    return [...this.articles];
  }

  public async getBlogs(): Promise<unknown[]> {
    return [...this.blogs];
  }

  public async getPages(): Promise<unknown[]> {
    return [...this.pages];
  }

  public async getMenus(): Promise<unknown[]> {
    return [...this.menus];
  }

  public async getThemeSettings(themeId: number | string): Promise<unknown> {
    const s = this.settings.get(String(themeId));
    if (s !== undefined) return s;
    const asset = await this.getThemeAsset(themeId, 'config/settings_data.json');
    if (asset?.value) {
      try {
        return JSON.parse(asset.value);
      } catch {
        return null;
      }
    }
    return null;
  }

  public async deleteProduct(id: number | string): Promise<{ id: number | string; deleted: boolean }> {
    const prevLen = this.products.length;
    this.products = this.products.filter((p) => {
      if (p && typeof p === 'object' && 'id' in p) {
        return String((p as { id: unknown }).id) !== String(id);
      }
      return true;
    });
    return { id, deleted: this.products.length < prevLen };
  }

  public async deleteCollection(id: number | string): Promise<{ id: number | string; deleted: boolean }> {
    const prevLen = this.collections.length;
    this.collections = this.collections.filter((c) => {
      if (c && typeof c === 'object' && 'id' in c) {
        return String((c as { id: unknown }).id) !== String(id);
      }
      return true;
    });
    return { id, deleted: this.collections.length < prevLen };
  }

  public async deleteArticle(id: number | string, _blogId?: number | string): Promise<{ id: number | string; deleted: boolean }> {
    const prevLen = this.articles.length;
    this.articles = this.articles.filter((a) => {
      if (a && typeof a === 'object' && 'id' in a) {
        return String((a as { id: unknown }).id) !== String(id);
      }
      return true;
    });
    return { id, deleted: this.articles.length < prevLen };
  }

  public async deletePage(id: number | string): Promise<{ id: number | string; deleted: boolean }> {
    const prevLen = this.pages.length;
    this.pages = this.pages.filter((p) => {
      if (p && typeof p === 'object' && 'id' in p) {
        return String((p as { id: unknown }).id) !== String(id);
      }
      return true;
    });
    return { id, deleted: this.pages.length < prevLen };
  }
}

// ============================================================================
// Concrete HTTP Haravan REST Admin API Transport (Audit §16)
// ============================================================================

export interface HttpHaravanApiTransportOptions {
  accessToken: string;
  shopDomain?: string;
  baseUrl?: string;
  authType?: 'header' | 'bearer';
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class HttpHaravanApiTransport implements HaravanApiTransport {
  private accessToken: string;
  private shopDomain: string;
  private baseUrl: string;
  private authType: 'header' | 'bearer';
  private maxRetries: number;
  private retryDelayMs: number;
  private timeoutMs: number;
  private fetchFn: typeof fetch;

  constructor(options: HttpHaravanApiTransportOptions) {
    if (!options?.accessToken) {
      throw new HaravanAdapterError('HttpHaravanApiTransport requires an accessToken.');
    }
    this.accessToken = options.accessToken;
    this.shopDomain = options.shopDomain ?? 'haravan-store.myharavan.com';
    this.baseUrl = (options.baseUrl ?? 'https://apis.haravan.com/web').replace(/\/+$/, '');
    this.authType = options.authType ?? (options.accessToken.startsWith('Bearer ') ? 'bearer' : 'header');
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  private async request<T = unknown>(
    path: string,
    init: RequestInit = {},
    retryCount = 0
  ): Promise<T> {
    const url = path.startsWith('http://') || path.startsWith('https://')
      ? path
      : `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;

    const headers = new Headers(init.headers);
    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json');
    }
    if (!headers.has('Content-Type') && init.body && typeof init.body === 'string') {
      headers.set('Content-Type', 'application/json');
    }

    const token = this.accessToken.trim();
    if (this.authType === 'bearer' || token.startsWith('Bearer ')) {
      const bearerValue = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
      headers.set('Authorization', bearerValue);
    } else {
      headers.set('X-Haravan-Access-Token', token);
    }

    const timeout = this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await this.fetchFn(url, {
        ...init,
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);

      // Handle Rate Limiting (429 Retry-After)
      if (response.status === 429) {
        if (retryCount < this.maxRetries) {
          const retryAfterHeader = response.headers.get('Retry-After');
          let delayMs = this.retryDelayMs * Math.pow(2, retryCount);
          if (retryAfterHeader) {
            const parsedSeconds = parseFloat(retryAfterHeader);
            if (!isNaN(parsedSeconds) && parsedSeconds > 0) {
              delayMs = Math.ceil(parsedSeconds * 1000);
            }
          }
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return this.request<T>(path, init, retryCount + 1);
        }
        throw new HaravanAdapterError(
          `Haravan API 429 Rate Limit exceeded for ${url} after ${retryCount} retries.`
        );
      }

      // Handle Server Errors (5xx) with retry
      if (response.status >= 500 && retryCount < this.maxRetries) {
        const delayMs = this.retryDelayMs * Math.pow(2, retryCount);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return this.request<T>(path, init, retryCount + 1);
      }

      if (!response.ok) {
        let errorBody = '';
        try {
          errorBody = await response.text();
        } catch {
          // ignore
        }
        const err = new HaravanAdapterError(
          `Haravan API request failed [${response.status} ${response.statusText}]: ${url} - ${errorBody}`
        );
        Object.assign(err, { status: response.status });
        throw err;
      }

      if (response.status === 204) {
        return {} as T;
      }

      const text = await response.text();
      if (!text || text.trim() === '') {
        return {} as T;
      }
      return JSON.parse(text) as T;
    } catch (err: unknown) {
      clearTimeout(timer);
      if (err instanceof HaravanAdapterError) {
        throw err;
      }
      if (err && typeof err === 'object' && 'name' in err && (err as { name: unknown }).name === 'AbortError') {
        throw new HaravanAdapterError(`Haravan API request timed out after ${timeout}ms: ${url}`);
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new HaravanAdapterError(`Haravan API network error: ${msg}`);
    }
  }

  public async getStoreContext(): Promise<StoreContext> {
    try {
      const data = await this.request<{ shop?: Record<string, unknown> }>('/admin/shop.json');
      const shop = data.shop ?? {};
      const name = typeof shop.name === 'string' ? shop.name : this.shopDomain;
      const domain = typeof shop.domain === 'string' ? shop.domain : this.shopDomain;
      const province = typeof shop.province === 'string' ? shop.province : undefined;
      return {
        store: name,
        domain,
        organization: province,
        theme: 'Main Theme',
        themeId: 0,
        environment: 'development',
        adminOrigin: `https://${domain}`,
      };
    } catch {
      return {
        store: this.shopDomain,
        domain: this.shopDomain,
        themeId: 0,
        environment: 'development',
        adminOrigin: `https://${this.shopDomain}`,
      };
    }
  }

  public async listThemes(): Promise<Array<{ id: number | string; name: string; role: string }>> {
    const data = await this.request<{ themes?: Array<{ id: number | string; name: string; role: string }> }>('/admin/themes.json');
    return data.themes ?? [];
  }

  public async getTheme(id: number | string): Promise<{ id: number | string; name: string; role: string }> {
    const data = await this.request<{ theme: { id: number | string; name: string; role: string } }>(`/admin/themes/${id}.json`);
    return data.theme;
  }

  public async getThemeAssets(themeId: number | string): Promise<ThemeAsset[]> {
    const data = await this.request<{ assets?: Array<Record<string, unknown>> }>(`/admin/themes/${themeId}/assets.json`);
    return (data.assets ?? []).map((a) => ({
      key: String(a.key ?? ''),
      size: typeof a.size === 'number' ? a.size : undefined,
      updatedAt: typeof a.updated_at === 'string' ? a.updated_at : undefined,
    }));
  }

  public async getThemeAsset(themeId: number | string, key: string): Promise<ThemeAsset | null> {
    try {
      const data = await this.request<{ asset?: Record<string, unknown> }>(
        `/admin/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(key)}`
      );
      if (!data.asset) return null;
      const a = data.asset;
      return {
        key: String(a.key ?? key),
        value: typeof a.value === 'string' ? a.value : undefined,
        attachment: typeof a.attachment === 'string' ? a.attachment : undefined,
        contentType: typeof a.content_type === 'string' ? a.content_type : undefined,
        size: typeof a.size === 'number' ? a.size : undefined,
        updatedAt: typeof a.updated_at === 'string' ? a.updated_at : undefined,
      };
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'status' in err && (err as { status: unknown }).status === 404) {
        return null;
      }
      if (err instanceof Error && err.message.includes('404')) {
        return null;
      }
      throw err;
    }
  }

  public async putThemeAsset(
    themeId: number | string,
    asset: { key: string; value?: string; attachment?: string }
  ): Promise<ThemeAsset> {
    const data = await this.request<{ asset: Record<string, unknown> }>(
      `/admin/themes/${themeId}/assets.json`,
      {
        method: 'PUT',
        body: JSON.stringify({ asset }),
      }
    );
    const a = data.asset;
    return {
      key: String(a.key ?? asset.key),
      value: typeof a.value === 'string' ? a.value : asset.value,
      attachment: typeof a.attachment === 'string' ? a.attachment : asset.attachment,
      contentType: typeof a.content_type === 'string' ? a.content_type : undefined,
      size: typeof a.size === 'number' ? a.size : undefined,
      updatedAt: typeof a.updated_at === 'string' ? a.updated_at : undefined,
    };
  }

  public async deleteThemeAsset(themeId: number | string, key: string): Promise<{ key: string; deleted: boolean }> {
    await this.request(
      `/admin/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(key)}`,
      { method: 'DELETE' }
    );
    return { key, deleted: true };
  }

  public async getProducts(params?: Record<string, unknown>): Promise<unknown[]> {
    const query = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
    const data = await this.request<{ products?: unknown[] }>(`/admin/products.json${query}`);
    return data.products ?? [];
  }

  public async getCollections(params?: Record<string, unknown>): Promise<unknown[]> {
    const query = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
    try {
      const data = await this.request<{ custom_collections?: unknown[]; collections?: unknown[] }>(
        `/admin/custom_collections.json${query}`
      );
      return data.collections ?? data.custom_collections ?? [];
    } catch {
      const data = await this.request<{ collections?: unknown[] }>(`/admin/collections.json${query}`);
      return data.collections ?? [];
    }
  }

  public async getArticles(params?: Record<string, unknown>): Promise<unknown[]> {
    const query = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
    const data = await this.request<{ articles?: unknown[] }>(`/admin/articles.json${query}`);
    return data.articles ?? [];
  }

  public async getBlogs(): Promise<unknown[]> {
    const data = await this.request<{ blogs?: unknown[] }>('/admin/blogs.json');
    return data.blogs ?? [];
  }

  public async getPages(params?: Record<string, unknown>): Promise<unknown[]> {
    const query = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
    const data = await this.request<{ pages?: unknown[] }>(`/admin/pages.json${query}`);
    return data.pages ?? [];
  }

  public async getMenus(): Promise<unknown[]> {
    try {
      const data = await this.request<{ link_lists?: unknown[]; menus?: unknown[] }>('/admin/link_lists.json');
      return data.menus ?? data.link_lists ?? [];
    } catch {
      const data = await this.request<{ menus?: unknown[] }>('/admin/menus.json');
      return data.menus ?? [];
    }
  }

  public async getThemeSettings(themeId: number | string): Promise<unknown> {
    const asset = await this.getThemeAsset(themeId, 'config/settings_data.json');
    if (asset?.value) {
      try {
        return JSON.parse(asset.value);
      } catch {
        return null;
      }
    }
    return null;
  }

  public async deleteProduct(id: number | string): Promise<{ id: number | string; deleted: boolean }> {
    await this.request(`/admin/products/${id}.json`, { method: 'DELETE' });
    return { id, deleted: true };
  }

  public async deleteCollection(id: number | string): Promise<{ id: number | string; deleted: boolean }> {
    try {
      await this.request(`/admin/custom_collections/${id}.json`, { method: 'DELETE' });
    } catch {
      await this.request(`/admin/collections/${id}.json`, { method: 'DELETE' });
    }
    return { id, deleted: true };
  }

  public async deleteArticle(id: number | string, blogId?: number | string): Promise<{ id: number | string; deleted: boolean }> {
    const path = blogId
      ? `/admin/blogs/${blogId}/articles/${id}.json`
      : `/admin/articles/${id}.json`;
    await this.request(path, { method: 'DELETE' });
    return { id, deleted: true };
  }

  public async deletePage(id: number | string): Promise<{ id: number | string; deleted: boolean }> {
    await this.request(`/admin/pages/${id}.json`, { method: 'DELETE' });
    return { id, deleted: true };
  }
}

// ============================================================================
// Concrete Haravan CLI Transport (§9: hrv theme dev/preview/sync/watch)
// ============================================================================

export interface HaravanCliProcessTransportOptions {
  binaryPath?: string;
  spawnFn?: typeof spawn;
  defaultCwd?: string;
  defaultEnv?: Record<string, string>;
  defaultTimeoutMs?: number;
}

export class HaravanCliProcessTransport implements HaravanCliTransport {
  private binaryPath: string;
  private spawnFn: typeof spawn;
  private defaultCwd?: string;
  private defaultEnv?: Record<string, string>;
  private defaultTimeoutMs: number;

  constructor(options?: HaravanCliProcessTransportOptions) {
    this.binaryPath = options?.binaryPath ?? 'hrv';
    this.spawnFn = options?.spawnFn ?? spawn;
    this.defaultCwd = options?.defaultCwd;
    this.defaultEnv = options?.defaultEnv;
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 30000;
  }

  private async spawnProcess(
    args: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      isLongRunning?: boolean;
      url?: string;
    }
  ): Promise<ThemeCliProcessResult> {
    const command = this.binaryPath;
    const cwd = options?.cwd ?? this.defaultCwd;
    const env = { ...process.env, ...this.defaultEnv, ...(options?.env ?? {}) };
    const isWin = process.platform === 'win32';
    const isCmdOrBat = isWin && (
      command.toLowerCase().endsWith('.cmd') ||
      command.toLowerCase().endsWith('.bat') ||
      (!command.toLowerCase().endsWith('.exe') && !command.includes('.'))
    );

    return new Promise<ThemeCliProcessResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawnFn(command, args, {
          cwd,
          env,
          shell: isCmdOrBat,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err: unknown) {
        return resolve({
          command,
          args,
          exitCode: 1,
          stdout: '',
          stderr: err instanceof Error ? err.message : String(err),
          url: options?.url,
        });
      }

      let stdout = '';
      let stderr = '';
      let hasSettled = false;
      let timer: NodeJS.Timeout | undefined;

      const cleanupTimer = () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      };

      const stop = async () => {
        cleanupTimer();
        if (child.pid && !child.killed) {
          try {
            if (isWin) {
              child.kill();
            } else {
              child.kill('SIGTERM');
            }
          } catch {
            // ignore
          }
        }
      };

      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (err: Error) => {
        cleanupTimer();
        stderr += `\nProcess error: ${err.message}`;
        if (!hasSettled) {
          hasSettled = true;
          const errCode = 'code' in err ? (err as { code: unknown }).code : undefined;
          resolve({
            command,
            args,
            exitCode: errCode === 'ENOENT' ? 127 : 1,
            stdout,
            stderr: stderr.trim(),
            url: options?.url,
            processId: child.pid,
            stop,
          });
        }
      });

      child.on('close', (code, signal) => {
        cleanupTimer();
        if (!hasSettled) {
          hasSettled = true;
          resolve({
            command,
            args,
            exitCode: code !== null ? code : signal ? 1 : 0,
            stdout,
            stderr: stderr.trim(),
            url: options?.url,
            processId: child.pid,
            stop,
          });
        }
      });

      if (options?.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanupTimer();
          stderr += `\nProcess execution timed out after ${options.timeoutMs}ms`;
          if (!hasSettled) {
            hasSettled = true;
            resolve({
              command,
              args,
              exitCode: 124,
              stdout,
              stderr: stderr.trim(),
              url: options?.url,
              processId: child.pid,
              stop,
            });
          }
          stop();
        }, options.timeoutMs);
      }

      if (options?.isLongRunning) {
        setTimeout(() => {
          if (!hasSettled) {
            hasSettled = true;
            resolve({
              command,
              args,
              exitCode: child.exitCode ?? undefined,
              stdout,
              stderr: stderr.trim(),
              url: options?.url,
              processId: child.pid,
              stop,
            });
          }
        }, 50);
      }
    });
  }

  public async preview(
    themeId: number | string,
    options?: ThemeCliPreviewOptions
  ): Promise<ThemeCliProcessResult> {
    const port = options?.port ?? 9292;
    const args = ['theme', 'preview', '--theme', String(themeId), '--port', String(port)];
    if (options?.env) args.push('--env', options.env);
    if (options?.dir) args.push('--dir', options.dir);

    return this.spawnProcess(args, {
      cwd: options?.dir,
      env: options?.env ? { HARAVAN_ENV: options.env } : undefined,
      timeoutMs: options?.timeoutMs,
      isLongRunning: true,
      url: `http://127.0.0.1:${port}`,
    });
  }

  public async sync(
    themeId: number | string,
    options?: ThemeCliSyncOptions
  ): Promise<ThemeCliProcessResult> {
    const args = ['theme', 'sync', '--theme', String(themeId)];
    if (options?.env) args.push('--env', options.env);
    if (options?.dir) args.push('--dir', options.dir);
    if (options?.force) args.push('--force');
    if (options?.files && options.files.length > 0) {
      args.push(...options.files);
    }

    return this.spawnProcess(args, {
      cwd: options?.dir,
      env: options?.env ? { HARAVAN_ENV: options.env } : undefined,
      timeoutMs: options?.timeoutMs,
      isLongRunning: false,
    });
  }

  public async watch(
    themeId: number | string,
    options?: ThemeCliWatchOptions
  ): Promise<ThemeCliProcessResult> {
    const args = ['theme', 'watch', '--theme', String(themeId)];
    if (options?.env) args.push('--env', options.env);
    if (options?.dir) args.push('--dir', options.dir);
    if (options?.notify) args.push('--notify');

    return this.spawnProcess(args, {
      cwd: options?.dir,
      env: options?.env ? { HARAVAN_ENV: options.env } : undefined,
      timeoutMs: options?.timeoutMs,
      isLongRunning: true,
    });
  }

  public async exec(
    args: string[],
    options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }
  ): Promise<ThemeCliProcessResult> {
    return this.spawnProcess(args, {
      cwd: options?.cwd,
      env: options?.env,
      timeoutMs: options?.timeoutMs,
      isLongRunning: false,
    });
  }
}

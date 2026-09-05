import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { ThemeWorkspaceContext } from '../../src/shared/theme-task-context';
import { CapabilityError, BrowserTarget } from '../../src/shared/control-plane-contracts';
import { WorkspaceFilePort } from '../../src/main/tools/workspace-file-port';
import {
  HaravanSyncBarrier,
  TerminalSyncCursor,
  TerminalSyncPort,
  TabReloadPort,
} from '../../src/main/qa/haravan-sync-barrier';
import { ThemeMutationSession } from '../../src/main/qa/theme-mutation-session';
import { ThemeTransactionRegistry, RuntimeTenancyIdentity } from '../../src/main/qa/theme-transaction-registry';

function createTempWorkspace(): string {
  const tmp = path.join(os.tmpdir(), `antifan-tx-test-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmp, { recursive: true });
  return tmp;
}

function cleanupWorkspace(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

class MemoryTerminalSyncPort implements TerminalSyncPort {
  private seq = 0;
  private generation = 1;
  private events: Array<{ seq: number; data: string }> = [];

  public emitOutput(data: string): number {
    this.seq++;
    this.events.push({ seq: this.seq, data });
    return this.seq;
  }

  public bumpGeneration(): number {
    this.generation++;
    return this.generation;
  }

  public captureBaselineSeq(sessionId: string): TerminalSyncCursor {
    if (!sessionId || sessionId.trim().length === 0) {
      throw new CapabilityError('INVALID_ARGUMENT', 'Valid sessionId is required');
    }
    return {
      sessionId,
      sessionGeneration: this.generation,
      baselineSeq: this.seq,
    };
  }

  public async waitTerminal(input: {
    sessionId: string;
    condition: 'output-match' | 'silence' | 'exit';
    pattern?: string;
    afterSeq?: number;
    sessionGeneration?: number;
    timeoutMs?: number;
  }): Promise<{ satisfied: boolean; lastSeq: number; outputTail?: string; sessionGeneration?: number }> {
    if (input.sessionGeneration !== undefined && input.sessionGeneration !== this.generation) {
      throw new CapabilityError(
        'SESSION_STALE',
        `Terminal generation mismatch: expected ${input.sessionGeneration}, current is ${this.generation}`
      );
    }

    if (input.condition === 'output-match') {
      const regex = new RegExp(input.pattern || '.*', 'i');
      const minSeq = input.afterSeq ?? 0;

      // Filter events emitted STRICTLY AFTER afterSeq
      const subsequentEvents = this.events.filter((e) => e.seq > minSeq);
      const matchedEvent = subsequentEvents.find((e) => regex.test(e.data));

      if (matchedEvent) {
        return {
          satisfied: true,
          lastSeq: matchedEvent.seq,
          sessionGeneration: this.generation,
          outputTail: matchedEvent.data,
        };
      }
      return { satisfied: false, lastSeq: this.seq, sessionGeneration: this.generation };
    }

    return { satisfied: true, lastSeq: this.seq, sessionGeneration: this.generation };
  }
}

class MemoryTabReloadPort implements TabReloadPort {
  public docGen: number;

  constructor(initialDocGen = 1) {
    this.docGen = initialDocGen;
  }

  public async reload(target: BrowserTarget): Promise<{ reloaded: boolean; target: BrowserTarget }> {
    this.docGen++;
    return {
      reloaded: true,
      target: {
        ...target,
        documentGeneration: this.docGen,
      },
    };
  }
}

test('ThemeTransactionRegistry: context validation and exclusive workspace lock', async () => {
  const workspaceRoot = createTempWorkspace();

  try {
    const validContext: ThemeWorkspaceContext = {
      storeId: 'store-123',
      storeDomain: 'test.myharavan.com',
      themeId: '100123',
      workspaceRoot,
      targetTabId: 'tab-main',
      platform: 'haravan',
    };

    const filePort = new WorkspaceFilePort();
    const tenancy: RuntimeTenancyIdentity = { projectId: 'p1', workspaceId: 'w1', runtimeId: 'r1' };
    const registry = new ThemeTransactionRegistry(tenancy, filePort);
    const beginRes = await registry.begin(validContext);

    assert.strictEqual(typeof beginRes.sessionId, 'string');
    assert.strictEqual(registry.isLocked(workspaceRoot), true);

    // Concurrent session on same workspaceRoot MUST be rejected
    await assert.rejects(
      async () => await registry.begin(validContext),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TRANSACTION_CONFLICT'
    );

    // Rollback session to release lock
    await registry.rollback(workspaceRoot);
    assert.strictEqual(registry.isLocked(workspaceRoot), false);

    // After rollback/release, new session can acquire lock
    const beginRes2 = await registry.begin(validContext);
    assert.strictEqual(typeof beginRes2.sessionId, 'string');
    await registry.rollback(workspaceRoot);
  } finally {
    cleanupWorkspace(workspaceRoot);
  }
});
test('ThemeMutationSession: atomic CAS write and sha256 mismatch rejection', async () => {
  const workspaceRoot = createTempWorkspace();
  const filePort = new WorkspaceFilePort();

  try {
    const relFile = 'snippets/product-card.liquid';
    const initialContent = '<div class="card">Original</div>';
    await filePort.write(workspaceRoot, relFile, initialContent);
    const initialSha256 = crypto.createHash('sha256').update(initialContent).digest('hex');

    const context: ThemeWorkspaceContext = {
      storeId: 'store-123',
      storeDomain: 'test.myharavan.com',
      themeId: '100123',
      workspaceRoot,
      targetTabId: 'tab-main',
      platform: 'haravan',
    };

    const session = new ThemeMutationSession(context, filePort);
    await session.begin();

    // 1. CAS write with WRONG expectedSha256 -> must throw CAS_MISMATCH without mutating file
    await assert.rejects(
      async () => {
        await session.writeCAS({
          relativePath: relFile,
          content: '<div class="card">Tampered</div>',
          expectedSha256: 'deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678',
        });
      },
      (err: unknown) => err instanceof CapabilityError && err.code === 'CAS_MISMATCH'
    );

    // Verify content remained unmodified
    const untouched = filePort.read(workspaceRoot, relFile);
    assert.strictEqual(untouched.content, initialContent);
    assert.strictEqual(session.lineage.workspaceGen, 0);

    // 2. CAS write with CORRECT expectedSha256 -> succeeds and increments workspaceGen
    const updatedContent = '<div class="card">Updated</div>';
    const casRes = await session.writeCAS({
      relativePath: relFile,
      content: updatedContent,
      expectedSha256: initialSha256,
    });

    assert.strictEqual(casRes.previousSha256, initialSha256);
    assert.strictEqual(casRes.workspaceGen, 1);
    assert.strictEqual(session.lineage.workspaceGen, 1);
    assert.strictEqual(session.sessionState, 'mutated');

    const readUpdated = filePort.read(workspaceRoot, relFile);
    assert.strictEqual(readUpdated.content, updatedContent);

    await session.rollback();
  } finally {
    cleanupWorkspace(workspaceRoot);
  }
});

test('ThemeMutationSession: premature settle VERIFIED denial', async () => {
  const workspaceRoot = createTempWorkspace();
  const filePort = new WorkspaceFilePort();

  try {
    const context: ThemeWorkspaceContext = {
      storeId: 'store-123',
      storeDomain: 'test.myharavan.com',
      themeId: '100123',
      workspaceRoot,
      targetTabId: 'tab-main',
      platform: 'haravan',
    };

    const session = new ThemeMutationSession(context, filePort);
    await session.begin();
    await session.writeCAS({
      relativePath: 'sections/header.liquid',
      content: '<header>Test</header>',
    });

    // Calling settle('VERIFIED') from 'mutated' state MUST be rejected (fails closed)
    await assert.rejects(
      async () => await session.settle('VERIFIED'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'SESSION_STALE'
    );

    await session.rollback();
  } finally {
    cleanupWorkspace(workspaceRoot);
  }
});

test('ThemeMutationSession: SyncBarrier rejects pre-baseline success and only acknowledges post-baseline upload', async () => {
  const workspaceRoot = createTempWorkspace();
  const filePort = new WorkspaceFilePort();
  const termPort = new MemoryTerminalSyncPort();
  const reloadPort = new MemoryTabReloadPort(1);
  const syncBarrier = new HaravanSyncBarrier(termPort, reloadPort);

  try {
    const termId = 'term-active';

    // 1. Pre-baseline upload output exists in history
    termPort.emitOutput('[14:20:00] Uploaded: snippets/old.liquid\n');

    // 2. Capture baseline cursor
    const cursor = syncBarrier.captureBaselineCursor(termId);
    assert.strictEqual(cursor.baselineSeq, 1);
    assert.strictEqual(cursor.sessionGeneration, 1);

    const context: ThemeWorkspaceContext = {
      storeId: 'store-123',
      storeDomain: 'test.myharavan.com',
      themeId: '100123',
      workspaceRoot,
      targetTabId: 'tab-main',
      platform: 'haravan',
      terminalSessionId: termId,
    };

    const session = new ThemeMutationSession(context, filePort, syncBarrier, undefined, { initialDocGen: 1 });
    await session.begin();

    await session.writeCAS({
      relativePath: 'templates/index.liquid',
      content: '<h1>Hello Haravan</h1>',
    });

    const target: BrowserTarget = {
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      runtimeId: 'rt-1',
      tabId: 'tab-main',
      documentGeneration: 1,
      browserEpoch: 1,
    };

    // 3. Emit noise after baseline (does NOT match upload pattern)
    termPort.emitOutput('[14:20:05] Watching for file changes...\n');

    // Attempting to awaitSync MUST fail closed (pre-baseline "Uploaded" is NOT accepted)
    await assert.rejects(
      async () => {
        await session.awaitSyncAndReload(target, { cursor, timeoutMs: 100 });
      },
      (err: unknown) => err instanceof CapabilityError && err.code === 'DURABILITY_FAILED'
    );

    // 4. Stale terminal generation test: if terminal session restarted, must fail closed with SESSION_STALE
    termPort.bumpGeneration();
    await assert.rejects(
      async () => {
        await session.awaitSyncAndReload(target, { cursor, timeoutMs: 100 });
      },
      (err: unknown) => err instanceof CapabilityError && err.code === 'SESSION_STALE'
    );

    // 5. Re-capture fresh cursor for active generation
    const freshCursor = syncBarrier.captureBaselineCursor(termId);
    assert.strictEqual(freshCursor.sessionGeneration, 2);

    // Emit real post-baseline upload acknowledgment
    termPort.emitOutput('[14:20:06] Uploaded: templates/index.liquid\n');

    const syncRes = await session.awaitSyncAndReload(target, {
      cursor: freshCursor,
      timeoutMs: 1000,
    });

    assert.strictEqual(syncRes.sync.syncGen, 1);
    assert.strictEqual(syncRes.reload.documentGeneration, 2);
    assert.strictEqual(session.lineage.documentGeneration, 2);
    assert.strictEqual(session.sessionState, 'settled');

    // Settle with VERIFIED
    const receipt = await session.settle('VERIFIED', { check: 'visual_passed' });
    assert.strictEqual(receipt.verdict, 'VERIFIED');
    assert.strictEqual(receipt.rolledBack, false);
    assert.strictEqual(session.sessionState, 'committed');
  } finally {
    cleanupWorkspace(workspaceRoot);
  }
});

test('ThemeMutationSession: auto-rollback to R0 on HARD_FAIL_ROLLBACK policy', async () => {
  const workspaceRoot = createTempWorkspace();
  const filePort = new WorkspaceFilePort();

  try {
    const originalFile = 'sections/hero.liquid';
    const originalContent = '<section>Hero Baseline</section>';
    await filePort.write(workspaceRoot, originalFile, originalContent);
    const originalSha256 = crypto.createHash('sha256').update(originalContent).digest('hex');

    const context: ThemeWorkspaceContext = {
      storeId: 'store-123',
      storeDomain: 'test.myharavan.com',
      themeId: '100123',
      workspaceRoot,
      targetTabId: 'tab-main',
      platform: 'haravan',
    };

    const session = new ThemeMutationSession(context, filePort, undefined, undefined, {
      policy: 'HARD_FAIL_ROLLBACK',
    });
    await session.begin();

    // 1. Modify existing file
    await session.writeCAS({
      relativePath: originalFile,
      content: '<section>BROKEN REGRESSION</section>',
    });

    // 2. Create a new orphan file
    const orphanFile = 'snippets/unwanted.liquid';
    await session.writeCAS({
      relativePath: orphanFile,
      content: '<span>Orphan</span>',
    });

    assert.strictEqual(fs.existsSync(path.join(workspaceRoot, orphanFile)), true);

    // Settle with REJECTED -> triggers automatic R0 rollback
    const receipt = await session.settle('REJECTED', { error: 'Liquid syntax crash' });
    assert.strictEqual(receipt.verdict, 'REJECTED');
    assert.strictEqual(receipt.rolledBack, true);
    assert.strictEqual(session.sessionState, 'rolled_back');

    // Verify disk state: original file restored, orphan file deleted
    const restored = filePort.read(workspaceRoot, originalFile);
    assert.strictEqual(restored.content, originalContent);
    const restoredSha256 = crypto.createHash('sha256').update(restored.content).digest('hex');
    assert.strictEqual(restoredSha256, originalSha256);

    assert.strictEqual(fs.existsSync(path.join(workspaceRoot, orphanFile)), false, 'Orphan file must be deleted on rollback');
  } finally {
    cleanupWorkspace(workspaceRoot);
  }
});

test('ThemeTransactionRegistry: EXPLORATORY_HOLD retains lock and supports resolveHold', async () => {
  const workspaceRoot = createTempWorkspace();
  const filePort = new WorkspaceFilePort();

  try {
    const originalFile = 'assets/style.css';
    const originalContent = 'body { color: black; }';
    await filePort.write(workspaceRoot, originalFile, originalContent);

    const context: ThemeWorkspaceContext = {
      storeId: 'store-123',
      storeDomain: 'test.myharavan.com',
      themeId: '100123',
      workspaceRoot,
      targetTabId: 'tab-main',
      platform: 'haravan',
    };

    const tenancy: RuntimeTenancyIdentity = { projectId: 'p1', workspaceId: 'w1', runtimeId: 'r1' };
    const registry = new ThemeTransactionRegistry(tenancy, filePort);
    await registry.begin(context, undefined, { policy: 'EXPLORATORY_HOLD' });

    await registry.writeCAS(workspaceRoot, {
      relativePath: originalFile,
      content: 'body { color: red; }',
    });

    // Settle with REJECTED under EXPLORATORY_HOLD -> state becomes 'held'
    const receipt = await registry.settle(workspaceRoot, 'REJECTED', { note: 'Inconclusive visual diff' });
    assert.strictEqual(receipt.verdict, 'REJECTED');
    assert.strictEqual(receipt.rolledBack, false);
    assert.strictEqual(registry.isLocked(workspaceRoot), true);

    // Workspace lock MUST still be held in quarantine
    await assert.rejects(
      async () => await registry.begin(context),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TRANSACTION_CONFLICT'
    );

    // Agent inspects disk, decides to rollback via resolveHold
    const resolveRes = await registry.resolveHold(workspaceRoot, 'rollback');
    assert.strictEqual(resolveRes.action, 'rollback');
    assert.strictEqual(registry.isLocked(workspaceRoot), false);

    // Disk restored to original
    const restored = filePort.read(workspaceRoot, originalFile);
    assert.strictEqual(restored.content, originalContent);

    // Lock is now released
    const session3 = await registry.begin(context);
    assert.strictEqual(typeof session3.sessionId, 'string');
    await registry.rollback(workspaceRoot);
  } finally {
    cleanupWorkspace(workspaceRoot);
  }
});

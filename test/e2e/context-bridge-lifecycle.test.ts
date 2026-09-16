import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { CoreHealthService } from '../../src/main/diagnostics/core-health.js';

interface JsonRpcResponse<T = unknown> {
  jsonrpc: string;
  id?: number | string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface ContextPackV2Result {
  packId: string;
  task: string;
  platform?: string;
  claims: Array<Record<string, unknown>>;
  rules: Array<Record<string, unknown>>;
  historicalCases: Array<Record<string, unknown>>;
  knownPitfalls: Array<Record<string, unknown>>;
  knownWorkarounds: Array<Record<string, unknown>>;
  recommendedPattern: unknown;
  uncertainty: { level: string; reason?: string };
  confidence: string;
  generatedAt?: string;
}

interface ReceiptV2Result {
  receiptId: string;
  task: string;
  packId: string | null;
  recommendation: string;
  abstained: boolean;
  evidenceRevisions: string[];
  uncertainty: { level: string; reason?: string };
  confidence: string;
  createdAt: string;
}

interface IngestOutcomeResult {
  caseId: string;
  candidateId: string;
  observationId?: string;
  status: string;
}

interface ReuseMetricResult {
  metric: string;
  task: string;
  packId: string | null;
  found: { value: number; claimIds: string[]; witness: string };
  injected: { value: number; claimIds: string[]; witness: string };
  outcomeLinked: { value: number; claimIds: string[]; witness: string };
}

interface FindSimilarResult {
  claims: Array<Record<string, unknown>>;
  cases: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  antiPatterns: Array<Record<string, unknown>>;
  workarounds: Array<Record<string, unknown>>;
  fixPatterns: Array<Record<string, unknown>>;
}

interface CoreHealthResult {
  status: string;
  reasonCode: string;
  stats: Record<string, number>;
  audit: Record<string, unknown>;
  decay: Record<string, unknown>;
  gates: Record<string, { passed: boolean; detail: string }>;
  uncertainty: { level: string; reason: string };
}

interface AdjudicateResult {
  adjudicationId: string;
  candidateId: string;
  decision: string;
  authority: string;
  scope: string;
}

interface ClaimQueryResult {
  claimId: string;
  statement: string;
  kind: string;
  status: string;
  confidence: string;
  unitId: string;
}

class McpBridgeClient {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number | string, {
    resolve: (res: JsonRpcResponse<unknown>) => void;
    reject: (err: Error) => void;
  }>();

  constructor(proc: ChildProcess) {
    this.proc = proc;
    const rl = readline.createInterface({
      input: this.proc.stdout!,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const json = JSON.parse(trimmed) as JsonRpcResponse<unknown>;
        if (json.id !== undefined && this.pending.has(json.id)) {
          const handler = this.pending.get(json.id)!;
          this.pending.delete(json.id);
          if (json.error) {
            handler.reject(new Error(`JSON-RPC error ${json.error.code}: ${json.error.message}`));
          } else {
            handler.resolve(json);
          }
        }
      } catch {
        // Non-JSON output ignored
      }
    });

    this.proc.on('exit', (code, signal) => {
      for (const [, handler] of this.pending.entries()) {
        handler.reject(new Error(`MCP bridge process terminated (code=${code}, signal=${signal})`));
      }
      this.pending.clear();
    });
  }

  sendRequest<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<JsonRpcResponse<T>>();
    this.pending.set(id, {
      resolve: (res) => resolve(res as JsonRpcResponse<T>),
      reject,
    });

    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    }) + '\n';

    this.proc.stdin!.write(payload);
    return promise.then((res) => {
      if (res.error) {
        throw new Error(`RPC Error [${res.error.code}]: ${res.error.message}`);
      }
      return res.result as T;
    });
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.sendRequest<McpToolResult>('tools/call', {
      name,
      arguments: args,
    });

    if (!result || !result.content || !Array.isArray(result.content)) {
      throw new Error(`Invalid MCP tool result shape for '${name}': ${JSON.stringify(result)}`);
    }

    const textItem = result.content.find((c) => c.type === 'text');
    if (!textItem || typeof textItem.text !== 'string') {
      throw new Error(`Tool '${name}' returned no text content`);
    }

    if (result.isError) {
      throw new Error(`Tool '${name}' failed: ${textItem.text}`);
    }

    try {
      return JSON.parse(textItem.text) as T;
    } catch {
      return textItem.text as unknown as T;
    }
  }

  async close(): Promise<void> {
    if (this.proc.killed || this.proc.exitCode !== null) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.proc.once('exit', () => resolve());
    this.proc.kill();
    await promise;
  }
}

describe('Context Bridge Lifecycle E2E (Audit #29)', () => {
  it('proves the 100% full loop: pack built -> receipt issued -> outcome ingested -> queryable -> promoted -> retrieved', async () => {
    const rootDir = process.cwd();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-context-bridge-e2e-'));
    const tmpDb = path.join(tmpDir, 'core.db');
    const mcpScript = path.join(rootDir, 'scripts', 'antifan-omp-mcp.cjs');

    const prevDb = process.env['SUPER_CORE_DB'];
    process.env['SUPER_CORE_DB'] = tmpDb;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SUPER_CORE_DB: tmpDb,
      ELECTRON_RUN_AS_NODE: '1',
    };
    // Ensure no ambient session attachments leak into the test harness
    delete env.ANTIFAN_MCP_BOOTSTRAP;
    delete env.ANTIFAN_ATTACHMENT_SECRET;
    delete env.ANTIFAN_ATTACHMENT_ID;

    const proc = spawn(process.execPath, [mcpScript], {
      cwd: rootDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const client = new McpBridgeClient(proc);

    try {
      // 1. Handshake with real MCP stdio bridge process
      const initRes = await client.sendRequest<{ serverInfo: { name: string; version: string } }>('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'omp-e2e-client', version: '1.0.0' },
      });
      assert.equal(initRes.serverInfo?.name, 'antifan-omp', 'MCP bridge must identify as antifan-omp');

      // 2. Discover advertised capabilities and verify core tools presence
      const listToolsRes = await client.sendRequest<{ tools: Array<{ name: string; description: string }> }>('tools/list', {});
      const toolNames = new Set((listToolsRes.tools || []).map((t) => t.name));
      assert.ok(toolNames.has('core.context_pack_v2'), 'core.context_pack_v2 must be advertised');
      assert.ok(toolNames.has('core.receipt_v2'), 'core.receipt_v2 must be advertised');
      assert.ok(toolNames.has('core.ingest_outcome'), 'core.ingest_outcome must be advertised');
      assert.ok(toolNames.has('core.reuse_metric'), 'core.reuse_metric must be advertised');
      assert.ok(toolNames.has('core.health'), 'core.health must be advertised');
      assert.ok(toolNames.has('core.query'), 'core.query must be advertised');
      assert.ok(toolNames.has('core.find_similar'), 'core.find_similar must be advertised');
      assert.ok(toolNames.has('core.adjudicate'), 'core.adjudicate must be advertised');

      // 3. Step 1: Context Pack Injection (core.context_pack_v2)
      const taskDescription = 'e2e storefront carousel gesture isolation';
      const pack = await client.callTool<ContextPackV2Result>('core.context_pack_v2', {
        task: taskDescription,
        platform: 'haravan',
      });

      assert.ok(typeof pack.packId === 'string' && pack.packId.startsWith('pack-'), 'Context Pack must return a valid packId');
      assert.equal(pack.task, taskDescription, 'Context Pack must record the original task context');
      assert.equal(pack.platform, 'haravan', 'Context Pack must be platform scoped');
      assert.ok(Array.isArray(pack.claims), 'Context Pack must include claims array');
      assert.ok(Array.isArray(pack.rules), 'Context Pack must include rules array');
      assert.ok(Array.isArray(pack.historicalCases), 'Context Pack must include historicalCases array');
      assert.ok(Array.isArray(pack.knownPitfalls), 'Context Pack must include knownPitfalls array');
      assert.ok(Array.isArray(pack.knownWorkarounds), 'Context Pack must include knownWorkarounds array');
      assert.ok(pack.uncertainty && typeof pack.uncertainty.level === 'string', 'Context Pack must classify uncertainty');
      assert.ok(typeof pack.confidence === 'string', 'Context Pack must classify confidence');

      // 4. Step 2: Decision Receipt Issuance (core.receipt_v2)
      const recommendationText = 'Isolate pointermove listener on touch-action: pan-y slider container';
      const receipt = await client.callTool<ReceiptV2Result>('core.receipt_v2', {
        task: taskDescription,
        packId: pack.packId,
        recommendation: recommendationText,
        platform: 'haravan',
      });

      assert.ok(typeof receipt.receiptId === 'string' && receipt.receiptId.startsWith('rcpt-'), 'Decision Receipt must return a valid receiptId');
      assert.equal(receipt.task, taskDescription, 'Decision Receipt must bind the task');
      assert.equal(receipt.packId, pack.packId, 'Decision Receipt must bind the exact packId');
      assert.equal(receipt.recommendation, recommendationText, 'Decision Receipt must persist the recommendation');
      assert.ok(Array.isArray(receipt.evidenceRevisions), 'Decision Receipt must bind evidence revisions');
      assert.ok(typeof receipt.createdAt === 'string', 'Decision Receipt must be timestamped');

      // 5. Step 3: Outcome Ingestion (core.ingest_outcome)
      const outcomeText = 'Carousel gestures verified with 0 layout shift and 60fps frame rate';
      const outcome = await client.callTool<IngestOutcomeResult>('core.ingest_outcome', {
        task: taskDescription,
        context: 'Fixed gesture conflict with product media gallery on mobile Haravan theme',
        outcome: outcomeText,
        verificationRef: receipt.receiptId,
        unitId: 'unit-storefront-e2e',
        platform: 'haravan',
      });

      assert.ok(typeof outcome.caseId === 'string' && outcome.caseId.startsWith('case-'), 'Outcome ingestion must yield a caseId');
      assert.ok(typeof outcome.candidateId === 'string' && outcome.candidateId.startsWith('cand-'), 'Outcome ingestion must yield a candidateId');
      assert.equal(outcome.status, 'PENDING', 'New candidate must start in PENDING status (anti-self-promotion invariant)');

      // 6. Step 4: Verification through MCP Query Surfaces
      // 6a. Historical reuse metric linking verificationRef -> receipt -> pack
      const reuse = await client.callTool<ReuseMetricResult>('core.reuse_metric', {
        task: taskDescription,
      });
      assert.equal(reuse.task, taskDescription);
      assert.equal(reuse.packId, pack.packId);
      assert.equal(reuse.metric, 'found + injected + outcome-linked');
      assert.ok(
        reuse.outcomeLinked.witness.includes('cases.verificationRef -> receipts.receiptId -> receipts.packId -> packs.claimIdsJson'),
        'Witness chain must prove the verified link across case, receipt, and pack'
      );

      // 6b. Case-based reasoning search surfaces the ingested outcome
      const similar = await client.callTool<FindSimilarResult>('core.find_similar', {
        task: 'carousel gesture isolation',
        platform: 'haravan',
      });
      assert.ok(
        similar.cases.some((c) => c.caseId === outcome.caseId),
        'findSimilar must retrieve the newly ingested case for related tasks'
      );

      // 6c. Aggregated Core Health over MCP
      const health = await client.callTool<CoreHealthResult>('core.health', {});
      assert.ok((health.stats['cases'] ?? 0) >= 1, 'Core health stats must reflect the ingested case');
      assert.ok((health.stats['receipts'] ?? 0) >= 1, 'Core health stats must reflect the persisted receipt');
      assert.ok((health.stats['packs'] ?? 0) >= 1, 'Core health stats must reflect the created pack');
      assert.ok((health.stats['candidates'] ?? 0) >= 1, 'Core health stats must reflect the pending candidate');

      // 7. Step 5: Verification via CoreHealthService (Diagnostics Surface)
      const healthService = new CoreHealthService({
        repoRoot: rootDir,
        scriptPath: path.join(rootDir, 'scripts', 'antifan-core.cjs'),
      });

      const taskRuns = await healthService.listTaskRuns();
      assert.equal(taskRuns.status, 'HEALTHY', 'Task runs list must be HEALTHY when runs exist');
      assert.equal(taskRuns.reasonCode, 'TASK_RUNS_PRESENT');
      assert.ok(taskRuns.packs.some((p) => p.packId === pack.packId), 'Health surface must enumerate the created pack');
      assert.ok(taskRuns.cases.some((c) => c.caseId === outcome.caseId), 'Health surface must enumerate the created case');

      const packTrace = await healthService.getTaskRunTrace(pack.packId);
      assert.equal(packTrace.status, 'HEALTHY');
      assert.equal(packTrace.kind, 'pack');
      assert.equal((packTrace.pack as Record<string, unknown> | undefined)?.['packId'], pack.packId);
      assert.ok(
        packTrace.receipts?.some((r) => r.receiptId === receipt.receiptId),
        'Pack detail trace must associate the issued receipt with the pack'
      );

      const caseTrace = await healthService.getTaskRunTrace(outcome.caseId);
      assert.equal(caseTrace.status, 'HEALTHY');
      assert.equal(caseTrace.kind, 'case');
      assert.equal((caseTrace.case as Record<string, unknown> | undefined)?.['caseId'], outcome.caseId);
      assert.ok(
        caseTrace.candidates?.some((c) => c.candidateId === outcome.candidateId),
        'Case detail trace must associate the created candidate with the case'
      );

      // 8. Step 6: Learning Loop Closure (Adjudication -> Queryability -> Retrieval in Turn N+1)
      const adjudication = await client.callTool<AdjudicateResult>('core.adjudicate', {
        candidateId: outcome.candidateId,
        decision: 'PROMOTE',
        authority: 'e2e-quality-gate',
        rationale: 'Verified with 0 layout shift under mobile touch stress testing',
        scope: 'production',
      });
      assert.equal(adjudication.decision, 'PROMOTE');
      assert.equal(adjudication.candidateId, outcome.candidateId);

      // Verify the promoted claim is now immediately queryable
      const queryHits = await client.callTool<ClaimQueryResult[]>('core.query', {
        text: 'carousel',
      });
      const expectedClaimId = `claim-${outcome.candidateId}`;
      const promotedClaim = queryHits.find((c) => c.claimId === expectedClaimId);
      assert.ok(promotedClaim, `Promoted candidate must materialize as queryable claim ${expectedClaimId}`);
      assert.equal(promotedClaim.status, 'PROMOTED');

      // Verify a fresh Context Pack for a subsequent task retrieves the newly promoted claim
      const subsequentPack = await client.callTool<ContextPackV2Result>('core.context_pack_v2', {
        task: 'carousel performance verification',
        platform: 'haravan',
      });
      assert.ok(
        subsequentPack.claims.some((c) => c.claimId === expectedClaimId),
        'Subsequent Context Pack in Turn N+1 must retrieve the promoted claim learned from Turn N'
      );

    } finally {
      if (prevDb !== undefined) {
        process.env['SUPER_CORE_DB'] = prevDb;
      } else {
        delete process.env['SUPER_CORE_DB'];
      }
      await client.close();
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Fallback if Windows file lock delay
      }
    }
  });
});

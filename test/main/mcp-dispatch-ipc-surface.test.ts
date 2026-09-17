/**
 * AntiFan — MCP Dispatch accounting: IPC delivery-surface assertions.
 *
 * Home for the three invariants Phase 4 owes and no other test owns
 * (`plans/260917-0341-mcp-dispatch-accounting/phase-04-delivery-surface.md:90`, `:145`, `:251`):
 *
 *   1. **channel existence** — `antifan:mcp-dispatch:get-state` is registered in
 *      `src/main/browser/native-tab-host.ts` after the core-health block, the preload exposes
 *      `getMcpDispatchState`, and the worker protocol is spawned (never run on the main thread);
 *   2. **sender gate** — `isTrustedSessionVaultSender(event)` is the handler's *first statement* and
 *      the refusal is a well-formed `UNMEASURED` envelope, never `null`;
 *   3. **payload projection** (constraint D) — no raw frame field, no absolute path and no URL
 *      crosses the channel, `evidenceRefs` are synthetic only, and `storePath` is a display label
 *      with a real `null` case.
 *
 * Deliberately NOT here: nothing is added to `test/main/ipc-audit.test.ts`, whose `:419-425`
 * five-entry list is a workflow-authority invariant inside the test at `:415`
 * (`phase-04:251`). The gate's own accept/reject behaviour stays pinned by
 * `test/main/local-session-vault.test.ts:181-199`.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = fs.existsSync(path.join(process.cwd(), 'src'))
  ? process.cwd()
  : path.resolve(__dirname, '..', '..');

const NATIVE_TAB_HOST_PATH = path.join(root, 'src', 'main', 'browser', 'native-tab-host.ts');
const PRELOAD_PATH = path.join(root, 'src', 'preload', 'toolbar-preload.ts');
const SERVICE_PATH = path.join(root, 'src', 'main', 'diagnostics', 'mcp-dispatch-service.ts');
const ACCOUNTING_PATH = path.join(root, 'src', 'main', 'diagnostics', 'mcp-dispatch-accounting.ts');

const CHANNEL = 'antifan:mcp-dispatch:get-state';

/**
 * The compiled service module's exported surface, asserted structurally here rather than through
 * `typeof import(...)`. Reason: the accounting / shared-contract modules are authored in parallel
 * with this file, and a `typeof import(...)` on a still-missing module fails `tsc` for whichever
 * file mentions it, which would block every sibling agent in this checkout. The service module
 * itself type-checks these signatures; this file owns the runtime projection assertions.
 */
interface McpDispatchServiceModule {
  /**
   * `any` rather than a restated envelope interface: this file asserts the *runtime* projection
   * (which keys and which values survive), and a restated interface here would be a second, drifting
   * copy of the frozen envelope. The accounting module owns the type and the service re-exports it.
   */
  projectEnvelope(raw: unknown, storeLabel: string | null): any;
  projectEvidenceRefs(value: unknown): string[];
  labeliseAffected(entries: unknown, storeLabel: string | null): string[];
  sanitizeProjectedValue(value: unknown, storeLabel: string | null, depth?: number): unknown;
  sanitiseReasonCode(value: unknown): string;
  unmeasuredBoundaryEnvelope(reasonCode: string, affected: readonly string[], storePath: string | null): any;
  mcpDispatchStoreLabel(): string | null;
  resetMcpDispatchStoreLabelForTest(): void;
  getMcpDispatchService(): unknown;
  passAwaitBudgetMs(): number;
  /** The service's published key sets, so a drift against the gate is a test failure. */
  MCP_DISPATCH_KEY_SETS: {
    envelope: readonly string[];
    row: readonly string[];
    fileRollup: readonly string[];
    census: readonly string[];
    censusEntry: readonly string[];
  };
  McpDispatchService: new (options?: {
    resolveStoreDir?: () => string;
    runPass?: (options: { storeDir: string; asOf: string; memo: boolean }) => Promise<unknown>;
  }) => {
    getState(): Promise<any>;
    clearCache(): void;
    getStoreLabel(): string | null;
    getDiagnostics(): { hasMemoEntry: boolean; memoKey: string | null; storeLabel: string | null; lastOutcome: string };
  };
}

/**
 * The accounting module's own exports this test needs. Imported through the same module the service
 * imports, because `isLocationShaped` is now the *shared* predicate: the service no longer defines it,
 * and a test that took it from the service would still pass if the service grew a private copy again.
 */
interface McpDispatchAccountingModule {
  accountStore(options: {
    storeDir: string;
    asOf: string;
    memo?: boolean;
    mode?: 'worker' | 'in-process';
  }): Promise<any>;
  isLocationShaped(value: string): boolean;
  HISTOGRAM_TOKEN_PATTERN: RegExp;
  UNRECOGNIZED_HISTOGRAM_KEY: string;
  UnmeasuredReason: Record<string, string>;
  MEASURED_REASON_CODE: string;
}

interface InvocationChecksumModule {
  computeFrameChecksum(frame: Record<string, unknown>): string;
}

/**
 * The canonical label of the store this machine actually reads. The store directory is
 * `…/control-plane-v2/invocations`; the label is that path's **final segment only** (`invocations`),
 * because a two-segment label would contain a separator and the payload rule bans separators and
 * drive letters outright.
 */
const CANONICAL_STORE_LABEL = 'invocations';

/**
 * Lazy value import of the compiled service module (sibling idiom:
 * `test/main/terminal-sleep-affinity-host.test.ts:150`). Loaded at call time so a source-text
 * assertion in this file can never be blocked by the module's own runtime graph.
 */
const serviceModule = (): McpDispatchServiceModule =>
  require('../../src/main/diagnostics/mcp-dispatch-service') as McpDispatchServiceModule;

const accountingModule = (): McpDispatchAccountingModule =>
  require('../../src/main/diagnostics/mcp-dispatch-accounting') as McpDispatchAccountingModule;

const checksumModule = (): InvocationChecksumModule =>
  require('../../src/main/session/invocation-frame-checksum') as InvocationChecksumModule;

const FORBIDDEN_PAYLOAD_TOKENS = [
  'runtimeLeaseToken',
  'authoritySnapshot',
  'runtimePid',
  'requestId',
  'paramDigest',
  'policyDigest',
  'attachmentId',
  'idempotencyKey',
];

describe('MCP dispatch IPC delivery surface', () => {
  describe('channel existence and the gated handler (source text)', () => {
    it('registers antifan:mcp-dispatch:get-state inside the core-health IPC block', () => {
      const source = fs.readFileSync(NATIVE_TAB_HOST_PATH, 'utf8');
      assert.ok(
        source.includes(`ipcMain.handle('${CHANNEL}'`),
        `native-tab-host.ts must register '${CHANNEL}'`,
      );

      const coreHealthTrace = source.indexOf("ipcMain.handle('antifan:core-health:get-task-run-trace'");
      const dispatchHandler = source.indexOf(`ipcMain.handle('${CHANNEL}'`);
      const capsuleList = source.indexOf("ipcMain.handle('antifan:capsule:list'");
      assert.ok(coreHealthTrace > 0, 'the core-health trace handler must exist as the anchor');
      assert.ok(dispatchHandler > 0, 'the dispatch handler must exist');
      assert.ok(capsuleList > 0, 'the capsule:list handler must exist as the closing anchor');
      assert.ok(
        dispatchHandler > coreHealthTrace && dispatchHandler < capsuleList,
        'the dispatch handler must sit immediately after the core-health block and before antifan:capsule:list',
      );
    });

    it('imports the service and the reason enum from the diagnostics block', () => {
      const source = fs.readFileSync(NATIVE_TAB_HOST_PATH, 'utf8');
      assert.match(
        source,
        /import \{[^}]*getMcpDispatchService[^}]*\} from '\.\.\/diagnostics\/mcp-dispatch-service';/,
        'native-tab-host.ts must import getMcpDispatchService from ../diagnostics/mcp-dispatch-service',
      );
      assert.match(
        source,
        /import \{[^}]*unmeasuredBoundaryEnvelope[^}]*\} from '\.\.\/diagnostics\/mcp-dispatch-service';/,
        'the refusal path must return the boundary-reduced builder result, not a literal',
      );
      assert.match(
        source,
        /import \{ UnmeasuredReason \} from '\.\.\/diagnostics\/mcp-dispatch-accounting';/,
        'the reason code must be the module closed enum, never a local string literal',
      );
      assert.ok(
        !/unmeasuredEnvelope\(/.test(source),
        'the host must not call the module builder directly — the boundary reducer owns affected[]',
      );
    });

    it('makes the sender gate the handler first statement and never returns null', () => {
      const source = fs.readFileSync(NATIVE_TAB_HOST_PATH, 'utf8');
      const handlerStart = source.indexOf(`ipcMain.handle('${CHANNEL}'`);
      const handlerEnd = source.indexOf("ipcMain.handle('antifan:capsule:list'", handlerStart);
      // Bounded by the NEXT handler, not by a character count: a slice that is too short silently
      // stops asserting the tail of the handler (it did, at 900 chars, once a comment was added).
      const handlerRegion = source.slice(handlerStart, handlerEnd > handlerStart ? handlerEnd : handlerStart + 2000);
      assert.ok(handlerRegion.length > 0, 'the handler region must be extractable');

      assert.match(
        handlerRegion,
        /async \(event\) => \{\s*if \(!isTrustedSessionVaultSender\(event\)\) \{/,
        'isTrustedSessionVaultSender(event) must be the handler first statement',
      );
      assert.ok(
        !/return null/.test(handlerRegion),
        'the refusal must never be null — the renderer must not distinguish null from a payload',
      );
      assert.match(
        handlerRegion,
        /return unmeasuredBoundaryEnvelope\(UnmeasuredReason\.SERVICE_FAILED, \['ipc-sender-not-trusted'\]/,
        'the refusal must be a well-formed UNMEASURED envelope naming the cause in affected[]',
      );
      assert.match(
        handlerRegion,
        /try \{ return await getMcpDispatchService\(\)\.getState\(\); \}/,
        'the success path must delegate to the service singleton',
      );
      assert.match(
        handlerRegion,
        /catch \{ return unmeasuredBoundaryEnvelope\(UnmeasuredReason\.SERVICE_FAILED/,
        'the failure path must also return an UNMEASURED envelope instead of throwing at IPC',
      );
      assert.ok(
        !/String\(err\)/.test(handlerRegion),
        'a raw error message would carry an absolute path; affected[] takes closed tokens only',
      );
    });

    it('gates the channel with the same predicate that already guards vault operations', () => {
      const gateSource = fs.readFileSync(
        path.join(root, 'src', 'main', 'browser', 'local-session-vault.ts'),
        'utf8',
      );
      assert.match(
        gateSource,
        /export function isTrustedSessionVaultSender\(event: unknown\): boolean/,
        'the gate must remain an exported predicate (local-session-vault.ts:65)',
      );
    });

    it('exposes getMcpDispatchState through the single contextBridge fan-out', () => {
      const preload = fs.readFileSync(PRELOAD_PATH, 'utf8');
      assert.ok(
        preload.includes(`getMcpDispatchState: () => ipcRenderer.invoke('${CHANNEL}')`),
        'toolbar-preload.ts must expose getMcpDispatchState over the invoke channel',
      );
      const coreTrace = preload.indexOf('getCoreTaskRunTrace:');
      const dispatch = preload.indexOf('getMcpDispatchState:');
      const workflowEvent = preload.indexOf('onWorkflowEvent:');
      assert.ok(coreTrace > 0 && dispatch > 0 && workflowEvent > 0, 'the hub block anchors must exist');
      assert.ok(
        dispatch > coreTrace && dispatch < workflowEvent,
        'getMcpDispatchState must be inserted after getCoreTaskRunTrace and before onWorkflowEvent',
      );
      const exposures = preload.match(/contextBridge\.exposeInMainWorld\('antifanToolbar'/g) ?? [];
      assert.strictEqual(
        exposures.length,
        1,
        'the whole api object is fanned out once at toolbar-preload.ts:207 — no second exposure',
      );
    });
  });

  describe('worker protocol and the off-main-thread constraint G (source text)', () => {
    it('spawns a worker_threads Worker over the compiled electron-free accounting module', () => {
      const source = fs.readFileSync(SERVICE_PATH, 'utf8');
      assert.match(
        source,
        /import \{ Worker \} from 'node:worker_threads';/,
        'the service must use node:worker_threads',
      );
      assert.match(
        source,
        /new Worker\(workerPath, \{\s*workerData: \{ storeDir, asOf, mode: 'worker' \},\s*\}\)/,
        'main -> worker must be workerData only: { storeDir, asOf, mode }',
      );
      assert.match(
        source,
        /path\.join\(__dirname, 'mcp-dispatch-accounting\.js'\)/,
        'the worker must load the compiled sibling accounting module',
      );
    });

    it('awaits exactly one message and terminates the worker on every settle path', () => {
      const source = fs.readFileSync(SERVICE_PATH, 'utf8');
      const code = stripComments(source);
      assert.match(code, /worker\.once\('message'/, 'the worker contract is one message');
      assert.match(code, /worker\.once\('error'/, 'a dying worker must not hang the await');
      assert.match(code, /worker\.once\('exit'/, 'an exit with no message must be a failure, not a hang');
      assert.match(code, /worker\.terminate\(\)/, 'the worker must be terminated on settle');
      assert.match(
        code,
        /return PASS_BUDGET_MS \+ WORKER_START_ALLOWANCE_MS \+ FILE_READ_ALLOWANCE_MS;/,
        'the caller-side await must be PASS_BUDGET_MS + worker start + one file read',
      );
      assert.match(
        code,
        /import \{[\s\S]*?\bPASS_BUDGET_MS\b[\s\S]*?\} from '\.\/mcp-dispatch-accounting';/,
        'the budget must be a static import from the accounting module, never a literal here',
      );
      assert.match(
        code,
        /\}, passAwaitBudgetMs\(\)\);/,
        'the bounded await must use the composed budget, not a bare literal',
      );
      assert.ok(
        !/PASS_BUDGET_MS = \d+/.test(code),
        'the service must not redeclare the budget constant',
      );
      assert.ok(
        !/MAX_CENSUS_BYTES = \d|MAX_CENSUS_FILES = \d/.test(code),
        'the service must not declare a second input-ceiling constant',
      );
    });

    it('holds no local copy of any module-owned symbol and no separator-bearing label literal', () => {
      const serviceCode = stripComments(fs.readFileSync(SERVICE_PATH, 'utf8'));
      const accountingSource = fs.readFileSync(ACCOUNTING_PATH, 'utf8');
      const nativeTabHost = fs.readFileSync(NATIVE_TAB_HOST_PATH, 'utf8');

      // One defining site in the whole tree, and it is the accounting module.
      const definitions = accountingSource.match(
        /^export (?:async )?(?:function|const) (unmeasuredEnvelope|storeDisplayLabel|computePopulationMemoKey|accountStore|runCensusPass)\b/gm,
      ) ?? [];
      assert.deepStrictEqual(
        definitions.slice().sort(),
        [
          'export async function accountStore',
          'export async function runCensusPass',
          'export function computePopulationMemoKey',
          'export function storeDisplayLabel',
          'export function unmeasuredEnvelope',
        ].sort(),
        'the accounting module must be the single defining site of every module-owned symbol',
      );
      for (const symbol of [
        'unmeasuredEnvelope', 'storeDisplayLabel', 'computePopulationMemoKey', 'accountStore', 'runCensusPass',
      ]) {
        assert.ok(
          !new RegExp(`^export (?:async )?(?:function|const) ${symbol}\\b`, 'm').test(serviceCode),
          `the service must define no local ${symbol}`,
        );
      }

      // The service imports them from the one module path instead. Parsed, not order-matched: the
      // import block is a set of names, and asserting a sequence would break on a reorder for no
      // contractual reason.
      // Slice the block anchored on its own module path: a lazy `\{[\s\S]*?\}` match spans earlier
      // single-line imports and would capture the wrong statement.
      const modulePath = "from './mcp-dispatch-accounting';";
      const pathAt = serviceCode.indexOf(modulePath);
      assert.ok(pathAt > 0, 'the service must import from ./mcp-dispatch-accounting');
      const openAt = serviceCode.lastIndexOf('\nimport {', pathAt);
      const closeAt = serviceCode.indexOf('}', openAt);
      assert.ok(openAt > 0 && closeAt > openAt, 'the accounting import block must be well formed');
      const importedNames = serviceCode
        .slice(openAt + '\nimport {'.length, closeAt)
        .split(',')
        .map((entry) => entry.replace(/^\s*type\s+/, '').trim())
        .filter((entry) => entry.length > 0);
      for (const required of [
        'AffectedToken', 'PASS_BUDGET_MS', 'runPopulationSweep', 'storeDisplayLabel', 'unmeasuredEnvelope',
      ]) {
        assert.ok(
          importedNames.includes(required),
          `the service must import ${required} from the accounting module`,
        );
      }
      for (const ctorOnly of ['McpDispatchAccount', 'Census', 'UnmeasuredReason']) {
        assert.ok(
          importedNames.includes(ctorOnly),
          `the service must take ${ctorOnly} from the module contract surface`,
        );
      }
      assert.ok(
        !/from '[^']*shared\/mcp-dispatch-contracts'/.test(serviceCode),
        'the accounting module re-exports the contracts, so a second import path is a second path to the same names',
      );

      // The retired two-segment label is gone, and no separator-bearing literal stands in for the
      // module's `storeDisplayLabel` call.
      assert.ok(
        !nativeTabHost.includes("'control-plane-v2/invocations'"),
        'the host must not carry the retired two-segment label literal',
      );
      const labelLines = serviceCode
        .split('\n')
        .filter((line) => line.includes('STORE_LABEL') || line.includes('storeDisplayLabel'));
      assert.ok(labelLines.length > 0, 'the label derivation must be present in the service');
      for (const line of labelLines) {
        assert.ok(
          !/['"`][A-Za-z0-9._-]+\/[A-Za-z0-9._-]+['"`]/.test(line),
          `no separator-bearing label literal may stand in for storeDisplayLabel: ${line.trim()}`,
        );
      }
    });

    it('never calls the pass on the main thread', () => {
      const source = fs.readFileSync(SERVICE_PATH, 'utf8');
      const code = stripComments(source);
      // The pass-shaped entries. `runPopulationSweep` is deliberately NOT in this list: it is the
      // module's metadata-only stage A, and the module names the delivery surface as its main-thread
      // caller (`mcp-dispatch-accounting.ts:703-705`) — it reads no bytes and folds no frame.
      for (const forbiddenCall of ['runCensusPass', 'readAdmittedFrames', 'readFramesIncremental', 'accountStore']) {
        assert.ok(
          !new RegExp(`\\b${forbiddenCall}\\s*\\(`).test(code),
          `the main-process service must not call ${forbiddenCall} — constraint G forbids a main-thread pass`,
        );
      }
      assert.ok(
        !code.includes("require('electron')") && !/from 'electron'/.test(code),
        'the service module must stay electron-free so the CLI and the worker can load it',
      );
    });

    it('reads only metadata for the memo key (no file content on the main thread)', () => {
      const source = fs.readFileSync(SERVICE_PATH, 'utf8');
      const code = stripComments(source);
      const memoKeyBody = extractFunctionBody(code, 'function readMemoKey');
      assert.match(
        memoKeyBody,
        /runPopulationSweep\(storeDir\)\.memoKey/,
        'the memo key must come from the module stage A, not a second local sweep',
      );
      assert.ok(
        !/\bfs\./.test(code),
        'the service performs no filesystem call of its own — every read is the module or the worker',
      );
      assert.ok(
        !/readFileSync/.test(code),
        'stage A must read no file content — the pass owns every content read (phase-01:104)',
      );
      assert.ok(
        !/\bdir\b/.test(memoKeyBody.replace(/storeDir/g, '')),
        'the memo key body must not touch a directory field',
      );
      assert.ok(
        !/asOf/.test(memoKeyBody),
        'asOf must NOT be part of the memo key (DD6)',
      );
    });
  });

  describe('payload projection — constraint D', () => {
    it('projects a raw envelope carrying a full authoritySnapshot down to the allowlist', () => {
      const { projectEnvelope } = serviceModule();
      const projected = projectEnvelope(rawFixtureEnvelope(), CANONICAL_STORE_LABEL);

      assert.deepStrictEqual(
        Object.keys(projected).sort(),
        [
          'affected', 'asOf', 'census', 'evidenceRefs', 'fileRollups',
          'reasonCode', 'reconciliation', 'rows', 'status', 'storePath', 'totals',
        ],
        'the payload must expose exactly the ten frozen top-level keys plus storePath',
      );

      const serialized = JSON.stringify(projected);
      for (const token of FORBIDDEN_PAYLOAD_TOKENS) {
        assert.ok(!serialized.includes(token), `the serialized payload must not contain ${token}`);
      }
      assert.ok(!/\bevidence\b/.test(serialized), 'no raw `evidence` field may cross the channel');
      assert.ok(!/C:\\\\|\/Users\/|\/home\//.test(serialized), 'no drive-letter or POSIX-absolute personal path');
      assert.ok(!/"https?:\/\//.test(serialized), 'no URL may cross the channel');

      assert.strictEqual(projected.storePath, CANONICAL_STORE_LABEL);
      assert.strictEqual(projected.rows.length, 1);
      const row = projected.rows[0] as unknown as Record<string, unknown>;
      assert.deepStrictEqual(
        Object.keys(row).sort(),
        ['calls', 'errors', 'excludedLatency', 'firstSeen', 'frames', 'lastSeen', 'latency', 'lowerBound', 'name', 'states', 'superseded'],
        'each row carries only the frozen per-row keys',
      );
      assert.strictEqual(row.name, 'browser.dom');
      assert.strictEqual(row.calls, 189);
    });

    it('keeps only synthetic census: evidenceRefs', () => {
      const { projectEnvelope, projectEvidenceRefs } = serviceModule();
      assert.deepStrictEqual(
        projectEvidenceRefs(['census:deadbeef#L12', 'C:\\store\\a.jsonl#L4', 'frame:anything', 'census:zz#L1']),
        ['census:deadbeef#L12'],
        'only /^census:[0-9a-f]{8,}#L\\d+$/ entries survive',
      );
      const projected = projectEnvelope(
        { ...rawFixtureEnvelope(), evidenceRefs: ['census:deadbeef#L12', 'C:\\store\\a.jsonl#L4'] },
        CANONICAL_STORE_LABEL,
      );
      assert.deepStrictEqual(projected.evidenceRefs, ['census:deadbeef#L12']);
      for (const ref of projected.evidenceRefs) {
        assert.match(ref, /^census:[0-9a-f]{8,}#L\d+$/);
      }
    });

    it('keeps timestamps, hashes and symbolic references verbatim while reducing locations', () => {
      // The predicate is the SHARED one: taken from the accounting module (which re-exports the
      // contracts), never from the service. A service-private copy would pass this test while
      // re-introducing the second source of truth the review flagged.
      const { isLocationShaped } = accountingModule();
      const { projectEnvelope, labeliseAffected, sanitizeProjectedValue } = serviceModule();

      // Real payload values that must survive: a false positive here corrupts published data.
      for (const value of [
        '2026-08-01T00:00:00.000Z',
        '2026-09-17T10:47:09.000Z',
        'token:not-a-location', // fictional on purpose: colon-bearing, but not a location
        'invocations',
        'browser.dom',
        'deadbeefdeadbeef',
      ]) {
        assert.strictEqual(isLocationShaped(value), false, `${value} is not a location and must not be reduced`);
      }
      // Location syntax, and only location syntax, is reduced.
      for (const value of [
        'E:\\Work\\.antifan-data\\control-plane-v2\\invocations',
        '/home/operator/.antifan-data',
        'C:',
        '\\\\server\\share\\x.jsonl',
        'file:///c:/store/a.jsonl',
      ]) {
        assert.strictEqual(isLocationShaped(value), true, `${value} is a location and must be reduced`);
      }

      // The per-row timestamps are the concrete regression this predicate exists to prevent.
      const projected = projectEnvelope(rawFixtureEnvelope(), CANONICAL_STORE_LABEL);
      const row = projected.rows[0] as unknown as Record<string, unknown>;
      assert.strictEqual(row.firstSeen, '2026-08-01T00:00:00.000Z');
      assert.strictEqual(row.lastSeen, '2026-09-17T00:00:00.000Z');
      assert.strictEqual(
        (projected.census as unknown as Record<string, unknown>).asOf,
        '2026-09-17T10:47:09.000Z',
      );
      assert.strictEqual(projected.asOf, '2026-09-17T10:47:09.000Z');

      assert.deepStrictEqual(
        labeliseAffected(['census-drift'], null),
        ['census-drift'],
        'a real frozen token passes through verbatim',
      );
      assert.deepStrictEqual(
        labeliseAffected(['token:not-a-location'], null),
        ['token:not-a-location'],
        'a fictional symbolic token is not reduced either',
      );
      assert.deepStrictEqual(
        sanitizeProjectedValue('2026-08-01T00:00:00.000Z', CANONICAL_STORE_LABEL),
        '2026-08-01T00:00:00.000Z',
        'a timestamp is not location-shaped',
      );
    });

    it('reduces location-shaped affected[] entries and keeps the closed token set', () => {
      const { projectEnvelope, labeliseAffected } = serviceModule();
      const projected = projectEnvelope(
        {
          ...rawFixtureEnvelope(),
          affected: ['E:\\Work\\.antifan-data\\control-plane-v2\\invocations', 'budget-expired', '/tmp/x'],
        },
        CANONICAL_STORE_LABEL,
      );
      assert.deepStrictEqual(projected.affected, [CANONICAL_STORE_LABEL, 'budget-expired']);
      assert.deepStrictEqual(
        labeliseAffected(['census-drift'], null),
        ['census-drift'],
        'a real frozen token passes through verbatim',
      );
      assert.deepStrictEqual(
        labeliseAffected(['token:not-a-location'], null),
        ['token:not-a-location'],
        'a fictional symbolic token is not reduced either',
      );
      assert.deepStrictEqual(
        labeliseAffected(['/root/store'], null),
        ['unresolved-store'],
        'a path with no resolved store reduces to the unresolved label, never the path',
      );
    });

    it('renders the unresolved storePath as a real null, never the text "null"', () => {
      const { projectEnvelope, mcpDispatchStoreLabel } = serviceModule();

      // The service's own canonical label is derived from the resolved directory, not spelled here,
      // and it is produced by a FUNCTION: a module-level constant would run the data-root probe at
      // import time (see the side-effect test below).
      assert.strictEqual(typeof mcpDispatchStoreLabel, 'function');
      const label = mcpDispatchStoreLabel();
      assert.strictEqual(typeof label, 'string');
      assert.ok(
        !(label as string).includes('/')
          && !(label as string).includes('\\')
          && !/^[A-Za-z]:/.test(label as string),
        'the canonical label must be separator-free by construction',
      );
      // Memoized: two calls are the same value without re-resolving.
      assert.strictEqual(mcpDispatchStoreLabel(), label);

      const projected = projectEnvelope({ ...rawFixtureEnvelope(), status: 'UNMEASURED', storePath: null }, null);
      assert.strictEqual(projected.storePath, null);
      assert.strictEqual(JSON.stringify(projected).includes('"storePath":null'), true);
      assert.ok(!JSON.stringify(projected).includes('"storePath":"null"'));

      // `null` in ⇒ `null` out for the boundary builder too. The token is the real frozen member
      // (`no-data-root-resolved`); the earlier spelling here was the stale `unresolved-data-root`,
      // which no member of `AffectedToken` produces and which survived the reducer only because the
      // fallback admits any separator-free, colon-free string.
      const refusal = serviceModule().unmeasuredBoundaryEnvelope('NO_DATA_ROOT_RESOLVED', ['no-data-root-resolved'], null);
      assert.strictEqual(refusal.storePath, null);
      assert.deepStrictEqual(refusal.affected, ['no-data-root-resolved']);

      // The projection derives the label from the raw storePath when the caller resolved none.
      const derived = projectEnvelope(
        { ...rawFixtureEnvelope(), storePath: 'E:\\Work\\.antifan-data\\control-plane-v2\\invocations' },
        null,
      );
      assert.strictEqual(derived.storePath, 'invocations');
    });

    it('passes fileRollups and census.limits through unchanged (one contract, two allowlists)', () => {
      const { projectEnvelope } = serviceModule();
      const projected = projectEnvelope(rawFixtureEnvelope(), CANONICAL_STORE_LABEL);
      assert.deepStrictEqual(projected.fileRollups, [
        { file: 'attachment-a.jsonl', quarantineLike: false, tempLike: false, frames: 3, admitted: 3, namedInvalid: 0 },
        { file: 'attachment-b.jsonl.quarantine-1', quarantineLike: true, tempLike: false, frames: 2, admitted: 1, namedInvalid: 1 },
      ]);
      const census = projected.census as unknown as Record<string, any>;
      assert.strictEqual(census.censusHash, 'deadbeefdeadbeef');
      assert.strictEqual(census.limits.windowNewestMtimeMs, 1_700_000_000_000);
      assert.strictEqual(census.limits.windowOldestMtimeMs, 1_600_000_000_000);
      assert.strictEqual(census.limits.outcome, 'COMPLETE');
      // `Census` has NO directory field (`shared/mcp-dispatch-contracts.ts:344-364`): the census
      // cannot spell "where the store is" at all, and the only "where" on the wire is `storePath`.
      assert.strictEqual('dir' in census, false, 'the contract census carries no directory field');
    });

    it('passes a non-null census through on an UNMEASURED envelope', () => {
      const { projectEnvelope } = serviceModule();
      const projected = projectEnvelope(
        { ...rawFixtureEnvelope(), status: 'UNMEASURED', reasonCode: 'CENSUS_DRIFT' },
        CANONICAL_STORE_LABEL,
      );
      assert.strictEqual(projected.status, 'UNMEASURED');
      assert.strictEqual(projected.reasonCode, 'CENSUS_DRIFT');
      // Census drift / a degenerate ceiling / a vanished store all publish a census with no rows:
      // a census beside UNMEASURED is data, not an inconsistency to scrub. The fixture carries one
      // row, so this asserts pass-through rather than emptiness.
      assert.notStrictEqual(projected.census, null);
      assert.strictEqual(projected.rows.length, 1);
      assert.strictEqual(
        (projected.census as unknown as Record<string, unknown>).censusHash,
        'deadbeefdeadbeef',
      );
    });

    it('drops forbidden nested keys instead of trusting the producer', () => {
      const { projectEnvelope, sanitizeProjectedValue } = serviceModule();
      const projected = projectEnvelope(
        {
          ...rawFixtureEnvelope(),
          totals: {
            admitted: 5,
            runtimePid: 4242,
            nested: { authoritySnapshot: { runtimeLeaseToken: 'lease-secret' }, requestId: 'req-1', evidence: ['x'] },
          },
          reconciliation: { lines: ['a == b'], requestId: 'req-2' },
        },
        CANONICAL_STORE_LABEL,
      );
      const serialized = JSON.stringify(projected);
      for (const token of [...FORBIDDEN_PAYLOAD_TOKENS, 'lease-secret', 'req-1', 'req-2']) {
        assert.ok(!serialized.includes(token), `nested forbidden value ${token} must not survive`);
      }
      const totals = projected.totals as unknown as Record<string, unknown>;
      assert.strictEqual(totals.admitted, 5, 'the aggregate number itself survives');
      assert.deepStrictEqual(projected.reconciliation, { lines: ['a == b'] });
      assert.deepStrictEqual(sanitizeProjectedValue({ ok: 1 }, 'label'), { ok: 1 });
    });
  });

  describe('memo (one entry, no TTL, asOf excluded from the key)', () => {
    /** A store directory whose metadata-only memo key is stable until a file is touched. */
    function makeTempStore(): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-mcp-memo-'));
      fs.writeFileSync(path.join(dir, 'attachment-a.jsonl'), '{"a":1}\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'attachment-b.jsonl.quarantine-1'), '{"b":2}\n', 'utf8');
      return dir;
    }

    it('serves the second call from the memo and returns the first pass asOf', async () => {
      const { McpDispatchService } = serviceModule();
      const dir = makeTempStore();
      let calls = 0;
      const service = new McpDispatchService({
        resolveStoreDir: () => dir,
        runPass: async ({ asOf }) => {
          calls += 1;
          return { ...rawFixtureEnvelope(), asOf };
        },
      });

      const first = await service.getState();
      const firstKey = service.getDiagnostics().memoKey;
      const second = await service.getState();

      assert.strictEqual(calls, 1, 'the second getState over an unchanged file set must not run a pass');
      assert.strictEqual(second.asOf, first.asOf, 'a memo hit returns the pass that produced it, not a fresh clock');
      assert.strictEqual(service.getDiagnostics().lastOutcome, 'memo-hit');
      assert.strictEqual(service.getDiagnostics().memoKey, firstKey);
      assert.strictEqual(service.getDiagnostics().hasMemoEntry, true);
    });

    it('evicts the single entry when the file set changes and clears on demand', async () => {
      const { McpDispatchService } = serviceModule();
      const dir = makeTempStore();
      let calls = 0;
      const service = new McpDispatchService({
        resolveStoreDir: () => dir,
        runPass: async ({ asOf }) => {
          calls += 1;
          return { ...rawFixtureEnvelope(), asOf };
        },
      });

      await service.getState();
      const firstKey = service.getDiagnostics().memoKey;

      // A content change at constant size still moves mtimeMs, which is in the key.
      fs.writeFileSync(path.join(dir, 'attachment-a.jsonl'), '{"a":9}\n', 'utf8');
      fs.utimesSync(path.join(dir, 'attachment-a.jsonl'), new Date(), new Date(Date.now() + 5_000));
      await service.getState();
      assert.strictEqual(calls, 2, 'a changed file set must evict the memo');
      assert.notStrictEqual(service.getDiagnostics().memoKey, firstKey);

      service.clearCache();
      assert.strictEqual(service.getDiagnostics().hasMemoEntry, false);
      assert.strictEqual(service.getDiagnostics().memoKey, null);
      await service.getState();
      assert.strictEqual(calls, 3, 'clearCache() forces a fresh pass');
    });

    it('degrades to a well-formed UNMEASURED envelope when the pass rejects', async () => {
      const { McpDispatchService } = serviceModule();
      const dir = makeTempStore();
      const service = new McpDispatchService({
        resolveStoreDir: () => dir,
        runPass: async () => { throw new Error('worker died'); },
      });
      const state = await service.getState();
      assert.strictEqual(state.status, 'UNMEASURED');
      assert.strictEqual(state.reasonCode, 'SERVICE_FAILED');
      assert.deepStrictEqual(state.rows, []);
      assert.strictEqual(state.census, null);
      assert.strictEqual(state.totals, null);
      assert.strictEqual(state.reconciliation, null);
      assert.strictEqual(service.getDiagnostics().lastOutcome, 'pass-failed');
    });
  });

  describe('hostile persisted strings as object keys (High: key-blind projection)', () => {
    it('renames a location-shaped histogram key and preserves the count, end to end', async () => {
      const { accountStore, UNRECOGNIZED_HISTOGRAM_KEY } = accountingModule();
      const { projectEnvelope } = serviceModule();

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-mcp-hostile-key-'));
      try {
        const HOSTILE_ERROR_CODE = 'C:\\Users\\Admin\\secrets';
        const frames = [
          invocationFrame({ error: { code: HOSTILE_ERROR_CODE, message: 'x' } }),
          invocationFrame({ error: { code: 'EXECUTION_TIMEOUT', message: 'y' } }),
        ];
        fs.writeFileSync(
          path.join(dir, 'attachment-a.jsonl'),
          frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n',
          'utf8',
        );

        // The REAL pass, not a fixture: the reader must be the thing that produces the key.
        const measured = await accountStore({ storeDir: dir, asOf: '2026-09-17T10:47:09.000Z' });
        assert.strictEqual(measured.status, 'MEASURED', 'the two frames must be admitted');

        const projected = projectEnvelope(measured, CANONICAL_STORE_LABEL);
        const row = projected.rows[0] as unknown as Record<string, unknown>;
        assert.ok(row, 'the two frames must produce one row');
        const errors = row.errors as Record<string, number>;

        assert.ok(
          !Object.keys(errors).includes(HOSTILE_ERROR_CODE),
          'the hostile path must not survive as an object key',
        );
        assert.strictEqual(
          errors[UNRECOGNIZED_HISTOGRAM_KEY],
          1,
          'the hostile key must collapse to the shared bucket',
        );
        assert.strictEqual(errors.EXECUTION_TIMEOUT, 1, 'a clean key is untouched');

        // Nothing anywhere in the serialized payload may be a location-shaped key.
        const serialized = JSON.stringify(projected);
        assert.ok(!serialized.includes('secrets'), 'no fragment of the hostile key may survive');
        assert.deepStrictEqual(
          collectLocationShapedKeys(projected),
          [],
          'no key anywhere in the payload may be location-shaped',
        );
        // …and the count is preserved by summation rather than dropped: one key, one frame.
        assert.strictEqual(
          Object.values(errors).reduce((sum, count) => sum + count, 0),
          2,
          'error counts must sum to the number of frames that carried an error',
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('sums counts when a hostile key collides with another hostile key', async () => {
      const { accountStore, UNRECOGNIZED_HISTOGRAM_KEY } = accountingModule();
      const { projectEnvelope } = serviceModule();

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-mcp-hostile-sum-'));
      try {
        const frames = [
          invocationFrame({ error: { code: 'C:\\leak\\one', message: 'a' } }),
          invocationFrame({ error: { code: 'D:\\leak\\two', message: 'b' } }),
          invocationFrame({ error: { code: '/var/lib/leak', message: 'c' } }),
        ];
        fs.writeFileSync(
          path.join(dir, 'attachment-a.jsonl'),
          frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n',
          'utf8',
        );

        const projected = projectEnvelope(
          await accountStore({ storeDir: dir, asOf: '2026-09-17T10:47:09.000Z' }),
          CANONICAL_STORE_LABEL,
        );
        const errors = (projected.rows[0] as unknown as Record<string, unknown>).errors as Record<string, number>;

        assert.deepStrictEqual(
          Object.keys(errors),
          [UNRECOGNIZED_HISTOGRAM_KEY],
          'three hostile keys must collapse onto the one shared bucket',
        );
        assert.strictEqual(
          errors[UNRECOGNIZED_HISTOGRAM_KEY],
          3,
          'colliding counts must be SUMMED, never dropped — a dropped count stops the row reconciling',
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rewrites a location-shaped key on any object, not only histograms', () => {
      const { projectEnvelope } = serviceModule();
      // Two DIFFERENT location-shaped keys that collapse onto the same bucket: built dynamically
      // because a literal cannot carry two identical keys (`TS1117`).
      const totals: Record<string, unknown> = { admitted: 5 };
      totals['E:\\Work\\.antifan-data'] = 1;
      totals['D:\\other\\store'] = 2;
      const projected = projectEnvelope(
        {
          ...rawFixtureEnvelope(),
          totals,
          reconciliation: { '\\\\server\\share': 1 },
        },
        CANONICAL_STORE_LABEL,
      );
      assert.deepStrictEqual(collectLocationShapedKeys(projected), []);
      const projectedTotals = projected.totals as unknown as Record<string, number>;
      assert.strictEqual(
        projectedTotals.UNRECOGNIZED,
        3,
        'two distinct location-shaped keys sum into the one bucket (1 + 2)',
      );
      assert.strictEqual(projectedTotals.admitted, 5);
      assert.strictEqual(
        projectedTotals['E:\\Work\\.antifan-data'],
        undefined,
        'no location-shaped key may be published',
      );
    });
  });

  describe('import edge is side-effect free (no filesystem I/O on require)', () => {
    it('requires the compiled service without creating or writing anything', () => {
      const fsModule = require('node:fs') as Record<string, unknown>;
      const watched = ['mkdirSync', 'mkdir', 'writeFileSync', 'writeFile', 'unlinkSync', 'unlink', 'rmSync', 'rm'] as const;
      const originals = new Map<string, unknown>();
      const calls: string[] = [];

      for (const name of watched) {
        const original = fsModule[name];
        if (typeof original !== 'function') continue;
        originals.set(name, original);
        fsModule[name] = (...args: unknown[]) => {
          calls.push(`${name}(${String(args[0])})`);
          return (original as (...a: unknown[]) => unknown)(...args);
        };
      }

      try {
        const servicePath = require.resolve('../../src/main/diagnostics/mcp-dispatch-service');
        delete require.cache[servicePath];
        const fresh = require(servicePath) as McpDispatchServiceModule;

        assert.deepStrictEqual(
          calls,
          [],
          `importing the service must touch no filesystem: ${calls.join(', ')}`,
        );
        // The retired constant would have forced the data-root probe at import time.
        assert.strictEqual(
          (fresh as unknown as Record<string, unknown>).MCP_DISPATCH_STORE_LABEL,
          undefined,
          'the module must no longer publish an import-time label constant',
        );
        assert.strictEqual(typeof fresh.mcpDispatchStoreLabel, 'function', 'the lazy accessor must exist');
        assert.deepStrictEqual(calls, [], 'resolving the label lazily must not happen at import either');

        // The label is produced on demand, memoized, and separator-free.
        const label = fresh.mcpDispatchStoreLabel();
        assert.strictEqual(typeof label, 'string');
        assert.ok(label && !label.includes('/') && !label.includes('\\'));
        assert.strictEqual(fresh.mcpDispatchStoreLabel(), label, 'the label is memoized');
      } finally {
        for (const [name, original] of originals) {
          if (typeof original === 'function') fsModule[name] = original;
        }
      }
    });
  });

  describe('key sets agree with the shipped gate (drift must fail a test, not the payload)', () => {
    it('matches the gate allowlists exactly', () => {
      const gateSource = fs.readFileSync(path.join(root, 'scripts', 'check-mcp-dispatch-payload.mjs'), 'utf8');
      const readGateList = (constName: string): string[] => {
        const pattern = new RegExp(`const ${constName} = \\[([\\s\\S]*?)\\];`);
        const match = gateSource.match(pattern);
        assert.ok(match, `the gate must still declare ${constName}`);
        if (!match) throw new Error('unreachable');
        // Comma-split, not line-split: the gate writes some lists one-per-line and others on a single
        // line, and a line-split silently produced one bogus long entry for the single-line ones.
        return String(match[1] ?? '')
          .split(',')
          .map((entry) => entry.replace(/\/\/[^\n]*/g, '').replace(/['"\s]/g, ''))
          .filter((entry) => entry.length > 0);
      };

      const sets = serviceModule().MCP_DISPATCH_KEY_SETS;
      assert.deepStrictEqual(
        [...sets.envelope].sort(),
        readGateList('TOP_LEVEL_ALLOWLIST').sort(),
        'the published envelope keys must equal the gate top-level allowlist',
      );
      assert.deepStrictEqual(
        [...sets.row].sort(),
        readGateList('ROW_ALLOWLIST').sort(),
        'the row keys must equal the gate row allowlist',
      );
      assert.deepStrictEqual(
        [...sets.fileRollup].sort(),
        readGateList('FILE_ROLLUP_ALLOWLIST').sort(),
        'the roll-up keys must be EXACTLY the gate six — a superset would be published then rejected',
      );
      // The gate has no census lists yet; fix our own side so a future addition is a decision.
      assert.deepStrictEqual(
        [...sets.census].sort(),
        [
          'asOf', 'files', 'fileCount', 'jsonlCount', 'quarantineCount', 'tempCount',
          'otherCount', 'totalBytes', 'censusHash', 'limits',
        ].sort(),
        'the census container key set is frozen here and has no directory field',
      );
      assert.deepStrictEqual(
        [...sets.censusEntry].sort(),
        ['name', 'bucket', 'size', 'mtimeMs', 'lineCount', 'sha256', 'consistency'].sort(),
        'the census entry key set is frozen here',
      );
    });

    it('projects a roll-up with exactly the gate six keys and no more', () => {
      const { projectEnvelope } = serviceModule();
      const projected = projectEnvelope(
        {
          ...rawFixtureEnvelope(),
          fileRollups: [{
            file: 'attachment-a.jsonl',
            quarantineLike: false,
            tempLike: false,
            frames: 3,
            admitted: 3,
            namedInvalid: 0,
            // Keys a future `FileRollup` addition might introduce: they must NOT be published,
            // because the gate allows six and would reject the payload we produced.
            lineCount: 3,
            sha256: 'a'.repeat(64),
            consistency: 'clean',
            runtimePid: 4242,
          }],
        },
        CANONICAL_STORE_LABEL,
      );
      assert.deepStrictEqual(
        Object.keys(projected.fileRollups[0] as unknown as Record<string, unknown>).sort(),
        ['admitted', 'file', 'frames', 'namedInvalid', 'quarantineLike', 'tempLike'],
      );
    });
  });

  describe('reasonCode is admitted by membership, never copied (Medium)', () => {
    it('substitutes SERVICE_FAILED for a path-shaped or unknown reasonCode', () => {
      const { UnmeasuredReason } = accountingModule();
      const { projectEnvelope, sanitiseReasonCode } = serviceModule();

      assert.strictEqual(sanitiseReasonCode('C:\\leak\\reason'), UnmeasuredReason.SERVICE_FAILED);
      assert.strictEqual(sanitiseReasonCode('NOT_A_REASON'), UnmeasuredReason.SERVICE_FAILED);
      assert.strictEqual(sanitiseReasonCode(42), UnmeasuredReason.SERVICE_FAILED);
      assert.strictEqual(sanitiseReasonCode(undefined), UnmeasuredReason.SERVICE_FAILED);
      assert.strictEqual(sanitiseReasonCode('NO_DATA'), 'NO_DATA', 'a real enum member passes');
      assert.strictEqual(sanitiseReasonCode('OK'), 'OK', 'the MEASURED literal passes');

      const projected = projectEnvelope(
        { ...rawFixtureEnvelope(), status: 'MEASURED', reasonCode: 'C:\\leak\\reason' },
        CANONICAL_STORE_LABEL,
      );
      assert.strictEqual(projected.reasonCode, UnmeasuredReason.SERVICE_FAILED);
      assert.ok(!JSON.stringify(projected).includes('leak'), 'no fragment of the path may survive');

      const unknown = projectEnvelope(
        { ...rawFixtureEnvelope(), reasonCode: 'TOTALLY_INVENTED' },
        CANONICAL_STORE_LABEL,
      );
      assert.strictEqual(unknown.reasonCode, UnmeasuredReason.SERVICE_FAILED);
    });
  });

  describe('well-formed UNMEASURED envelope (never null)', () => {
    it('returns the single frozen shape for every reason', () => {
      const { unmeasuredBoundaryEnvelope } = serviceModule();
      const reasons = [
        'NO_DATA_ROOT_RESOLVED', 'NO_DATA', 'DIR_UNREADABLE', 'CENSUS_DRIFT',
        'READ_BUDGET_EXCEEDED', 'POPULATION_TRUNCATED', 'SERVICE_FAILED',
      ] as const;
      for (const reason of reasons) {
        const envelope = unmeasuredBoundaryEnvelope(reason, ['service-failed'], CANONICAL_STORE_LABEL);
        assert.strictEqual(envelope.status, 'UNMEASURED', `${reason} must be UNMEASURED`);
        assert.strictEqual(envelope.reasonCode, reason, `${reason} must travel in reasonCode`);
        assert.deepStrictEqual(envelope.rows, [], `${reason} must have no rows (no 0 for missing data)`);
        assert.deepStrictEqual(envelope.fileRollups, [], `${reason} must have no roll-ups`);
        assert.strictEqual(envelope.census, null, `${reason} must not fabricate a census`);
        assert.strictEqual(envelope.totals, null, `${reason} must not fabricate totals`);
        assert.strictEqual(envelope.reconciliation, null, `${reason} must not fabricate invariants`);
        assert.deepStrictEqual(envelope.evidenceRefs, []);
        assert.ok(typeof envelope.asOf === 'string' && envelope.asOf.length > 0);
        assert.ok(!JSON.stringify(envelope).includes('\\'), 'no backslash may appear in the refusal');
      }
    });

    it('refuses a location-shaped affected entry passed due to a service failure', () => {
      const { unmeasuredBoundaryEnvelope } = serviceModule();
      const envelope = unmeasuredBoundaryEnvelope(
        'SERVICE_FAILED',
        ['service-failed', 'Error: ENOENT at E:\\Work\\.antifan-data\\control-plane-v2\\invocations'],
        CANONICAL_STORE_LABEL,
      );
      assert.ok(
        !JSON.stringify(envelope).includes('E:\\\\'),
        'a location-shaped failure message must be reduced before it crosses IPC',
      );
      assert.deepStrictEqual(envelope.affected, ['service-failed', CANONICAL_STORE_LABEL]);
    });

    it('reduces a synthetic ENOENT error end to end, keeping the closed tokens verbatim', async () => {
      const { McpDispatchService } = serviceModule();
      // A service over a real (temp) store, whose pass producer throws the exact shape an ENOENT on
      // the live store produces: a message carrying an absolute drive-letter path.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-mcp-enoent-'));
      fs.writeFileSync(path.join(dir, 'attachment-a.jsonl'), '{"a":1}\n', 'utf8');
      const enoent = Object.assign(
        new Error("ENOENT: no such file or directory, stat 'E:\\Work\\.antifan-data\\control-plane-v2\\invocations\\attachment-a.jsonl'"),
        { code: 'ENOENT', path: 'E:\\Work\\.antifan-data\\control-plane-v2\\invocations\\attachment-a.jsonl' },
      );

      // Path 1: the service's own failure path. The resolved store is a temp directory, so the label
      // is that segment; the failure entry collapses onto it and only one closed token remains.
      const failing = new McpDispatchService({
        resolveStoreDir: () => dir,
        runPass: async () => { throw enoent; },
      });
      const envelope = await failing.getState();
      const serialized = JSON.stringify(envelope);
      assert.ok(!serialized.includes('E:'), 'no drive letter may survive the failure path');
      assert.ok(!serialized.includes('Work'), 'no path segment may survive the failure path');
      assert.ok(!/[A-Za-z]:[\\/]/.test(serialized), 'no drive-letter-prefixed path may survive');
      assert.ok(!serialized.includes('\\'), 'no separator may survive the failure path');
      assert.deepStrictEqual(envelope.affected, ['service-failed']);
      assert.notStrictEqual(envelope.storePath, dir, 'the absolute store directory must not be the label');
      assert.strictEqual(
        envelope.storePath,
        failing.getStoreLabel(),
        'the label is the resolved store final segment',
      );
      assert.ok(
        typeof envelope.storePath === 'string'
          && envelope.storePath.length > 0
          && !/[A-Za-z]:/.test(envelope.storePath)
          && !envelope.storePath.includes('\\')
          && !envelope.storePath.includes('/'),
        'the label is separator-free by construction — the module returns the final segment only',
      );

      // Path 2: the same error string handed to the boundary builder (the IPC refusal / catch form).
      const { unmeasuredBoundaryEnvelope } = serviceModule();
      const fromString = unmeasuredBoundaryEnvelope(
        'SERVICE_FAILED',
        ['service-failed', String(enoent)],
        CANONICAL_STORE_LABEL,
      );
      const fromStringSerialized = JSON.stringify(fromString);
      assert.ok(!fromStringSerialized.includes('E:'), 'no drive letter via the String(err) form');
      assert.ok(!fromStringSerialized.includes('Work'), 'no path segment via the String(err) form');
      assert.ok(!fromStringSerialized.includes('\\'), 'no separator via the String(err) form');
      assert.deepStrictEqual(fromString.affected, ['service-failed', CANONICAL_STORE_LABEL]);

      // The margin's closed-enum reasons are deliberately NOT routed through the affected reducer.
      const { projectEnvelope } = serviceModule();
      const projected = projectEnvelope(rawFixtureEnvelope(), CANONICAL_STORE_LABEL);
      assert.deepStrictEqual(
        projected.totals.quarantineMargin.reasons,
        ['writer-canonicalization-array-slot'],
        'margin reasons are closed-enum tokens and must pass through verbatim',
      );
    });
  });
});

/** Strip `//` and block comments so a source-text assertion cannot be satisfied by prose. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Every object key anywhere in `value` that is location-shaped, as `trail`-qualified strings.
 *
 * The High defect was that only *values* were inspected; this is the assertion that would have caught
 * it, so it walks keys too. The predicate is the shared one, not a local regex.
 */
function collectLocationShapedKeys(value: unknown, trail = 'payload'): string[] {
  const { isLocationShaped } = accountingModule();
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...collectLocationShapedKeys(item, `${trail}[${index}]`)));
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isLocationShaped(key)) found.push(`${trail}.${key}`);
    found.push(...collectLocationShapedKeys(child, `${trail}.${key}`));
  }
  return found;
}

/**
 * One checksum-valid invocation frame, exactly as the ledger writes it
 * (`invocation-ledger.ts:392-407` shape + the checksum the reader re-computes at `:433`).
 *
 * The checksum is computed by the product's own `computeFrameChecksum`, so the frame really does pass
 * structural admission — which is the point of the hostile-key test: `error.code` is persisted,
 * unvalidated by admission, and reaches the projection as a JSON **key**.
 */
function invocationFrame(overrides: { state?: string; error?: { code: string; message: string } } = {}): Record<string, unknown> {
  const { computeFrameChecksum } = checksumModule();
  const record: Record<string, unknown> = {
    formatVersion: 1,
    id: `invocation-${Math.random().toString(16).slice(2, 10)}`,
    attachmentId: 'attachment-a',
    requestId: 'request-1',
    idempotencyKey: 'idem-1',
    name: 'browser.dom',
    paramDigest: 'a'.repeat(64),
    policyDigest: 'b'.repeat(64),
    policyVersion: 1,
    recordedVisibility: 'public',
    state: overrides.state ?? 'failed',
    dispatchStage: 'pre_dispatch',
    authoritySnapshot: {
      attachmentId: 'attachment-a',
      authorityRevision: 'revision-1',
      revisionNumber: 1,
      projectId: 'project-1',
      runId: 'run-1',
      attemptId: 'attempt-1',
      backendId: 'backend-1',
      grant: 'read',
      hostEpoch: 1,
      runtimePid: 4242,
      leaseExpiresAt: 1_700_000_000_000,
      issuedAt: 1_700_000_000_000,
    },
    createdAt: 1_700_000_000_000,
    settledAt: 1_700_000_001_000,
  };
  if (overrides.error) record.error = overrides.error;
  record.checksum = computeFrameChecksum(record);
  return record;
}

/** Extract one function's body by brace matching from its declaration line. */
function extractFunctionBody(source: string, declarationPrefix: string): string {
  const start = source.indexOf(declarationPrefix);
  if (start < 0) return '';
  const open = source.indexOf('{', start);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

/**
 * A raw envelope exactly as the worker would post it: it carries every field constraint D forbids
 * on the wire — an `authoritySnapshot` with a lease token, a pid, a request id, param/policy digests,
 * an attachment id, an idempotency key and free-form `evidence` — plus absolute paths inside `dir`
 * and a store path that is the real absolute directory. The projection must remove all of it.
 */
function rawFixtureEnvelope(): Record<string, unknown> {
  return {
    status: 'MEASURED',
    reasonCode: 'ADMITTED_FRAMES_PRESENT',
    affected: ['E:\\Work\\.antifan-data\\control-plane-v2\\invocations'],
    evidenceRefs: ['census:deadbeef#L12', 'attachment-a.jsonl#L3'],
    asOf: '2026-09-17T10:47:09.000Z',
    storePath: 'E:\\Work\\.antifan-data\\control-plane-v2\\invocations',
    census: {
      asOf: '2026-09-17T10:47:09.000Z',
      files: [
        {
          name: 'attachment-a.jsonl',
          bucket: 'jsonl',
          size: 2048,
          mtimeMs: 1_700_000_000_000,
          lineCount: 3,
          sha256: 'a'.repeat(64),
          consistency: 'clean',
          // Forbidden leftovers a naive pass-through would forward:
          runtimeLeaseToken: 'lease-secret',
          attachmentId: 'attachment-a',
        },
      ],
      fileCount: 2,
      jsonlCount: 1,
      quarantineCount: 1,
      tempCount: 0,
      otherCount: 0,
      totalBytes: 4096,
      censusHash: 'deadbeefdeadbeef',
      limits: {
        budgetMs: 20000,
        maxBytes: 536870912,
        maxFiles: 4096,
        observedBytes: 4096,
        observedFiles: 2,
        filesRead: 2,
        filesSkipped: 0,
        ceiling: null,
        windowNewestMtimeMs: 1_700_000_000_000,
        windowOldestMtimeMs: 1_600_000_000_000,
        elapsedMs: 12,
        outcome: 'COMPLETE',
      },
    },
    fileRollups: [
      { file: 'attachment-a.jsonl', quarantineLike: false, tempLike: false, frames: 3, admitted: 3, namedInvalid: 0 },
      { file: 'attachment-b.jsonl.quarantine-1', quarantineLike: true, tempLike: false, frames: 2, admitted: 1, namedInvalid: 1 },
    ],
    rows: [
      {
        name: 'browser.dom',
        calls: 189,
        frames: 191,
        superseded: 2,
        states: { completed: 187, failed: 2, interrupted: 2 },
        errors: { EXECUTION_TIMEOUT: 2 },
        latency: { p50Ms: 13, p95Ms: 3799, count: 189 },
        excludedLatency: { p50Ms: 262957, p95Ms: 2427228, count: 3 },
        firstSeen: '2026-08-01T00:00:00.000Z',
        lastSeen: '2026-09-17T00:00:00.000Z',
        lowerBound: false,
        // A raw frame field smuggled onto the row:
        authoritySnapshot: { runtimeLeaseToken: 'lease-secret', runtimePid: 4242 },
      },
    ],
    totals: {
      admitted: 191,
      quarantineMargin: {
        label: 'quarantine margin: 2 frames present, 1 admitted, 1 named-invalid (margin, not recovery)',
        files: 1,
        framesPresent: 2,
        framesAdmitted: 1,
        framesNamedInvalid: 1,
        reasons: ['writer-canonicalization-array-slot'],
      },
      truncation: null,
    },
    reconciliation: {
      classifiedKeys: 190,
      unattributedKeys: 1,
      compositeKeys: 191,
      keylessFrames: 0,
      superseded: 2,
      holdsKeys: true,
      holdsFrames: true,
      holdsMargin: true,
      lines: [
        'classifiedKeys + unattributedKeys == compositeKeys',
        'frames == compositeKeys + superseded + keylessFrames',
      ],
    },
  };
}

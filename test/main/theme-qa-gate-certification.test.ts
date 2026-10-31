/**
 * What may clear the theme-qa-gate: a complete, root-matching CERTIFIED pass, an annotation-scoped
 * pass, or a declared `QA_STRUCTURAL_ONLY` backed by a complete STRUCTURAL receipt (which leaves
 * debt only a CERTIFIED receipt removes). Real fs, the shipped hook source, no Electron.
 */
import { describe, it, after, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import themeQaGate, { type HookAPI } from '../../src/omp-hooks/theme-qa-gate';

type Handler = (...args: unknown[]) => unknown;
type HookCall = (event: string, ...args: unknown[]) => unknown;
interface DebtRecord {
  root: string;
  since: number;
  files: string[];
  kind?: string;
}

const scratch: string[] = [];
const savedEnv: Record<string, string | undefined> = {
  ANTIFAN_EDIT_MODE: process.env.ANTIFAN_EDIT_MODE,
  ANTIFAN_DATA_ROOT: process.env.ANTIFAN_DATA_ROOT,
  ANTIFAN_CONFIG_DIR: process.env.ANTIFAN_CONFIG_DIR,
};

beforeEach(() => {
  delete process.env.ANTIFAN_EDIT_MODE;
  delete process.env.ANTIFAN_DATA_ROOT;
  const emptyConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cert-config-'));
  scratch.push(emptyConfig);
  process.env.ANTIFAN_CONFIG_DIR = emptyConfig;
});

after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function loadHook(): HookCall {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    sendMessage: () => {},
    appendEntry: () => {},
  } as unknown as HookAPI;
  themeQaGate(pi);
  return (event, ...args) => {
    const handler = handlers.get(event);
    assert.ok(handler, `hook registers ${event}`);
    return handler(...args);
  };
}

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cert-ws-'));
  scratch.push(root);
  fs.mkdirSync(path.join(root, '.antifan', 'annotations'), { recursive: true });
  fs.mkdirSync(path.join(root, '.antifan', 'qa-receipts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sections'), { recursive: true });
  return root;
}

const debtPath = (root: string) => path.join(root, '.antifan', 'qa-debt.json');

function writeReceipt(root: string, name: string, body: Record<string, unknown>, mtimeMs: number): void {
  const file = path.join(root, '.antifan', 'qa-receipts', name);
  fs.writeFileSync(file, JSON.stringify(body), 'utf8');
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

const base = (root: string): Record<string, unknown> => ({
  receiptVersion: '1.2',
  workspaceRoot: root,
  verdict: 'QA_PASSED',
  passed: true,
  execution: 'COMPLETED',
  errorCode: null,
});
const certified = (root: string): Record<string, unknown> => ({
  ...base(root),
  certification: 'CERTIFIED',
  certificationBasis: 'greenfield',
  scope: 'certified',
});
const structural = (root: string): Record<string, unknown> => ({
  ...base(root),
  certification: 'STRUCTURAL',
  certificationReasons: ['no baseline for 375px'],
  scope: 'structural',
});

function armGate(call: HookCall, root: string): object {
  const ctx = { cwd: root };
  call('session_start', undefined, ctx);
  call('tool_call', { toolName: 'write', input: { path: path.join(root, 'sections', 'hero.liquid') } }, ctx);
  return ctx;
}

function resultText(res: unknown): string {
  if (!res || typeof res !== 'object' || !('content' in res)) return '';
  const content = res.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) => {
      if (typeof part === 'string') return part;
      return part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : '';
    })
    .join('\n');
}

/** The first mutation result after a receipt lands: it reconciles, then reminds iff the gate is still armed. */
function stillPending(call: HookCall, ctx: object): boolean {
  return resultText(call('tool_result', { toolName: 'write', content: 'ok' }, ctx)).includes('QA GATE PENDING');
}

const fresh = () => Date.now() + 5_000;

function declare(call: HookCall, ctx: object, token: string): void {
  call('context', { messages: [{ role: 'assistant', content: `Done locally. ${token}`, timestamp: Date.now() + 1_000 }] }, ctx);
}

function readDebt(root: string): DebtRecord {
  const parsed: DebtRecord = JSON.parse(fs.readFileSync(debtPath(root), 'utf8'));
  return parsed;
}

describe('which receipts clear the gate', () => {
  it('a complete CERTIFIED pass for the root clears it', () => {
    const call = loadHook();
    const root = makeRoot();
    const ctx = armGate(call, root);
    writeReceipt(root, 'r.json', certified(root), fresh());
    assert.strictEqual(stillPending(call, ctx), false);
  });

  it('a STRUCTURAL pass leaves the gate pending and prints why it is not certified', () => {
    const call = loadHook();
    const root = makeRoot();
    const ctx = armGate(call, root);
    writeReceipt(root, 'r.json', structural(root), fresh());
    const reminder = resultText(call('tool_result', { toolName: 'write', content: 'ok' }, ctx));
    assert.ok(reminder.includes('QA GATE PENDING'), reminder);
    assert.ok(reminder.includes('STRUCTURAL PASS, not CERTIFIED: no baseline for 375px'), reminder);
    assert.ok(reminder.includes('anti.visual.promote_baseline'), reminder);
    assert.ok(reminder.includes('QA_STRUCTURAL_ONLY'), reminder);
    assert.ok(!/qaStatus\s*:/.test(reminder), 'the reminder must not reproduce a declaration the gate matches');
  });

  it('a bare QA_PASSED with STRUCTURAL certification on a clean fixture leaves the gate pending', () => {
    const call = loadHook();
    const root = makeRoot();
    const ctx = armGate(call, root);
    writeReceipt(root, 'r.json', { ...base(root), certification: 'STRUCTURAL', coverage: { measured: 5, expected: 5 } }, fresh());
    assert.strictEqual(stillPending(call, ctx), true);
  });

  it('a CERTIFIED receipt for another root does not clear it', () => {
    const call = loadHook();
    const root = makeRoot();
    const ctx = armGate(call, root);
    writeReceipt(root, 'r.json', certified('C:/some/other-theme'), fresh());
    assert.strictEqual(stillPending(call, ctx), true);
  });

  it('a CERTIFIED receipt with partial coverage does not clear it', () => {
    const call = loadHook();
    const root = makeRoot();
    const ctx = armGate(call, root);
    writeReceipt(root, 'r.json', { ...certified(root), coverage: { measured: 2, expected: 5 } }, fresh());
    assert.strictEqual(stillPending(call, ctx), true);
  });

  it('a receipt carrying no verdict does not clear it', () => {
    const call = loadHook();
    const root = makeRoot();
    const ctx = armGate(call, root);
    writeReceipt(root, 'r.json', { receiptVersion: '1.2', workspaceRoot: root, passed: true, execution: 'COMPLETED', errorCode: null }, fresh());
    assert.strictEqual(stillPending(call, ctx), true);
  });

  it('a QA_PASSED receipt that records no certification does not clear it', () => {
    const call = loadHook();
    const root = makeRoot();
    const ctx = armGate(call, root);
    writeReceipt(root, 'r.json', base(root), fresh());
    assert.strictEqual(stillPending(call, ctx), true);
  });

  describe('annotation-scoped pass', () => {
    const annotationId = 'annotation_1792003171976';
    const seedAnnotation = (root: string) =>
      fs.writeFileSync(
        path.join(root, '.antifan', 'annotations', 'element_1792003171976.md'),
        `---\nannotation_id: "${annotationId}"\n---\n- Element Selector: \`#limited-edition\`\n`,
        'utf8',
      );

    it('a complete annotation-scoped pass for an annotation that predates the edit clears it', () => {
      const call = loadHook();
      const root = makeRoot();
      seedAnnotation(root);
      const ctx = armGate(call, root);
      writeReceipt(root, 'r.json', { ...structural(root), scope: 'annotation', annotationId, scopedCriticalCount: 0 }, fresh());
      assert.strictEqual(stillPending(call, ctx), false);
    });

    it('a failing run with zero scoped criticals for a pre-existing annotation clears it', () => {
      const call = loadHook();
      const root = makeRoot();
      seedAnnotation(root);
      const ctx = armGate(call, root);
      writeReceipt(
        root,
        'r.json',
        { ...base(root), verdict: 'QA_FAILED', passed: false, annotationId, pageCriticalCount: 3, scopedCriticalCount: 0 },
        fresh(),
      );
      assert.strictEqual(stillPending(call, ctx), false);
    });

    it('a pass that claims annotation scope but has scoped criticals does not clear it', () => {
      const call = loadHook();
      const root = makeRoot();
      seedAnnotation(root);
      const ctx = armGate(call, root);
      writeReceipt(root, 'r.json', { ...structural(root), scope: 'annotation', annotationId, scopedCriticalCount: 1 }, fresh());
      assert.strictEqual(stillPending(call, ctx), true);
    });

    it('an annotation written after the edit cannot scope a pass', () => {
      const call = loadHook();
      const root = makeRoot();
      const ctx = armGate(call, root);
      seedAnnotation(root);
      writeReceipt(root, 'r.json', { ...structural(root), scope: 'annotation', annotationId, scopedCriticalCount: 0 }, fresh());
      assert.strictEqual(stillPending(call, ctx), true);
    });

    it('a pass with annotation scope but for another root does not clear it', () => {
      const call = loadHook();
      const root = makeRoot();
      seedAnnotation(root);
      const ctx = armGate(call, root);
      writeReceipt(
        root,
        'r.json',
        { ...structural('C:/some/other-theme'), scope: 'annotation', annotationId, scopedCriticalCount: 0 },
        fresh(),
      );
      assert.strictEqual(stillPending(call, ctx), true);
    });
  });
});

describe('QA_STRUCTURAL_ONLY', () => {
  it('without any receipt is rejected and the gate stays pending', () => {
    const call = loadHook();
    const root = makeRoot();
    const ctx = armGate(call, root);
    declare(call, ctx, 'qaStatus: QA_STRUCTURAL_ONLY');
    assert.strictEqual(stillPending(call, ctx), true);
    assert.ok(!fs.existsSync(debtPath(root)), 'a rejected declaration leaves no debt');
  });

  it('with a complete STRUCTURAL receipt newer than the edit clears the gate and persists structural-only debt', () => {
    const call = loadHook();
    const root = makeRoot();
    const before = Date.now();
    const ctx = armGate(call, root);
    writeReceipt(root, 'r.json', structural(root), fresh());

    declare(call, ctx, 'qaStatus: QA_STRUCTURAL_ONLY');

    assert.strictEqual(stillPending(call, ctx), false);
    const debt = readDebt(root);
    assert.strictEqual(debt.kind, 'structural-only');
    assert.deepStrictEqual(debt.files, ['sections/hero.liquid']);
    assert.ok(debt.since >= before && debt.since <= Date.now(), 'since is the time of the unverified edit');
  });

  it('with the unspaced token spelling behaves the same', () => {
    const call = loadHook();
    const root = makeRoot();
    const ctx = armGate(call, root);
    writeReceipt(root, 'r.json', structural(root), fresh());
    declare(call, ctx, 'qaStatus:QA_STRUCTURAL_ONLY');
    assert.strictEqual(stillPending(call, ctx), false);
    assert.strictEqual(readDebt(root).kind, 'structural-only');
  });

  const rejected: Array<[string, (root: string) => Record<string, unknown>, number]> = [
    ['older than the edit', structural, Date.now() - 60_000],
    ['another workspace root', () => structural('C:/some/other-theme'), Date.now() + 5_000],
    ['partial coverage', (root) => ({ ...structural(root), coverage: { measured: 1, expected: 5 } }), Date.now() + 5_000],
    ['degraded execution', (root) => ({ ...structural(root), execution: 'DEGRADED' }), Date.now() + 5_000],
    ['QA_FAILED', (root) => ({ ...structural(root), verdict: 'QA_FAILED', passed: false }), Date.now() + 5_000],
    ['an unmarked certification', base, Date.now() + 5_000],
    ['a settings regression', (root) => ({ ...structural(root), settingsRatchet: { ok: false, findings: [] } }), Date.now() + 5_000],
  ];
  for (const [label, build, mtime] of rejected) {
    it(`is rejected against a receipt with ${label}`, () => {
      const call = loadHook();
      const root = makeRoot();
      const ctx = armGate(call, root);
      writeReceipt(root, 'r.json', build(root), mtime);
      declare(call, ctx, 'qaStatus: QA_STRUCTURAL_ONLY');
      assert.strictEqual(stillPending(call, ctx), true);
      assert.ok(!fs.existsSync(debtPath(root)));
    });
  }

  it('a declaration made before the edit cannot clear the gate', () => {
    const call = loadHook();
    const root = makeRoot();
    const ctx = armGate(call, root);
    writeReceipt(root, 'r.json', structural(root), fresh());
    call('context', { messages: [{ role: 'assistant', content: 'qaStatus: QA_STRUCTURAL_ONLY', timestamp: Date.now() - 60_000 }] }, ctx);
    assert.strictEqual(stillPending(call, ctx), true);
  });

  it('a declaration from a tool result does not clear the gate', () => {
    const call = loadHook();
    const root = makeRoot();
    const ctx = armGate(call, root);
    writeReceipt(root, 'r.json', structural(root), fresh());
    call('context', { messages: [{ role: 'tool', content: 'qaStatus: QA_STRUCTURAL_ONLY', timestamp: Date.now() + 1_000 }] }, ctx);
    assert.strictEqual(stillPending(call, ctx), true);
  });

  it('the structural debt is removed only by a CERTIFIED receipt newer than the edit', () => {
    const call = loadHook();
    const root = makeRoot();
    const ctx = armGate(call, root);
    writeReceipt(root, 'structural.json', structural(root), fresh());
    declare(call, ctx, 'qaStatus: QA_STRUCTURAL_ONLY');
    assert.ok(fs.existsSync(debtPath(root)));

    writeReceipt(root, 'structural-again.json', structural(root), fresh() + 5_000);
    call('context', { messages: [] }, ctx);
    assert.ok(fs.existsSync(debtPath(root)), 'a newer STRUCTURAL receipt does not settle structural-only debt');

    writeReceipt(root, 'annotation-scoped.json', { ...structural(root), scope: 'annotation', annotationId: 'annotation_1', scopedCriticalCount: 0 }, fresh() + 8_000);
    call('context', { messages: [] }, ctx);
    assert.ok(fs.existsSync(debtPath(root)), 'an annotation-scoped pass does not settle structural-only debt');

    writeReceipt(root, 'certified.json', certified(root), fresh() + 10_000);
    call('context', { messages: [] }, ctx);
    assert.ok(!fs.existsSync(debtPath(root)), 'a CERTIFIED receipt settles it');
  });

  it('the structural-only debt survives into the next session and is named in the reminder', () => {
    const first = loadHook();
    const root = makeRoot();
    const ctx = armGate(first, root);
    writeReceipt(root, 'r.json', structural(root), fresh());
    declare(first, ctx, 'qaStatus: QA_STRUCTURAL_ONLY');

    const next = loadHook();
    next('session_start', undefined, ctx);
    next('tool_call', { toolName: 'write', input: { path: path.join(root, 'sections', 'footer.liquid') } }, ctx);
    const reminder = resultText(next('tool_result', { toolName: 'write', content: 'ok' }, ctx));
    assert.ok(reminder.includes('Open QA debt'), reminder);
    assert.ok(reminder.includes('[structural-only]'), reminder);
    assert.ok(reminder.includes('sections/hero.liquid'), reminder);
  });
});

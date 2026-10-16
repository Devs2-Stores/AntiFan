/**
 * QA debt persistence of the theme-qa-gate hook.
 *
 * A Direct-Edit/Super-Fast session edits theme files and never produces a passing receipt, so
 * nothing in the workspace says the storefront is unverified. The hook leaves
 * `<root>/.antifan/qa-debt.json` ({ root, since, files[] } — the shape the kit gate reads), the
 * next session carries it into the reminder, and only a complete passing receipt that is newer
 * (file mtime) than `since` removes it. Real fs, the shipped hook source, no Electron.
 */
import { describe, it, after, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import themeQaGate, { type HookAPI } from '../../src/omp-hooks/theme-qa-gate';

type Handler = (...args: unknown[]) => unknown;
type HookCall = (event: string, ...args: unknown[]) => unknown;
interface SentMessage {
  content: string;
  details?: Record<string, unknown>;
}
interface DebtRecord {
  root: string;
  since: number;
  files: string[];
}

/** Fixed part of the reminder at the commit before it was shortened, measured on a 47-char root. */
const PREVIOUS_REMINDER_FIXED_CHARS = 1829;

const scratch: string[] = [];
const savedEnv: Record<string, string | undefined> = {
  ANTIFAN_EDIT_MODE: process.env.ANTIFAN_EDIT_MODE,
  ANTIFAN_DATA_ROOT: process.env.ANTIFAN_DATA_ROOT,
  ANTIFAN_CONFIG_DIR: process.env.ANTIFAN_CONFIG_DIR,
};

beforeEach(() => {
  delete process.env.ANTIFAN_EDIT_MODE;
  delete process.env.ANTIFAN_DATA_ROOT;
  const emptyConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-debt-config-'));
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

function loadHook(): { call: HookCall; sent: SentMessage[] } {
  const handlers = new Map<string, Handler>();
  const sent: SentMessage[] = [];
  // The hook's `on` is overloaded per event; the harness stores every handler under its event name.
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    sendMessage: (message: SentMessage) => {
      sent.push(message);
    },
    appendEntry: () => {},
  } as unknown as HookAPI;
  themeQaGate(pi);
  const call: HookCall = (event, ...args) => {
    const handler = handlers.get(event);
    assert.ok(handler, `hook registers ${event}`);
    return handler(...args);
  };
  return { call, sent };
}

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-debt-ws-'));
  scratch.push(root);
  fs.mkdirSync(path.join(root, '.antifan', 'annotations'), { recursive: true });
  fs.mkdirSync(path.join(root, '.antifan', 'qa-receipts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sections'), { recursive: true });
  return root;
}

const debtPath = (root: string) => path.join(root, '.antifan', 'qa-debt.json');
const normalizeRoot = (value: string) => value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function scopedCtx(root: string, mode: 'direct' | 'fast') {
  const branch = [{ type: 'custom', customType: 'antifan.edit-mode', data: { mode, trigger: 'annotation_tag', at: new Date().toISOString() } }];
  return { cwd: root, sessionManager: { getSessionId: () => `sid-${mode}`, getBranch: () => branch } };
}

function writeTheme(call: HookCall, ctx: object, root: string, rel: string): void {
  call('tool_call', { toolName: 'write', input: { path: path.join(root, rel) } }, ctx);
}

function readDebt(root: string): DebtRecord {
  const parsed: DebtRecord = JSON.parse(fs.readFileSync(debtPath(root), 'utf8'));
  return parsed;
}

/** A receipt file whose mtime is pinned, the single clock both gates compare. */
function writeReceipt(root: string, name: string, body: Record<string, unknown>, mtimeMs: number): void {
  const file = path.join(root, '.antifan', 'qa-receipts', name);
  fs.writeFileSync(file, JSON.stringify(body), 'utf8');
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

const passingReceipt = (root: string): Record<string, unknown> => ({
  receiptVersion: '1.2',
  workspaceRoot: root,
  verdict: 'QA_PASSED',
  passed: true,
  execution: 'COMPLETED',
  errorCode: null,
});

function seedDebt(root: string, since: number, files: string[]): void {
  fs.writeFileSync(debtPath(root), JSON.stringify({ root: root.replace(/\\/g, '/'), since, files }), 'utf8');
}

function text(res: unknown): string {
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

describe('scoped session leaves QA debt in the kit-readable format', () => {
  for (const mode of ['direct', 'fast'] as const) {
    it(`${mode}: ending a turn with edits and no passing receipt writes qa-debt.json`, () => {
      const { call } = loadHook();
      const root = makeRoot();
      const ctx = scopedCtx(root, mode);
      call('session_start', undefined, ctx);
      const before = Date.now();
      writeTheme(call, ctx, root, 'sections/hero.liquid');
      writeTheme(call, ctx, root, 'sections/footer.liquid');
      assert.ok(!fs.existsSync(debtPath(root)), 'nothing is persisted before the turn ends');

      call('turn_end', { type: 'turn_end' }, ctx);

      const debt = readDebt(root);
      assert.strictEqual(normalizeRoot(debt.root), normalizeRoot(root));
      assert.strictEqual(typeof debt.since, 'number');
      assert.ok(debt.since >= before && debt.since <= Date.now(), 'since is the epoch ms of the first unverified edit');
      assert.deepStrictEqual(debt.files, ['sections/footer.liquid', 'sections/hero.liquid']);
    });
  }

  it('a later turn adds files and keeps the original since', () => {
    const { call } = loadHook();
    const root = makeRoot();
    const ctx = scopedCtx(root, 'direct');
    call('session_start', undefined, ctx);
    writeTheme(call, ctx, root, 'sections/hero.liquid');
    call('turn_end', { type: 'turn_end' }, ctx);
    const first = readDebt(root);

    writeTheme(call, ctx, root, 'snippets/card.liquid');
    call('turn_end', { type: 'turn_end' }, ctx);

    const second = readDebt(root);
    assert.strictEqual(second.since, first.since);
    assert.deepStrictEqual(second.files, ['sections/hero.liquid', 'snippets/card.liquid']);
  });

  it('a passing receipt newer than the edit means no debt is written', () => {
    const { call } = loadHook();
    const root = makeRoot();
    const ctx = scopedCtx(root, 'direct');
    call('session_start', undefined, ctx);
    writeTheme(call, ctx, root, 'sections/hero.liquid');
    writeReceipt(root, 'pass.json', passingReceipt(root), Date.now() + 5_000);

    call('turn_end', { type: 'turn_end' }, ctx);

    assert.ok(!fs.existsSync(debtPath(root)));
  });

  it('a debt that cannot be written is reported once, not swallowed', () => {
    const { call, sent } = loadHook();
    const root = makeRoot();
    fs.mkdirSync(debtPath(root));
    const ctx = scopedCtx(root, 'direct');
    call('session_start', undefined, ctx);
    writeTheme(call, ctx, root, 'sections/hero.liquid');

    call('turn_end', { type: 'turn_end' }, ctx);
    call('turn_end', { type: 'turn_end' }, ctx);

    const failures = sent.filter((m) => m.details?.kind === 'qa-debt-write-failed');
    assert.strictEqual(failures.length, 1);
    assert.strictEqual(typeof failures[0]?.details?.code, 'string');
    assert.ok(failures[0]?.content.includes('QA_DEBT_WRITE_FAILED'));
  });
});

describe('the next session reads the debt into the reminder', () => {
  it('names the open debt files on the first reminder after session start', () => {
    const { call } = loadHook();
    const root = makeRoot();
    seedDebt(root, Date.now() - 60_000, ['sections/old-hero.liquid', 'assets/theme.css']);
    const ctx = { cwd: root };
    call('session_start', undefined, ctx);

    writeTheme(call, ctx, root, 'sections/new.liquid');
    const reminder = text(call('tool_result', { toolName: 'write', content: 'ok' }, ctx));

    assert.ok(reminder.includes('QA GATE PENDING'));
    assert.ok(reminder.includes('Open QA debt'), reminder);
    assert.ok(reminder.includes('sections/old-hero.liquid') && reminder.includes('assets/theme.css'));
  });

  it('adopts the debt from the first event when session_start carries no context', () => {
    const { call } = loadHook();
    const root = makeRoot();
    seedDebt(root, Date.now() - 60_000, ['sections/old-hero.liquid']);
    const ctx = { cwd: root };
    call('session_start');

    writeTheme(call, ctx, root, 'sections/new.liquid');
    const reminder = text(call('tool_result', { toolName: 'write', content: 'ok' }, ctx));

    assert.ok(reminder.includes('sections/old-hero.liquid'), reminder);
  });

  it('a session with no debt carries no debt sentence', () => {
    const { call } = loadHook();
    const root = makeRoot();
    const ctx = { cwd: root };
    call('session_start', undefined, ctx);
    writeTheme(call, ctx, root, 'sections/new.liquid');
    const reminder = text(call('tool_result', { toolName: 'write', content: 'ok' }, ctx));
    assert.ok(reminder.includes('QA GATE PENDING'));
    assert.ok(!reminder.includes('Open QA debt'));
  });

  it('a declared terminal status does not clear the debt', () => {
    const { call } = loadHook();
    const root = makeRoot();
    seedDebt(root, Date.now() - 60_000, ['sections/old-hero.liquid']);
    const ctx = { cwd: root };
    call('session_start', undefined, ctx);
    writeTheme(call, ctx, root, 'sections/new.liquid');

    call('context', { messages: [{ role: 'assistant', content: 'Edit is local. qaStatus: QA_PENDING_SYNC' }] }, ctx);

    assert.ok(fs.existsSync(debtPath(root)));
  });
});

describe('only a complete passing receipt newer than since clears the debt', () => {
  const since = Date.now() - 120_000;
  const open = (root: string) => {
    seedDebt(root, since, ['sections/hero.liquid']);
    const { call } = loadHook();
    const ctx = { cwd: root };
    call('session_start', undefined, ctx);
    return () => call('context', { messages: [] }, ctx);
  };

  it('a passing receipt newer (mtime) than since deletes the file', () => {
    const root = makeRoot();
    const settle = open(root);
    writeReceipt(root, 'pass.json', passingReceipt(root), since + 30_000);
    settle();
    assert.ok(!fs.existsSync(debtPath(root)));
  });

  const refused: Array<[string, (root: string) => Record<string, unknown>, number]> = [
    ['older than since', passingReceipt, since - 30_000],
    ['QA_FAILED', (root) => ({ ...passingReceipt(root), verdict: 'QA_FAILED', passed: false }), since + 30_000],
    ['QA_INCONCLUSIVE', (root) => ({ ...passingReceipt(root), verdict: 'QA_INCONCLUSIVE', passed: null }), since + 30_000],
    ['degraded execution', (root) => ({ ...passingReceipt(root), execution: 'DEGRADED' }), since + 30_000],
    ['carries an error code', (root) => ({ ...passingReceipt(root), errorCode: 'CAPTURE_TIMEOUT' }), since + 30_000],
    ['another workspace root', () => ({ ...passingReceipt('C:/other-theme') }), since + 30_000],
    ['redirected workspace root', (root) => ({ ...passingReceipt(root), workspaceRootRedirected: true }), since + 30_000],
    ['coverage below expected', (root) => ({ ...passingReceipt(root), coverage: { measured: 1, expected: 5 } }), since + 30_000],
  ];
  for (const [label, build, mtime] of refused) {
    it(`keeps the debt for a receipt that is ${label}`, () => {
      const root = makeRoot();
      const settle = open(root);
      writeReceipt(root, 'r.json', build(root), mtime);
      settle();
      assert.ok(fs.existsSync(debtPath(root)));
    });
  }

  it('an unparseable newer receipt does not clear and does not throw', () => {
    const root = makeRoot();
    const settle = open(root);
    const file = path.join(root, '.antifan', 'qa-receipts', 'broken.json');
    fs.writeFileSync(file, '{ not json', 'utf8');
    fs.utimesSync(file, (since + 30_000) / 1000, (since + 30_000) / 1000);
    assert.doesNotThrow(settle);
    assert.ok(fs.existsSync(debtPath(root)));
  });
});

describe('reminder size', () => {
  it('is shorter than the previous reminder and keeps the terminal-status vocabulary', () => {
    const { call } = loadHook();
    const root = makeRoot();
    const ctx = { cwd: root };
    call('session_start', undefined, ctx);
    writeTheme(call, ctx, root, 'sections/hero.liquid');
    const reminder = text(call('tool_result', { toolName: 'write', content: 'ok' }, ctx)).replace(/^ok/, '');

    const fixedChars = reminder.length - root.length;
    assert.ok(fixedChars < PREVIOUS_REMINDER_FIXED_CHARS * 0.6, `reminder fixed part ${fixedChars} chars vs ${PREVIOUS_REMINDER_FIXED_CHARS} before`);
    for (const token of ['theme.qa_validate', 'SELF_QA_DIRECTIVE', 'QA_UNAVAILABLE', 'QA_INCONCLUSIVE', 'QA_PENDING_SYNC', 'QA_MICRO_STATIC', 'QA_FAILED', 'TARGET_STALE', 'CAPTURE_FRAME_STARVATION']) {
      assert.ok(reminder.includes(token), `reminder keeps ${token}`);
    }
    assert.ok(!/qaStatus\s*:/.test(reminder), 'the reminder must not reproduce the declaration form the gate matches');
  });
});

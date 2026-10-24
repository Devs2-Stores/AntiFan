// anti.sheet.write_cell drives Google Sheets through trusted input. These tests run the real capability
// against a DOM fixture of the editor (Name Box input + formula bar) whose fake host behaves like the
// sheet: Enter in the Name Box selects a cell, Enter in the formula bar commits the typed value.
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
// @ts-ignore jsdom ships no type declarations (same as mcp-agent-surface-fidelity.test.ts)
import { JSDOM } from 'jsdom';
import { BrowserTarget, CapabilityError, issueRuntimeLease, makeControlPlaneId } from '../../src/shared/control-plane-contracts';
import { committedValueMatches } from '../../src/main/tools/sheet-capabilities';

const requireFromHere = createRequire(__filename);

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit#gid=0';

interface SheetOptions {
  url?: string;
  grid?: Record<string, string>;
  /** The Name Box shows this instead of the typed cell after Enter (a selection that did not take). */
  nameBoxShowsAfterEnter?: string;
  /** What the sheet stores when the typed value is committed. */
  commitTransform?: (typed: string) => string;
  nameBoxDisabled?: boolean;
  withoutFormulaBar?: boolean;
  /** Enter in the formula bar leaves the draft in the editor and never stores it (the commit did not take). */
  draftSticksInFormulaBar?: boolean;
  /** GViz answers with this HTTP status instead of CSV. */
  gvizStatus?: number;
  /** GViz serves the pre-commit grid for this many reads (autosave lag). */
  gvizLagReads?: number;
}

function makeSheet(options: SheetOptions = {}) {
  const html = `<!doctype html><html><body>
    <input id="t-name-box" value="A1"${options.nameBoxDisabled ? ' disabled' : ''}>
    ${options.withoutFormulaBar ? '' : '<div id="t-formula-bar-input" contenteditable="true"></div>'}
  </body></html>`;
  const dom = new JSDOM(html, { url: options.url ?? SHEET_URL, runScripts: 'outside-only' });
  const doc = dom.window.document;
  const grid: Record<string, string> = { ...(options.grid ?? {}) };
  const draft: Record<string, string> = {};
  let preCommitGrid: Record<string, string> = { ...grid };
  let gvizReads = 0;
  let selected = 'A1';
  let focusedSelector = '';
  const calls: Array<{ kind: 'click' | 'type' | 'key' | 'fetch'; selector?: string; text?: string; key?: string }> = [];

  const setText = (selector: string, text: string): void => {
    const el = doc.querySelector(selector) as (HTMLInputElement & HTMLElement) | null;
    if (!el) return;
    if (el.tagName === 'INPUT') el.value = text;
    else el.textContent = text;
  };
  const showSelection = (): void => {
    setText('#t-name-box', selected);
    setText('#t-formula-bar-input', draft[selected] ?? grid[selected] ?? '');
  };
  showSelection();

  const csvOf = (cells: Record<string, string>): string => {
    const parsed = Object.entries(cells).map(([address, text]) => {
      const m = /^([A-Z]+)([0-9]+)$/.exec(address)!;
      let col = 0;
      for (const ch of m[1] ?? '') col = col * 26 + (ch.charCodeAt(0) - 64);
      return { row: Number(m[2]), col, text };
    });
    const maxRow = Math.max(1, ...parsed.map((p) => p.row));
    const maxCol = Math.max(1, ...parsed.map((p) => p.col));
    const quote = (text: string): string => (/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
    const lines: string[] = [];
    for (let r = 1; r <= maxRow; r += 1) {
      const fields: string[] = [];
      for (let c = 1; c <= maxCol; c += 1) fields.push(quote(parsed.find((p) => p.row === r && p.col === c)?.text ?? ''));
      lines.push(fields.join(','));
    }
    return lines.join('\n');
  };
  (dom.window as unknown as { fetch: unknown }).fetch = async (url: string) => {
    calls.push({ kind: 'fetch', text: String(url) });
    gvizReads += 1;
    if (options.gvizStatus !== undefined) return { ok: false, status: options.gvizStatus, text: async () => '' };
    const served = gvizReads <= (options.gvizLagReads ?? 0) ? preCommitGrid : grid;
    return { ok: true, status: 200, text: async () => csvOf(served) };
  };

  const host = {
    navigate: () => true,
    reload: () => true,
    getDom: async () => '<html></html>',
    captureScreenshot: async () => 'data:image/png;base64,mock',
    getTabList: () => [{ id: 'tab-sheet' }],
    hasTab: (id: string) => id === 'tab-sheet',
    evalJs: async (expr: string) => JSON.parse(JSON.stringify(await dom.window.eval(expr))),
    agentClick: async ({ selector }: { selector?: string }) => {
      calls.push({ kind: 'click', selector });
      focusedSelector = selector ?? '';
      return true;
    },
    agentType: async ({ selector, text }: { selector?: string; text: string }) => {
      calls.push({ kind: 'type', selector, text });
      setText(selector ?? '', text);
      return true;
    },
    sendKeyboardPress: async ({ key }: { key: string }) => {
      calls.push({ kind: 'key', key });
      if (key === 'Enter' && focusedSelector === '#t-name-box') {
        selected = (doc.querySelector('#t-name-box') as HTMLInputElement).value.toUpperCase();
        showSelection();
        if (options.nameBoxShowsAfterEnter !== undefined) setText('#t-name-box', options.nameBoxShowsAfterEnter);
      } else if (key === 'Enter' && focusedSelector === '#t-formula-bar-input') {
        const typed = doc.querySelector('#t-formula-bar-input')!.textContent ?? '';
        if (options.draftSticksInFormulaBar) {
          draft[selected] = typed;
        } else {
          preCommitGrid = { ...grid };
          grid[selected] = options.commitTransform ? options.commitTransform(typed) : typed;
        }
      }
      return { success: true, key, modifiers: [] as string[] };
    },
  } as unknown as BrowserHostPort;

  const projectId = makeControlPlaneId('project');
  const workspaceId = makeControlPlaneId('workspace');
  const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
  const target: BrowserTarget = { tabId: 'tab-sheet', browserEpoch: 1, documentGeneration: 1, runtimeId: lease.runtimeId, projectId, workspaceId };
  const catalogue = new CapabilityCatalogue({
    runtime: { mode: 'standalone', lifecycle: 'active' },
    projectId,
    workspaceId,
    runtimeId: lease.runtimeId,
    hostEpoch: 1,
    resolveTabId: (id) => (id === 'tab-sheet' ? 'tab-sheet' : undefined),
    isTabAllowed: () => true,
    getDocumentGeneration: () => 1,
  });
  registerBrowserCapabilities(catalogue, new BrowserControlPort(host));
  const write = (params: Record<string, unknown>) =>
    catalogue.dispatch('anti.sheet.write_cell', { tabId: 'tab-sheet', ...params }, { lease, leaseToken: lease.token, projectId, workspaceId, browserTarget: target, grant: 'write' }) as Promise<Record<string, unknown>>;
  const typedIntoFormulaBar = () => calls.filter((c) => c.kind === 'type' && c.selector === '#t-formula-bar-input');
  const fetchedUrls = () => calls.filter((c) => c.kind === 'fetch').map((c) => c.text as string);
  return { catalogue, grid, calls, write, typedIntoFormulaBar, fetchedUrls };
}

async function refusal(promise: Promise<unknown>): Promise<CapabilityError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof CapabilityError, `expected a CapabilityError, got ${String(err)}`);
    return err;
  }
  assert.fail('the call was expected to be refused');
}

describe('anti.sheet.write_cell', () => {
  it('writes the cell, confirms the selection first and returns the previous and read-back value', async () => {
    const sheet = makeSheet({ grid: { B2: 'old' } });
    const res = await sheet.write({ cell: 'b2', value: 'new', expectedPrevious: 'old' });
    assert.deepStrictEqual(
      { success: res.success, cell: res.cell, previous: res.previous, value: res.value, selectionConfirmed: res.selectionConfirmed, verified: res.verified },
      { success: true, cell: 'B2', previous: 'old', value: 'new', selectionConfirmed: true, verified: true }
    );
    assert.strictEqual(sheet.grid.B2, 'new');
    const nameBoxTyping = sheet.calls.filter((c) => c.kind === 'type' && c.selector === '#t-name-box').map((c) => c.text);
    assert.deepStrictEqual(nameBoxTyping, ['B2', 'B2'], 'the cell is selected before the write and again to read it back');
    assert.strictEqual(sheet.typedIntoFormulaBar().length, 1);
  });

  it('types nothing into the cell when the Name Box does not show the requested cell', async () => {
    const sheet = makeSheet({ grid: { A394: 'keep' }, nameBoxShowsAfterEnter: 'A1' });
    const err = await refusal(sheet.write({ cell: 'A394', value: 'oops' }));
    assert.strictEqual(err.code, 'SHEET_SELECTION_UNCONFIRMED');
    assert.strictEqual(err.details?.requested, 'A394');
    assert.strictEqual(err.details?.actualNameBox, 'A1');
    assert.strictEqual(sheet.typedIntoFormulaBar().length, 0, 'no value may be typed after an unconfirmed selection');
    assert.strictEqual(sheet.grid.A394, 'keep');
  });

  it('refuses and writes nothing when the live value differs from expectedPrevious', async () => {
    const sheet = makeSheet({ grid: { C3: 'actual' } });
    const err = await refusal(sheet.write({ cell: 'C3', value: 'new', expectedPrevious: 'stale' }));
    assert.strictEqual(err.code, 'SHEET_PRECONDITION_FAILED');
    assert.strictEqual(err.details?.actualPrevious, 'actual');
    assert.strictEqual(err.details?.expectedPrevious, 'stale');
    assert.strictEqual(sheet.typedIntoFormulaBar().length, 0);
    assert.strictEqual(sheet.grid.C3, 'actual');
  });

  it('protects the header row unless allowHeader is set, and does not touch the page when refusing', async () => {
    const sheet = makeSheet({ grid: { A1: 'Title' } });
    const err = await refusal(sheet.write({ cell: 'A1', value: 'Fixed' }));
    assert.strictEqual(err.code, 'SHEET_HEADER_PROTECTED');
    assert.deepStrictEqual(sheet.calls, [], 'a protected header refusal must not move the selection');
    assert.strictEqual(sheet.grid.A1, 'Title');

    const allowed = await sheet.write({ cell: 'A1', value: 'Renamed', allowHeader: true });
    assert.strictEqual(allowed.verified, true);
    assert.strictEqual(sheet.grid.A1, 'Renamed');
  });

  it('reports a value that reads back differently as unverified and carries the previous value', async () => {
    const sheet = makeSheet({ grid: { D4: 'before' }, commitTransform: (typed) => typed.toUpperCase() });
    const err = await refusal(sheet.write({ cell: 'D4', value: 'mixed Case' }));
    assert.strictEqual(err.code, 'SHEET_WRITE_UNVERIFIED');
    assert.strictEqual(err.details?.previous, 'before');
    assert.strictEqual(err.details?.expected, 'mixed Case');
    assert.strictEqual(err.details?.actual, 'MIXED CASE');
  });

  it('refuses a tab that is not an editable Google Sheets document before any input', async () => {
    const sheet = makeSheet({ url: 'https://example.com/spreadsheets/d/abc/edit' });
    const err = await refusal(sheet.write({ cell: 'B2', value: 'x' }));
    assert.strictEqual(err.code, 'SHEET_NOT_EDITABLE');
    assert.deepStrictEqual(sheet.calls, []);
  });

  it('refuses when the requested gid is not the sheet tab that is open', async () => {
    const sheet = makeSheet();
    const err = await refusal(sheet.write({ cell: 'B2', value: 'x', gid: '99' }));
    assert.strictEqual(err.code, 'SHEET_NOT_EDITABLE');
    assert.strictEqual(err.details?.openGid, '0');
    assert.deepStrictEqual(sheet.calls, []);
  });

  it('refuses a disabled Name Box and a missing formula bar instead of guessing other elements', async () => {
    const locked = makeSheet({ nameBoxDisabled: true });
    assert.strictEqual((await refusal(locked.write({ cell: 'B2', value: 'x' }))).code, 'SHEET_NOT_EDITABLE');
    assert.deepStrictEqual(locked.calls, []);

    const noBar = makeSheet({ withoutFormulaBar: true });
    assert.strictEqual((await refusal(noBar.write({ cell: 'B2', value: 'x' }))).code, 'SHEET_NOT_EDITABLE');
    assert.deepStrictEqual(noBar.calls, []);
  });

  it('refuses a cell that is not a single A1 cell', async () => {
    const sheet = makeSheet();
    for (const cell of ['A1:B2', 'ZZZZ1', 'B0', 'row 5']) {
      const err = await refusal(sheet.write({ cell, value: 'x' }));
      assert.strictEqual(err.code, 'INVALID_ARGUMENT', cell);
    }
    assert.deepStrictEqual(sheet.calls, []);
  });

  it('is a mutating capability: never read-safe, an interactive write, and the proxy row keeps tabId ambient', () => {
    const sheet = makeSheet();
    assert.strictEqual(sheet.catalogue.get('anti.sheet.write_cell')?.risk, 'write');
    assert.notStrictEqual(sheet.catalogue.getPolicy('anti.sheet.write_cell')?.effect, 'read');
    assert.strictEqual(sheet.catalogue.get('antifan_sheet_write_cell')?.risk, 'write');
    const proxy = requireFromHere(path.resolve(process.cwd(), 'scripts/antifan-omp-mcp.cjs')) as {
      definitions: Array<[string, string, Record<string, unknown>, string[], unknown, string?]>;
      READ_SAFE_CAPABILITIES: Record<string, boolean>;
    };
    const row = proxy.definitions.find(([name]) => name === 'anti.sheet.write_cell');
    assert.ok(row, 'anti.sheet.write_cell is advertised');
    assert.notStrictEqual(proxy.READ_SAFE_CAPABILITIES['anti.sheet.write_cell'], true);
    assert.deepStrictEqual(row[3], ['cell', 'value']);
    assert.strictEqual(row[5], 'tabId');
  });

  it('reads the committed value back from GViz after the final commit and reports that source', async () => {
    const sheet = makeSheet({ grid: { B2: 'old' } });
    const res = await sheet.write({ cell: 'B2', value: 'new' });
    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.committedSource, 'gviz');
    assert.strictEqual(res.observed, 'new');
    const urls = sheet.fetchedUrls();
    assert.strictEqual(urls.length, 1);
    assert.ok(urls[0]?.includes('/spreadsheets/d/1AbCdEfGhIjKlMnOp/gviz/tq?tqx=out:csv&headers=0&gid=0'), urls[0]);
    const lastKey = sheet.calls.map((c) => c.kind).lastIndexOf('key');
    const firstFetch = sheet.calls.findIndex((c) => c.kind === 'fetch');
    assert.ok(firstFetch > lastKey, 'the independent read happens after the last editor interaction');
  });

  it('does not report verified when the draft stays in the formula bar and the sheet never stored it', async () => {
    const sheet = makeSheet({ grid: { G53: 'old' }, draftSticksInFormulaBar: true });
    const err = await refusal(sheet.write({ cell: 'G53', value: 'new' }));
    assert.strictEqual(err.code, 'SHEET_WRITE_UNVERIFIED');
    assert.strictEqual(err.details?.source, 'gviz');
    assert.strictEqual(err.details?.expected, 'new');
    assert.strictEqual(err.details?.observed, 'old');
    assert.strictEqual(err.details?.actual, 'new', 'the editor still echoes the draft');
    assert.strictEqual(sheet.grid.G53, 'old');
    assert.strictEqual(sheet.fetchedUrls().length, 3, 'autosave lag is retried before refusing');
  });

  it('refuses an empty independent read-back instead of trusting the editor', async () => {
    const sheet = makeSheet({ draftSticksInFormulaBar: true });
    const err = await refusal(sheet.write({ cell: 'C3', value: 'x' }));
    assert.strictEqual(err.code, 'SHEET_WRITE_UNVERIFIED');
    assert.strictEqual(err.details?.observed, '');
    assert.strictEqual(err.details?.source, 'gviz');
  });

  it('refuses when GViz is unreachable, with the status and no observed value', async () => {
    const sheet = makeSheet({ gvizStatus: 403 });
    const err = await refusal(sheet.write({ cell: 'B2', value: 'new' }));
    assert.strictEqual(err.code, 'SHEET_WRITE_UNVERIFIED');
    assert.strictEqual(err.details?.source, 'gviz');
    assert.strictEqual(err.details?.observed, null);
    assert.strictEqual(err.details?.status, 403);
    assert.strictEqual(err.details?.expected, 'new');
  });

  it('waits out autosave lag: a stale first GViz read is retried and then verified', async () => {
    const sheet = makeSheet({ grid: { B2: 'old' }, gvizLagReads: 1 });
    const res = await sheet.write({ cell: 'B2', value: 'new' });
    assert.strictEqual(res.verified, true);
    assert.strictEqual(sheet.fetchedUrls().length, 2);
  });

  it('compares quoted CSV values exactly, including commas, quotes and line breaks', async () => {
    const sheet = makeSheet({ grid: { B2: 'old', A2: 'neighbour' } });
    const res = await sheet.write({ cell: 'B2', value: 'a, "b"\nc' });
    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.observed, 'a, "b"\nc');
  });

  it('does not claim a formula was verified: its GViz value is the evaluated result', async () => {
    const sheet = makeSheet({ grid: { B2: '1' } });
    const res = await sheet.write({ cell: 'B2', value: '=SUM(A2:A3)' });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.verified, false);
    assert.strictEqual(res.reason, 'formula-not-comparable');
  });
});

describe('committedValueMatches', () => {
  it('matches trimmed text, booleans in any case and numbers with thousands separators', () => {
    assert.strictEqual(committedValueMatches('abc', ' abc '), true);
    assert.strictEqual(committedValueMatches('true', 'TRUE'), true);
    assert.strictEqual(committedValueMatches('1234.5', '1,234.5'), true);
    assert.strictEqual(committedValueMatches('', ''), true);
  });

  it('rejects a different, stale or empty observed value', () => {
    assert.strictEqual(committedValueMatches('new', 'old'), false);
    assert.strictEqual(committedValueMatches('new', ''), false);
    assert.strictEqual(committedValueMatches('0', ''), false);
    assert.strictEqual(committedValueMatches('12', '13'), false);
  });
});

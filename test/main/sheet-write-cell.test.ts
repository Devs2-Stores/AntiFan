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
}

function makeSheet(options: SheetOptions = {}) {
  const html = `<!doctype html><html><body>
    <input id="t-name-box" value="A1"${options.nameBoxDisabled ? ' disabled' : ''}>
    ${options.withoutFormulaBar ? '' : '<div id="t-formula-bar-input" contenteditable="true"></div>'}
  </body></html>`;
  const dom = new JSDOM(html, { url: options.url ?? SHEET_URL, runScripts: 'outside-only' });
  const doc = dom.window.document;
  const grid: Record<string, string> = { ...(options.grid ?? {}) };
  let selected = 'A1';
  let focusedSelector = '';
  const calls: Array<{ kind: 'click' | 'type' | 'key'; selector?: string; text?: string; key?: string }> = [];

  const setText = (selector: string, text: string): void => {
    const el = doc.querySelector(selector) as (HTMLInputElement & HTMLElement) | null;
    if (!el) return;
    if (el.tagName === 'INPUT') el.value = text;
    else el.textContent = text;
  };
  const showSelection = (): void => {
    setText('#t-name-box', selected);
    setText('#t-formula-bar-input', grid[selected] ?? '');
  };
  showSelection();

  const host = {
    navigate: () => true,
    reload: () => true,
    getDom: async () => '<html></html>',
    captureScreenshot: async () => 'data:image/png;base64,mock',
    getTabList: () => [{ id: 'tab-sheet' }],
    hasTab: (id: string) => id === 'tab-sheet',
    evalJs: async (expr: string) => JSON.parse(JSON.stringify(dom.window.eval(expr))),
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
        grid[selected] = options.commitTransform ? options.commitTransform(typed) : typed;
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
  return { catalogue, grid, calls, write, typedIntoFormulaBar };
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
});

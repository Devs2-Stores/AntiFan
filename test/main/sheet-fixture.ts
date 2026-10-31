// Shared DOM fixture of the Google Sheets editor (Name Box input + formula bar) for the sheet capability tests.
// Its fake host behaves like the sheet: Enter in the Name Box selects a cell, Enter in the formula bar commits
// the typed value, and GViz serves the stored grid as CSV.
import { mock } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import * as assert from 'node:assert';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
// @ts-ignore jsdom ships no type declarations (same as mcp-agent-surface-fidelity.test.ts)
import { JSDOM } from 'jsdom';
import { BrowserTarget, CapabilityError, issueRuntimeLease, makeControlPlaneId } from '../../src/shared/control-plane-contracts';

export const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit#gid=0';

export interface SheetOptions {
  url?: string;
  grid?: Record<string, string>;
  /** The Name Box shows this instead of the typed cell after Enter (a selection that did not take). */
  nameBoxShowsAfterEnter?: string;
  /** What the sheet stores when the typed value is committed. */
  commitTransform?: (typed: string, cell: string) => string;
  nameBoxDisabled?: boolean;
  withoutFormulaBar?: boolean;
  /** Enter in the formula bar leaves the draft in the editor and never stores it (the commit did not take). */
  draftSticksInFormulaBar?: boolean;
  /** Like draftSticksInFormulaBar, for these cells only. */
  draftSticksCells?: string[];
  /** Committing one of these cells makes the sheet raise a protected-range dialog and store nothing. */
  protectedCells?: string[];
  /** Text of that dialog (defaults to the English Sheets message). */
  protectedDialogText?: string;
  /** A dialog that is open from the start and does not mention protection. */
  unrelatedDialogText?: string;
  /** document.visibilityState reported to the page. */
  visibilityState?: 'visible' | 'hidden';
  /** GViz answers with this HTTP status instead of CSV. */
  gvizStatus?: number;
  /** GViz serves the pre-commit grid for this many reads (autosave lag). */
  gvizLagReads?: number;
  /** GViz always serves exactly this grid (another writer's value, or a stale snapshot that never moves). */
  gvizAlways?: Record<string, string>;
  /** GViz serves the stored grid until the formula bar commits, then exactly this grid (another writer saved a different value meanwhile). */
  gvizAfterCommit?: Record<string, string>;
  /** Alt+Enter in the formula bar inserts nothing: the editor swallowed the line break. */
  altEnterIgnored?: boolean;
  /** Runs while a value is being typed into the formula bar. */
  onFormulaBarType?: () => void;
}

export interface SheetCall {
  kind: 'click' | 'type' | 'key' | 'fetch';
  selector?: string;
  text?: string;
  key?: string;
  modifiers?: string[];
  clear?: boolean;
  init?: unknown;
}

export function makeSheet(options: SheetOptions = {}) {
  const html = `<!doctype html><html><body>
    <input id="t-name-box" value="A1"${options.nameBoxDisabled ? ' disabled' : ''}>
    ${options.withoutFormulaBar ? '' : '<div id="t-formula-bar-input" contenteditable="true"></div>'}
    ${options.unrelatedDialogText ? `<div role="dialog">${options.unrelatedDialogText}</div>` : ''}
  </body></html>`;
  const dom = new JSDOM(html, { url: options.url ?? SHEET_URL, runScripts: 'outside-only' });
  const doc = dom.window.document;
  if (options.visibilityState) Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => options.visibilityState });
  const grid: Record<string, string> = { ...(options.grid ?? {}) };
  const draft: Record<string, string> = {};
  let preCommitGrid: Record<string, string> = { ...grid };
  let gvizReadsAfterCommit = 0;
  let commitPressed = false;
  let selected = 'A1';
  let focusedSelector = '';
  const calls: SheetCall[] = [];

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
  (dom.window as unknown as { fetch: unknown }).fetch = async (url: string, init?: unknown) => {
    calls.push({ kind: 'fetch', text: String(url), init });
    if (commitPressed) gvizReadsAfterCommit += 1;
    if (options.gvizStatus !== undefined) return { ok: false, status: options.gvizStatus, text: async () => '' };
    const served = options.gvizAlways ?? (commitPressed && options.gvizAfterCommit ? options.gvizAfterCommit : gvizReadsAfterCommit <= (options.gvizLagReads ?? 0) && commitPressed ? preCommitGrid : grid);
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
    agentType: async ({ selector, text, clear }: { selector?: string; text: string; clear?: boolean }) => {
      calls.push({ kind: 'type', selector, text, clear });
      const el = doc.querySelector(selector ?? '') as (HTMLInputElement & HTMLElement) | null;
      const current = el ? (el.tagName === 'INPUT' ? el.value : (el.textContent ?? '')) : '';
      setText(selector ?? '', clear === false ? current + text : text);
      if (selector === '#t-formula-bar-input') options.onFormulaBarType?.();
      return true;
    },
    sendKeyboardPress: async ({ key, modifiers }: { key: string; modifiers?: string[] }) => {
      calls.push({ kind: 'key', key, modifiers });
      if (key === 'Enter' && focusedSelector === '#t-name-box') {
        selected = (doc.querySelector('#t-name-box') as HTMLInputElement).value.toUpperCase();
        showSelection();
        if (options.nameBoxShowsAfterEnter !== undefined) setText('#t-name-box', options.nameBoxShowsAfterEnter);
      } else if (key === 'Enter' && modifiers?.includes('Alt') && focusedSelector === '#t-formula-bar-input') {
        if (!options.altEnterIgnored) setText('#t-formula-bar-input', `${doc.querySelector('#t-formula-bar-input')!.textContent ?? ''}\n`);
      } else if (key === 'Enter' && focusedSelector === '#t-formula-bar-input') {
        const typed = doc.querySelector('#t-formula-bar-input')!.textContent ?? '';
        commitPressed = true;
        gvizReadsAfterCommit = 0;
        if (options.protectedCells?.includes(selected)) {
          const dialog = doc.createElement('div');
          dialog.setAttribute('role', 'dialog');
          dialog.textContent = options.protectedDialogText ?? 'You are trying to edit a protected cell or object. Contact the owner of the sheet.';
          doc.body.appendChild(dialog);
        } else if (options.draftSticksInFormulaBar || options.draftSticksCells?.includes(selected)) {
          draft[selected] = typed;
        } else {
          preCommitGrid = { ...grid };
          grid[selected] = options.commitTransform ? options.commitTransform(typed, selected) : typed;
        }
      } else if (key === 'Escape') {
        for (const dialog of Array.from(doc.querySelectorAll('[role="dialog"]')) as Element[]) {
          if (!dialog.hasAttribute('data-persistent')) dialog.remove();
        }
        if (focusedSelector === '#t-formula-bar-input') setText('#t-formula-bar-input', draft[selected] ?? grid[selected] ?? '');
      }
      return { success: true, key, modifiers: modifiers ?? [] };
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
  const port = new BrowserControlPort(host);
  const keyPresses: Array<{ key: string; modifiers: string[]; signalAborted: boolean | undefined }> = [];
  const pressKey = port.keyboardPress.bind(port);
  port.keyboardPress = (args, keyTarget, keySignal) => {
    keyPresses.push({ key: args.key, modifiers: args.modifiers ?? [], signalAborted: keySignal?.aborted });
    return pressKey(args, keyTarget, keySignal);
  };
  registerBrowserCapabilities(catalogue, port);
  const call = (name: string, params: Record<string, unknown>, context: { signal?: AbortSignal } = {}) =>
    catalogue.dispatch(name, { tabId: 'tab-sheet', ...params }, { lease, leaseToken: lease.token, projectId, workspaceId, browserTarget: target, grant: 'write', ...context }) as Promise<Record<string, unknown>>;
  const write = (params: Record<string, unknown>, context: { signal?: AbortSignal } = {}) => call('anti.sheet.write_cell', params, context);
  const writeRange = (params: Record<string, unknown>, context: { signal?: AbortSignal } = {}) => call('anti.sheet.write_range', params, context);
  const findRows = (params: Record<string, unknown>, context: { signal?: AbortSignal } = {}) => call('anti.sheet.find_rows', params, context);
  const typedIntoFormulaBar = () => calls.filter((c) => c.kind === 'type' && c.selector === '#t-formula-bar-input');
  const fetchedUrls = () => calls.filter((c) => c.kind === 'fetch').map((c) => c.text as string);
  /** What reached the formula bar from the first click on it: the typed segments and the keys pressed. */
  const formulaBarSteps = (): string[] => {
    const from = calls.findIndex((c) => c.kind === 'click' && c.selector === '#t-formula-bar-input');
    return calls
      .slice(from + 1)
      .filter((c) => (c.kind === 'type' && c.selector === '#t-formula-bar-input') || c.kind === 'key')
      .map((c) => (c.kind === 'type' ? `type:${c.text}` : `${c.modifiers?.length ? `${c.modifiers.join('+')}+` : ''}${c.key}`));
  };
  return { catalogue, grid, calls, keyPresses, write, writeRange, findRows, typedIntoFormulaBar, fetchedUrls, formulaBarSteps };
}

export async function refusal(promise: Promise<unknown>): Promise<CapabilityError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof CapabilityError, `expected a CapabilityError, got ${String(err)}`);
    return err;
  }
  assert.fail('the call was expected to be refused');
}

/**
 * Runs `run` with fake timers and a fake clock, advancing both as the capability sleeps between GViz reads,
 * so a read-back window of many seconds costs no wall time.
 */
export async function withFakeTime<T>(run: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  try {
    let done = false;
    const result = run().finally(() => {
      done = true;
    });
    result.catch(() => undefined);
    while (!done) {
      await nextTurn();
      mock.timers.tick(250);
    }
    return await result;
  } finally {
    mock.timers.reset();
  }
}

/**
 * Google Sheets write capability: `anti.sheet.write_cell`.
 *
 * The write goes through the sheet's own editor with trusted input, one cell per call, and every
 * step is a refusal gate rather than a best effort:
 *   1. the tab must be an editable Sheets document (and the requested gid the open tab);
 *   2. the cell is selected through the Name Box and the Name Box is READ BACK - a selection that
 *      cannot be confirmed refuses the call before anything is typed;
 *   3. the live value is read from the formula bar; a supplied `expectedPrevious` that differs
 *      refuses the write, and the header row is protected unless the caller opts in;
 *   4. the value is typed and committed, the cell is selected again and the formula bar is read
 *      back; a value that cannot be confirmed is reported as unverified together with the previous
 *      value, never assumed to have landed;
 *   5. the formula bar and the Name Box belong to the editor, so a draft that never committed still
 *      reads back there. `verified: true` therefore also requires the committed value to be read
 *      from the spreadsheet's GViz CSV (an authenticated in-tab fetch, independent of the editor).
 *      A differing, empty or unreachable read-back is `SHEET_WRITE_UNVERIFIED`. A formula's GViz
 *      value is its evaluated result, which cannot be compared with the formula text, so a formula
 *      is reported as `verified: false` with the reason `formula-not-comparable`.
 *
 * The editor selectors below are candidates for Sheets' own markup, which this module cannot
 * observe at build time. When none of them is present the call is refused (`SHEET_NOT_EDITABLE`)
 * instead of guessing a different element.
 */
import {
  AuthenticatedCapabilityContext,
  BrowserTarget,
  CapabilityError,
  CapabilityRequestContext,
} from '../../shared/control-plane-contracts';
import { CapabilityCatalogue } from './capability-catalogue';
import type { BrowserControlPort } from './browser-control-port';
// Namespace import: browser-capabilities imports this module at load, so the policy factory is only
// dereferenced inside the registration body, never at load time.
import * as browserCaps from './browser-capabilities';

const NAME_BOX_SELECTORS = ['#t-name-box', 'input[aria-label="Name box"]', '.waffle-name-box input'] as const;
const FORMULA_BAR_SELECTORS = ['#t-formula-bar-input', '.cell-input'] as const;

const SHEET_EDIT_URL = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+\/edit/;
const CELL_NOTATION = /^[A-Za-z]{1,3}[1-9][0-9]{0,6}$/;
const HEADER_ROW = 1;

const GVIZ_ATTEMPTS = 3;
/** Sheets autosaves shortly after a commit, so the first GViz read can still show the old value. */
const GVIZ_RETRY_DELAY_MS = 700;

type CellScalar = string | number | boolean;

interface SheetWriteParams {
  tabId?: string;
  cell?: unknown;
  value?: unknown;
  expectedPrevious?: unknown;
  gid?: unknown;
  allowHeader?: unknown;
}

interface EditorState {
  href: string;
  nameBox: { selector: string; value: string; disabled: boolean } | null;
  formulaBar: { selector: string; value: string } | null;
}

/** One synchronous page expression that reports the URL, the Name Box and the formula bar. */
function readEditorStateScript(): string {
  return `(() => {
    const pick = (selectors) => {
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) return { selector, el };
      }
      return null;
    };
    const textOf = (el) => (typeof el.value === 'string' ? el.value : (el.textContent || ''));
    const box = pick(${JSON.stringify(NAME_BOX_SELECTORS)});
    const bar = pick(${JSON.stringify(FORMULA_BAR_SELECTORS)});
    return {
      href: window.location.href,
      nameBox: box
        ? {
            selector: box.selector,
            value: textOf(box.el),
            disabled: Boolean(box.el.disabled || box.el.readOnly || box.el.getAttribute('aria-disabled') === 'true'),
          }
        : null,
      formulaBar: bar ? { selector: bar.selector, value: textOf(bar.el) } : null,
    };
  })()`;
}

function parseEditorState(raw: unknown): EditorState {
  const value = raw as Record<string, unknown> | null;
  if (!value || typeof value !== 'object' || typeof value.href !== 'string') {
    throw new CapabilityError('SHEET_NOT_EDITABLE', 'The tab did not report a readable Google Sheets editor state', {
      cause: 'the editor probe returned no document location',
      recovery: 'bind the tab that has the spreadsheet open in edit mode (anti.browser.tabs.list), then retry',
    });
  }
  const nameBox = value.nameBox as Record<string, unknown> | null;
  const formulaBar = value.formulaBar as Record<string, unknown> | null;
  return {
    href: value.href,
    nameBox:
      nameBox && typeof nameBox === 'object' && typeof nameBox.selector === 'string'
        ? { selector: nameBox.selector, value: typeof nameBox.value === 'string' ? nameBox.value : '', disabled: nameBox.disabled === true }
        : null,
    formulaBar:
      formulaBar && typeof formulaBar === 'object' && typeof formulaBar.selector === 'string'
        ? { selector: formulaBar.selector, value: typeof formulaBar.value === 'string' ? formulaBar.value : '' }
        : null,
  };
}

type SelectOutcome = { ok: true; state: EditorState } | { ok: false; actualNameBox: string | null; step: string };

function invalid(message: string): CapabilityError {
  return new CapabilityError('INVALID_ARGUMENT', `anti.sheet.write_cell: ${message}`);
}

function readScalar(field: string, value: unknown, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw invalid(`${field} is required`);
    return undefined;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw invalid(`${field} must be a string, a finite number or a boolean`);
}

/** One GViz read: the observed cell text, or why it could not be read. */
type GvizRead = { ok: true; observed: string } | { ok: false; error: string; status?: number };

/**
 * In-page async expression: fetches the sheet tab's GViz CSV with the page's own credentials and
 * returns only the requested cell. `headers=0` keeps row N equal to sheet row N.
 */
function readCellFromGvizScript(sheetId: string, gid: string, cell: string): string {
  return `(async () => {
    try {
      const sheetId = ${JSON.stringify(sheetId)};
      const gid = ${JSON.stringify(gid)};
      const cell = ${JSON.stringify(cell)};
      const href = window.location.href;
      const openId = (href.match(/\\/spreadsheets\\/d\\/([A-Za-z0-9_-]+)/) || [])[1];
      const openGid = (href.match(/[#&?]gid=([0-9]+)/) || [])[1] || '0';
      if (openId !== sheetId || openGid !== gid) {
        return { ok: false, error: 'the open sheet tab is no longer ' + sheetId + ' gid ' + gid };
      }
      const res = await fetch('/spreadsheets/d/' + sheetId + '/gviz/tq?tqx=out:csv&headers=0&gid=' + gid, { credentials: 'include' });
      if (!res.ok) return { ok: false, status: res.status, error: 'GViz request returned HTTP ' + res.status };
      const csv = await res.text();
      if (/^\\s*<(!doctype|html)/i.test(csv)) return { ok: false, error: 'GViz returned an HTML page instead of CSV' };
      const rows = [];
      let row = [];
      let cur = '';
      let inQuotes = false;
      for (let i = 0; i < csv.length; i++) {
        const c = csv[i];
        if (c === '"') {
          if (inQuotes && csv[i + 1] === '"') { cur += '"'; i++; }
          else { inQuotes = !inQuotes; }
        } else if (c === ',' && !inQuotes) {
          row.push(cur);
          cur = '';
        } else if ((c === '\\r' || c === '\\n') && !inQuotes) {
          if (c === '\\r' && csv[i + 1] === '\\n') i++;
          row.push(cur);
          cur = '';
          rows.push(row);
          row = [];
        } else {
          cur += c;
        }
      }
      if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }
      const letters = cell.replace(/[0-9]+$/, '');
      let col = 0;
      for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
      const rowIndex = parseInt(cell.slice(letters.length), 10) - 1;
      const record = rows[rowIndex] || [];
      return { ok: true, observed: record[col - 1] === undefined ? '' : record[col - 1] };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  })()`;
}

function parseGvizRead(raw: unknown): GvizRead {
  const value = raw as Record<string, unknown> | null;
  if (value && typeof value === 'object' && value.ok === true && typeof value.observed === 'string') {
    return { ok: true, observed: value.observed };
  }
  const error = value && typeof value === 'object' && typeof value.error === 'string' ? value.error : 'the GViz probe returned no result';
  return { ok: false, error, ...(value && typeof value.status === 'number' ? { status: value.status } : {}) };
}

/**
 * GViz returns display-formatted values, so the comparison is exact after trimming, with two
 * normalizations Sheets itself applies on commit: booleans are upper-cased and plain numbers may
 * gain thousands separators.
 */
export function committedValueMatches(expected: string, observed: string): boolean {
  const want = expected.trim();
  const got = observed.trim();
  if (want === got) return true;
  if (/^(true|false)$/i.test(want)) return want.toLowerCase() === got.toLowerCase();
  if (/^[-+]?\d+(\.\d+)?$/.test(want) && got !== '') {
    const gotNumber = Number(got.replace(/,/g, ''));
    return Number.isFinite(gotNumber) && gotNumber === Number(want);
  }
  return false;
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CapabilityError('WAIT_ABORTED', 'anti.sheet.write_cell was aborted while waiting for the sheet to save'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CapabilityError('WAIT_ABORTED', 'anti.sheet.write_cell was aborted while waiting for the sheet to save'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function registerSheetCapabilities(catalogue: CapabilityCatalogue, browser: BrowserControlPort): void {
  const write = async (
    params: SheetWriteParams,
    context: CapabilityRequestContext | AuthenticatedCapabilityContext
  ): Promise<Record<string, unknown>> => {
    const target = context.browserTarget as BrowserTarget;
    const signal = context.signal;
    const tabId = typeof params.tabId === 'string' && params.tabId.trim() ? params.tabId.trim() : undefined;

    // Argument gates first: nothing is read from the page for a call that cannot be valid.
    if (typeof params.cell !== 'string' || !CELL_NOTATION.test(params.cell.trim())) {
      throw invalid('cell must be A1 notation for one cell, for example "F12"');
    }
    const cell = params.cell.trim().toUpperCase();
    const row = Number.parseInt(cell.replace(/^[A-Z]+/, ''), 10);
    const value = readScalar('value', params.value, true) as string;
    const expectedPrevious = readScalar('expectedPrevious', params.expectedPrevious, false);
    if (params.gid !== undefined && typeof params.gid !== 'string') throw invalid('gid must be a string');
    const requestedGid = typeof params.gid === 'string' && params.gid.trim() ? params.gid.trim() : undefined;
    if (params.allowHeader !== undefined && typeof params.allowHeader !== 'boolean') throw invalid('allowHeader must be a boolean');

    const readState = async (): Promise<EditorState> => parseEditorState(await browser.eval(target, readEditorStateScript(), tabId));

    // 1. Editable gate.
    const opening = await readState();
    if (!SHEET_EDIT_URL.test(opening.href)) {
      throw new CapabilityError('SHEET_NOT_EDITABLE', 'The tab is not an editable Google Sheets document', {
        cause: 'its URL is not a docs.google.com spreadsheet edit URL',
        observedUrl: opening.href,
        recovery: 'bind the tab that has the spreadsheet open in edit mode (anti.browser.tabs.list), then retry',
      });
    }
    const openGid = (/[#&?]gid=([0-9]+)/.exec(opening.href) || [])[1] || '0';
    if (requestedGid !== undefined && requestedGid !== openGid) {
      throw new CapabilityError('SHEET_NOT_EDITABLE', `The open sheet tab has gid ${openGid}, not the requested gid ${requestedGid}`, {
        cause: 'the requested gid is not the sheet tab that is open',
        requestedGid,
        openGid,
        recovery: 'open the requested sheet tab in the spreadsheet, or omit gid to write to the open one',
      });
    }
    if (!opening.nameBox || opening.nameBox.disabled) {
      throw new CapabilityError('SHEET_NOT_EDITABLE', 'The Google Sheets Name Box is not available for input', {
        cause: opening.nameBox ? 'the Name Box is disabled (view-only or locked)' : 'no known Name Box element is present on the page',
        triedSelectors: [...NAME_BOX_SELECTORS],
        recovery: 'open the spreadsheet in edit mode and retry; if the editor markup changed, this capability must be updated',
      });
    }
    if (!opening.formulaBar) {
      throw new CapabilityError('SHEET_NOT_EDITABLE', 'The Google Sheets formula bar is not available, so the cell value cannot be read back', {
        cause: 'no known formula bar element is present on the page',
        triedSelectors: [...FORMULA_BAR_SELECTORS],
        recovery: 'open the spreadsheet in edit mode and retry; if the editor markup changed, this capability must be updated',
      });
    }
    const nameBoxSelector = opening.nameBox.selector;
    const formulaBarSelector = opening.formulaBar.selector;

    // Header protection needs no page interaction, so it refuses before the selection moves.
    if (row === HEADER_ROW && params.allowHeader !== true) {
      throw new CapabilityError('SHEET_HEADER_PROTECTED', `Row ${HEADER_ROW} is the header row and is not written without allowHeader`, {
        cell,
        recovery: 'pass allowHeader: true to write the header row deliberately',
      });
    }

    /** Selects `cell` through the Name Box and reads the Name Box back; `ok:false` carries what it showed. */
    const selectCell = async (): Promise<SelectOutcome> => {
      const clicked = await browser.agentClick({ selector: nameBoxSelector, trusted: true, tabId }, target, signal);
      if (!clicked.clicked) return { ok: false, actualNameBox: null, step: 'click the Name Box' };
      const typed = await browser.agentType({ selector: nameBoxSelector, text: cell, clear: true, trusted: true, tabId }, target, signal);
      if (!typed.typed) return { ok: false, actualNameBox: null, step: 'type the cell into the Name Box' };
      const entered = await browser.keyboardPress({ key: 'Enter', tabId }, target, signal);
      if (!entered.success) return { ok: false, actualNameBox: null, step: 'confirm the Name Box with Enter' };
      const state = await readState();
      if (!state.nameBox || state.nameBox.value.trim().toUpperCase() !== cell) {
        return { ok: false, actualNameBox: state.nameBox ? state.nameBox.value : null, step: 'read the Name Box back' };
      }
      if (!state.formulaBar) return { ok: false, actualNameBox: state.nameBox.value, step: 'read the formula bar' };
      return { ok: true, state };
    };

    // 2. Select and confirm; nothing is typed into the cell unless the Name Box shows it.
    const selected = await selectCell();
    if (!selected.ok) {
      throw new CapabilityError('SHEET_SELECTION_UNCONFIRMED', `Could not confirm that ${cell} is selected (failed to ${selected.step}); no value was typed`, {
        requested: cell,
        actualNameBox: selected.actualNameBox,
        recovery: 'check the sheet is editable and the cell exists in the open sheet tab, then retry',
      });
    }

    // 3. Previous value and precondition.
    const previous = selected.state.formulaBar!.value;
    if (expectedPrevious !== undefined && previous !== expectedPrevious) {
      throw new CapabilityError('SHEET_PRECONDITION_FAILED', `${cell} holds a different value than the expected previous value; nothing was written`, {
        cell,
        expectedPrevious,
        actualPrevious: previous,
        recovery: 'read the cell again (anti.sheet.extract), then retry with its current value',
      });
    }

    // 4. Write, commit, re-select, read back.
    const unverified = (message: string, extra: Record<string, unknown>): CapabilityError =>
      new CapabilityError('SHEET_WRITE_UNVERIFIED', message, {
        cell,
        previous,
        expected: value,
        recovery: `the cell may or may not hold the new value; read it back with anti.sheet.extract and restore ${JSON.stringify(previous)} if it is wrong`,
        ...extra,
      });
    try {
      const focus = await browser.agentClick({ selector: formulaBarSelector, trusted: true, tabId }, target, signal);
      if (!focus.clicked) {
        throw new CapabilityError('SHEET_NOT_EDITABLE', 'The formula bar could not be activated for input; nothing was written', {
          cause: 'a trusted click on the formula bar was not delivered',
          recovery: 'open the spreadsheet in edit mode and retry',
        });
      }
      const typed = await browser.agentType({ selector: formulaBarSelector, text: value, clear: true, trusted: true, tabId }, target, signal);
      if (!typed.typed) throw unverified(`The value for ${cell} could not be typed; the cell was not confirmed`, { step: 'type the value' });
      const committed = await browser.keyboardPress({ key: 'Enter', tabId }, target, signal);
      if (!committed.success) throw unverified(`The value for ${cell} was typed but not committed`, { step: 'commit with Enter' });
    } catch (err) {
      if (err instanceof CapabilityError && (err.code === 'SHEET_NOT_EDITABLE' || err.code === 'SHEET_WRITE_UNVERIFIED')) throw err;
      throw unverified(`Writing ${cell} was interrupted: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err instanceof CapabilityError ? err.code : 'UNKNOWN_ERROR',
      });
    }

    let readBack: SelectOutcome;
    try {
      readBack = await selectCell();
    } catch (err) {
      throw unverified(`${cell} could not be re-selected to read the value back: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err instanceof CapabilityError ? err.code : 'UNKNOWN_ERROR',
      });
    }
    if (!readBack.ok) {
      throw unverified(`${cell} could not be re-selected to read the value back (failed to ${readBack.step})`, { actualNameBox: readBack.actualNameBox });
    }
    const actual = readBack.state.formulaBar!.value;
    if (actual !== value) {
      throw unverified(`${cell} reads back ${JSON.stringify(actual)} after the write, not the value that was written`, { actual });
    }

    // 5. Independent read-back: the editor echoing the draft proves nothing about the saved cell.
    const sheetId = (/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(opening.href) || [])[1] as string;
    const readGviz = async (): Promise<GvizRead> => {
      try {
        return parseGvizRead(await browser.eval(target, readCellFromGvizScript(sheetId, openGid, cell), tabId));
      } catch (err) {
        if (signal?.aborted) throw err;
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    };
    const base = { success: true, cell, previous, value, gid: openGid, selectionConfirmed: true, committedSource: 'gviz' };
    if (value.startsWith('=')) {
      const evaluated = await readGviz();
      return {
        ...base,
        verified: false,
        reason: 'formula-not-comparable',
        observed: evaluated.ok ? evaluated.observed : null,
        note: 'the formula text is confirmed in the editor only; the spreadsheet stores its evaluated result, which cannot be compared with the formula',
      };
    }
    let lastRead: GvizRead = { ok: false, error: 'the spreadsheet was never read back' };
    for (let attempt = 1; attempt <= GVIZ_ATTEMPTS; attempt += 1) {
      lastRead = await readGviz();
      if (lastRead.ok && committedValueMatches(value, lastRead.observed)) {
        return { ...base, verified: true, observed: lastRead.observed };
      }
      if (attempt < GVIZ_ATTEMPTS) await pause(GVIZ_RETRY_DELAY_MS, signal);
    }
    if (!lastRead.ok) {
      throw unverified(`${cell} could not be read back from the spreadsheet (${lastRead.error}); the value is not confirmed as saved`, {
        observed: null,
        source: 'gviz',
        unavailable: lastRead.error,
        ...(lastRead.status !== undefined ? { status: lastRead.status } : {}),
        attempts: GVIZ_ATTEMPTS,
      });
    }
    throw unverified(
      `${cell} reads ${JSON.stringify(lastRead.observed)} in the saved spreadsheet, not the value that was written; the editor still shows the draft`,
      { observed: lastRead.observed, source: 'gviz', actual, attempts: GVIZ_ATTEMPTS }
    );
  };

  const inputSchema = (): Record<string, unknown> => ({
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Actual Google Sheets tab ID (defaults to the bound tab)' },
      cell: { type: 'string', pattern: '^[A-Za-z]{1,3}[1-9][0-9]{0,6}$', description: 'A1 notation of the target cell, for example "F12"' },
      value: { type: ['string', 'number', 'boolean'], description: 'Value to write' },
      expectedPrevious: { type: ['string', 'number', 'boolean'], description: 'Optional precondition: the live cell value the caller last read' },
      gid: { type: 'string', description: 'Sheet tab gid' },
      allowHeader: { type: 'boolean', description: 'Allow writing to the header row' },
    },
    required: ['cell', 'value'],
  });
  const policy = () =>
    browserCaps.makeBrowserPolicy({ effect: 'interactive-effect', risk: 'write', requiresBrowserTarget: true, lane: 'viewport-gate' });

  catalogue.register({
    name: 'anti.sheet.write_cell',
    description:
      'Write one cell of a Google Sheet through its authenticated in-tab editor: the cell is selected through the Name Box and the selection is confirmed before typing, the header row is protected unless allowHeader is set, a supplied expectedPrevious must equal the live cell value, and the written value is read back from the spreadsheet itself (GViz CSV, not the editor) and returned with the previous one. verified is true only when that independent read-back matches; a mismatch or an unreachable read-back fails with SHEET_WRITE_UNVERIFIED, and a formula returns verified:false with reason formula-not-comparable',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: policy(),
    inputSchema: inputSchema(),
    execute: (params: SheetWriteParams, context) => write(params, context),
  });

  catalogue.register({
    name: 'antifan_sheet_write_cell',
    description: 'Alias for anti.sheet.write_cell',
    risk: 'write',
    requiresBrowserTarget: true,
    policy: policy(),
    inputSchema: inputSchema(),
    execute: (params: SheetWriteParams, context) => write(params, context),
  });
}

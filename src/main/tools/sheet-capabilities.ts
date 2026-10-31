/**
 * Google Sheets capabilities: `anti.sheet.write_cell`, `anti.sheet.write_range`, `anti.sheet.find_rows`.
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
 *      from the spreadsheet's GViz CSV (an authenticated in-tab fetch, independent of the editor, sent
 *      with `cache: 'no-store'` and a per-request nonce so an HTTP cache never replays an old CSV).
 *      A differing read-back is `SHEET_WRITE_UNVERIFIED`. A read-back that still shows the previous
 *      value (or cannot be read) when the confirm window ends is NOT an error that throws: the editor
 *      accepted the value and the spreadsheet may simply still be saving, so the call returns
 *      `success: false`, `verified: false`, `status: 'SAVED_UNCONFIRMED'` and `committed: 'unknown'` for
 *      the caller to re-check. A tab that reports `document.visibilityState === 'hidden'` is flagged
 *      (`tabHidden`) because a hidden tab may not flush its autosave. A formula's GViz value is its
 *      evaluated result, which cannot be compared with the formula text, so a formula is reported as
 *      `success: true`, `verified: false`, `status: 'FORMULA_EDITOR_CONFIRMED'` with the reason
 *      `formula-not-comparable`: the editor confirmed the text, the saved result was not compared.
 *   6. a value with line breaks is typed as one segment per line with Alt+Enter between them, and the
 *      formula bar is read back BEFORE the commit: a draft that lost a line break is discarded with
 *      Escape and nothing is committed. Any failure or abort after typing began and before the commit
 *      also discards the draft with Escape (on its own short signal, so an aborted call still cleans up).
 *   7. `mode: 'append'` writes `previous + value`; it is refused unless the editor's previous value
 *      equals the spreadsheet's own (GViz) value, so a formula bar that lost line breaks can never
 *      produce a corrupted append.
 *   8. an edit of a protected cell makes Sheets show a dialog instead of saving. A visible dialog whose
 *      text names a protected range is detected after the commit, dismissed with Escape, and reported as
 *      `SHEET_PROTECTED_RANGE`.
 *
 * `anti.sheet.write_range` runs that same single-cell pipeline once per cell, in row-major order, and
 * stops at the first cell that is not confirmed, so every safety gate above still applies to every cell.
 * It never pastes in bulk: a pasted block cannot be read back cell by cell.
 *
 * `anti.sheet.find_rows` reads the GViz CSV once and returns the rows whose cells match a query.
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
const MAX_COLUMN_INDEX = 26 * 26 * 26 + 26 * 26 + 26;
const MAX_ROW_INDEX = 9_999_999;

/** Execution budget of one write: several viewport-lock turns, then the read-back window. The policy adds the ack. */
const SHEET_WRITE_EXECUTION_BUDGET_MS = 120_000;
/** Grace the platform grants a cancelled write to acknowledge; the draft-discard Escape runs inside it. */
const SHEET_WRITE_CANCELLATION_ACK_MS = 10_000;
/** Kept free of the read-back window so the answer is delivered before the platform aborts the call. */
const SHEET_WRITE_READBACK_RESERVE_MS = 10_000;
const CONFIRM_TIMEOUT_DEFAULT_MS = 45_000;
const CONFIRM_TIMEOUT_MAX_MS = 90_000;
/** Sheets autosaves after a commit, so early GViz reads can still show the old value: poll with a backoff. */
const GVIZ_POLL_MIN_DELAY_MS = 700;
const GVIZ_POLL_MAX_DELAY_MS = 3_000;
const GVIZ_POLL_BACKOFF = 1.5;
/** Bound of the Escape that discards an uncommitted draft; it uses its own signal, never the call's. */
const DRAFT_DISCARD_BOUND_MS = 3_000;

/** Execution budget of one range write. It stays under the proxy's 240 s ceiling once the ack is added. */
const SHEET_RANGE_EXECUTION_BUDGET_MS = 200_000;
/** A cell is only started when at least this much of the range budget is left to confirm it. */
const SHEET_RANGE_MIN_CELL_BUDGET_MS = 25_000;
const SHEET_RANGE_MAX_CELLS = 100;

const FIND_ROWS_DEFAULT_LIMIT = 50;
const FIND_ROWS_MAX_LIMIT = 200;
const FIND_ROWS_MAX_QUERY_CHARS = 500;

/** Text of the dialog Sheets raises for an edit of a protected cell, in English and Vietnamese. */
const PROTECTED_DIALOG_PATTERN = '\\bprotected\\b|bảo vệ';

type CellScalar = string | number | boolean;

interface SheetWriteParams {
  tabId?: string;
  cell?: unknown;
  value?: unknown;
  expectedPrevious?: unknown;
  gid?: unknown;
  allowHeader?: unknown;
  confirmTimeoutMs?: unknown;
  mode?: unknown;
}

interface SheetRangeParams {
  tabId?: string;
  cell?: unknown;
  values?: unknown;
  expectedPrevious?: unknown;
  gid?: unknown;
  allowHeader?: unknown;
  confirmTimeoutMs?: unknown;
  mode?: unknown;
}

interface SheetFindRowsParams {
  tabId?: string;
  query?: unknown;
  column?: unknown;
  gid?: unknown;
  exact?: unknown;
  caseSensitive?: unknown;
  limit?: unknown;
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

function invalid(message: string, label = 'anti.sheet.write_cell'): CapabilityError {
  return new CapabilityError('INVALID_ARGUMENT', `${label}: ${message}`);
}

function readScalar(field: string, value: unknown, required: boolean, label?: string): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw invalid(`${field} is required`, label);
    return undefined;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw invalid(`${field} must be a string, a finite number or a boolean`, label);
}

/** One GViz read: the observed cell text, or why it could not be read. `tabHidden` is the page's visibility at read time. */
type GvizRead = { ok: true; observed: string; tabHidden?: boolean } | { ok: false; error: string; status?: number; tabHidden?: boolean };

/**
 * In-page runtime shared by every GViz script: a CSV record parser and the fetch itself. The fetch bypasses
 * the HTTP cache (`cache: 'no-store'`) and carries a per-request nonce, so a repeated read of the same sheet
 * can never be answered by a cached copy of an earlier CSV. `headers=0` keeps row N equal to sheet row N.
 */
const GVIZ_PAGE_RUNTIME = String.raw`
  const parseCsvRecords = (text, trimCells) => {
    const rows = [];
    let row = [];
    let cur = '';
    let inQuotes = false;
    const endCell = () => { row.push(trimCells ? cur.trim() : cur); cur = ''; };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        if (inQuotes && text[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (c === ',' && !inQuotes) {
        endCell();
      } else if ((c === '\r' || c === '\n') && !inQuotes) {
        if (c === '\r' && text[i + 1] === '\n') i++;
        endCell();
        rows.push(row);
        row = [];
      } else {
        cur += c;
      }
    }
    if (cur.length > 0 || row.length > 0) { endCell(); rows.push(row); }
    return rows;
  };
  const fetchGvizCsv = async (sheetId, gid) => {
    const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const res = await fetch('/spreadsheets/d/' + sheetId + '/gviz/tq?tqx=out:csv&headers=0&gid=' + gid + '&_=' + nonce, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) return { ok: false, status: res.status, error: 'GViz request returned HTTP ' + res.status };
    const csv = await res.text();
    if (/^\s*<(!doctype|html)/i.test(csv)) return { ok: false, error: 'GViz returned an HTML page instead of CSV' };
    return { ok: true, csv };
  };
  const columnIndexOf = (letters) => {
    let col = 0;
    for (const ch of letters.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
    return col;
  };
`;

/**
 * In-page async expression: fetches the sheet tab's GViz CSV with the page's own credentials and
 * returns only the requested cell, plus the page's visibility state.
 */
function readCellFromGvizScript(sheetId: string, gid: string, cell: string): string {
  return `(async () => {
    const visibility = document.visibilityState;
    try {
      ${GVIZ_PAGE_RUNTIME}
      const sheetId = ${JSON.stringify(sheetId)};
      const gid = ${JSON.stringify(gid)};
      const cell = ${JSON.stringify(cell)};
      const href = window.location.href;
      const openId = (href.match(/\\/spreadsheets\\/d\\/([A-Za-z0-9_-]+)/) || [])[1];
      const openGid = (href.match(/[#&?]gid=([0-9]+)/) || [])[1] || '0';
      if (openId !== sheetId || openGid !== gid) {
        return { ok: false, visibility, error: 'the open sheet tab is no longer ' + sheetId + ' gid ' + gid };
      }
      const got = await fetchGvizCsv(sheetId, gid);
      if (!got.ok) return { ...got, visibility };
      const rows = parseCsvRecords(got.csv, false);
      const letters = cell.replace(/[0-9]+$/, '');
      const col = columnIndexOf(letters);
      const rowIndex = parseInt(cell.slice(letters.length), 10) - 1;
      const record = rows[rowIndex] || [];
      return { ok: true, visibility, observed: record[col - 1] === undefined ? '' : record[col - 1] };
    } catch (err) {
      return { ok: false, visibility, error: err && err.message ? err.message : String(err) };
    }
  })()`;
}

function parseGvizRead(raw: unknown): GvizRead {
  const value = raw as Record<string, unknown> | null;
  const hidden = value && typeof value === 'object' && typeof value.visibility === 'string' ? { tabHidden: value.visibility === 'hidden' } : {};
  if (value && typeof value === 'object' && value.ok === true && typeof value.observed === 'string') {
    return { ok: true, observed: value.observed, ...hidden };
  }
  const error = value && typeof value === 'object' && typeof value.error === 'string' ? value.error : 'the GViz probe returned no result';
  return { ok: false, error, ...hidden, ...(value && typeof value.status === 'number' ? { status: value.status } : {}) };
}

/** One synchronous page expression: the text of a visible dialog that names a protected range, or null. */
function readProtectedDialogScript(): string {
  return `(() => {
    const pattern = new RegExp(${JSON.stringify(PROTECTED_DIALOG_PATTERN)}, 'i');
    const visible = (el) => {
      if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    for (const el of document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal-dialog, .docs-dialog')) {
      if (!visible(el)) continue;
      const text = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      if (text && pattern.test(text)) return { found: true, text: text.slice(0, 300) };
    }
    return { found: false };
  })()`;
}

function parseProtectedDialog(raw: unknown): string | null {
  const value = raw as Record<string, unknown> | null;
  return value && typeof value === 'object' && value.found === true && typeof value.text === 'string' ? value.text : null;
}

/** Sheets and CSV disagree about CR versus CRLF line breaks; both mean one break. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * GViz returns display-formatted values, so the comparison is exact after trimming and line-break
 * normalization, with two normalizations Sheets itself applies on commit: booleans are upper-cased
 * and plain numbers may gain thousands separators.
 */
export function committedValueMatches(expected: string, observed: string): boolean {
  const want = normalizeNewlines(expected).trim();
  const got = normalizeNewlines(observed).trim();
  if (want === got) return true;
  if (/^(true|false)$/i.test(want)) return want.toLowerCase() === got.toLowerCase();
  if (/^[-+]?\d+(\.\d+)?$/.test(want) && got !== '') {
    const gotNumber = Number(got.replace(/,/g, ''));
    return Number.isFinite(gotNumber) && gotNumber === Number(want);
  }
  return false;
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const aborted = (): CapabilityError => new CapabilityError('WAIT_ABORTED', 'anti.sheet.write_cell was aborted while waiting for the sheet to save');
  if (signal?.aborted) {
    reject(aborted());
    return promise;
  }
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(aborted());
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
  return promise;
}

function columnIndexOf(letters: string): number {
  let col = 0;
  for (const ch of letters.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col;
}

function columnLettersOf(index: number): string {
  let letters = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

/** A cell matrix of scalars, validated against the label of the capability that received it. */
function readMatrix(field: string, value: unknown, required: boolean, label: string): string[][] | undefined {
  if (value === undefined || value === null) {
    if (required) throw invalid(`${field} is required`, label);
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) throw invalid(`${field} must be a non-empty array of rows`, label);
  const rows: string[][] = [];
  value.forEach((row, r) => {
    if (!Array.isArray(row) || row.length === 0) throw invalid(`${field}[${r}] must be a non-empty array of cell values`, label);
    rows.push(row.map((cellValue, c) => readScalar(`${field}[${r}][${c}]`, cellValue, true, label) as string));
  });
  return rows;
}

/** In-page async expression: fetches the CSV and returns the rows that match the query. */
function findRowsFromGvizScript(sheetId: string, gid: string | undefined, request: { query: string; column: string | undefined; exact: boolean; caseSensitive: boolean; limit: number }): string {
  return `(async () => {
    const visibility = document.visibilityState;
    try {
      ${GVIZ_PAGE_RUNTIME}
      const sheetId = ${JSON.stringify(sheetId)};
      const href = window.location.href;
      const gid = ${JSON.stringify(gid ?? '')} || (href.match(/[#&?]gid=([0-9]+)/) || [])[1] || '0';
      const query = ${JSON.stringify(request.query)};
      const columnSpec = ${JSON.stringify(request.column ?? '')};
      const exact = ${JSON.stringify(request.exact)};
      const caseSensitive = ${JSON.stringify(request.caseSensitive)};
      const limit = ${JSON.stringify(request.limit)};
      const got = await fetchGvizCsv(sheetId, gid);
      if (!got.ok) return { ...got, visibility };
      const rows = parseCsvRecords(got.csv, true);
      while (rows.length > 0 && !rows[rows.length - 1].some((cell) => cell.length > 0)) rows.pop();
      const headers = rows[0] || [];
      let columnIndex = -1;
      if (columnSpec) {
        if (/^[A-Za-z]{1,3}$/.test(columnSpec)) {
          columnIndex = columnIndexOf(columnSpec) - 1;
        } else {
          columnIndex = headers.findIndex((h) => h.toLowerCase() === columnSpec.toLowerCase());
          if (columnIndex < 0) return { ok: false, visibility, code: 'COLUMN_NOT_FOUND', error: 'no header cell in row 1 equals "' + columnSpec + '"', headers };
        }
      }
      const fold = (text) => (caseSensitive ? text : text.toLowerCase());
      const needle = fold(query.trim());
      const matches = [];
      let total = 0;
      for (let r = 0; r < rows.length; r++) {
        const cells = rows[r];
        const matchedColumns = [];
        for (let c = 0; c < cells.length; c++) {
          if (columnIndex >= 0 && c !== columnIndex) continue;
          const hay = fold(cells[c]);
          if (exact ? hay === needle : hay.includes(needle)) matchedColumns.push(c);
        }
        if (matchedColumns.length === 0) continue;
        total += 1;
        if (matches.length < limit) matches.push({ row: r + 1, cells, matchedColumns: matchedColumns.map((c) => c + 1) });
      }
      return { ok: true, visibility, sheetId, gid, totalRows: rows.length, headers, matchCount: total, matches, truncated: total > matches.length };
    } catch (err) {
      return { ok: false, visibility, error: err && err.message ? err.message : String(err) };
    }
  })()`;
}

type CellOutcome = { cell: string; status: string; verified: boolean; previous?: string; observed?: string | null; reason?: string };

export function registerSheetCapabilities(catalogue: CapabilityCatalogue, browser: BrowserControlPort): void {
  /** `budgetEndsAt` is the end of a surrounding range budget; a single call is only bounded by its own budget. */
  const write = async (
    params: SheetWriteParams,
    context: CapabilityRequestContext | AuthenticatedCapabilityContext,
    budgetEndsAt?: number
  ): Promise<Record<string, unknown>> => {
    const target = context.browserTarget as BrowserTarget;
    const signal = context.signal;
    const startedAt = Date.now();
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
    if (params.mode !== undefined && params.mode !== 'replace' && params.mode !== 'append') throw invalid('mode must be "replace" or "append"');
    const mode: 'replace' | 'append' = params.mode === 'append' ? 'append' : 'replace';
    if (
      params.confirmTimeoutMs !== undefined &&
      (typeof params.confirmTimeoutMs !== 'number' || !Number.isFinite(params.confirmTimeoutMs) || params.confirmTimeoutMs < 0 || params.confirmTimeoutMs > CONFIRM_TIMEOUT_MAX_MS)
    ) {
      throw invalid(`confirmTimeoutMs must be a number from 0 to ${CONFIRM_TIMEOUT_MAX_MS} (milliseconds to wait for the spreadsheet to show the saved value)`);
    }
    const confirmTimeoutMs = typeof params.confirmTimeoutMs === 'number' ? params.confirmTimeoutMs : CONFIRM_TIMEOUT_DEFAULT_MS;
    const budgetEndsAtMs = Math.min(startedAt + SHEET_WRITE_EXECUTION_BUDGET_MS, budgetEndsAt ?? Number.POSITIVE_INFINITY);

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
    if (expectedPrevious !== undefined && normalizeNewlines(previous) !== normalizeNewlines(expectedPrevious)) {
      throw new CapabilityError('SHEET_PRECONDITION_FAILED', `${cell} holds a different value than the expected previous value; nothing was written`, {
        cell,
        expectedPrevious,
        actualPrevious: previous,
        recovery: 'read the cell again (anti.sheet.extract), then retry with its current value',
      });
    }

    // The spreadsheet's own view of the cell (GViz), independent of the editor.
    const sheetId = (/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(opening.href) || [])[1] as string;
    const readGviz = async (): Promise<GvizRead> => {
      try {
        return parseGvizRead(await browser.eval(target, readCellFromGvizScript(sheetId, openGid, cell), tabId));
      } catch (err) {
        if (signal?.aborted) throw err;
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    };

    // Append is literal concatenation. The formula bar can lose line breaks, so the editor's previous value
    // must equal the saved one before it is used as a prefix; otherwise the append would corrupt the cell.
    // The same read doubles as the pre-commit baseline of what GViz shows for the cell.
    let gvizBefore: GvizRead | undefined;
    if (mode === 'append') {
      const saved = await readGviz();
      if (!saved.ok || normalizeNewlines(saved.observed) !== normalizeNewlines(previous)) {
        throw new CapabilityError('SHEET_PRECONDITION_FAILED', `${cell}: the editor and the saved spreadsheet do not agree on the current value, so the append was refused; nothing was written`, {
          cell,
          mode,
          editorPrevious: previous,
          savedValue: saved.ok ? saved.observed : null,
          ...(saved.ok ? {} : { unavailable: saved.error }),
          recovery: 'read the cell (anti.sheet.extract), then write the full new value with mode "replace"',
        });
      }
      gvizBefore = saved;
    } else {
      // Best effort: the formula bar holds the raw content (a formula, an unformatted number) while GViz serves
      // the display value, so only GViz can say what "unchanged" looks like in the read-back below.
      gvizBefore = await readGviz();
    }
    const finalValue = mode === 'append' ? previous + value : value;

    // 4. Write, commit, re-select, read back.
    const unverified = (message: string, extra: Record<string, unknown>): CapabilityError =>
      new CapabilityError('SHEET_WRITE_UNVERIFIED', message, {
        cell,
        previous,
        expected: finalValue,
        recovery: `the cell may or may not hold the new value; read it back with anti.sheet.extract and restore ${JSON.stringify(previous)} if it is wrong`,
        ...extra,
      });
    /** Escape on the formula bar drops an uncommitted draft. Its own signal: the call's may be the one that aborted. */
    const discardDraft = async (): Promise<void> => {
      try {
        await browser.keyboardPress({ key: 'Escape', tabId }, target, AbortSignal.timeout(DRAFT_DISCARD_BOUND_MS));
      } catch {
        // Best effort: the original failure is what the caller needs to see.
      }
    };
    /** The text of a visible "protected range" dialog, or null (also when the page cannot be read). */
    const protectedDialogText = async (): Promise<string | null> => {
      try {
        return parseProtectedDialog(await browser.eval(target, readProtectedDialogScript(), tabId));
      } catch {
        return null;
      }
    };
    /** Dismisses a protected-range dialog and reports the refusal; returns normally when no such dialog is open. */
    const throwIfProtected = async (): Promise<void> => {
      const dialogText = await protectedDialogText();
      if (dialogText === null) return;
      await discardDraft();
      throw new CapabilityError('SHEET_PROTECTED_RANGE', `${cell} is in a protected range; Google Sheets refused the edit`, {
        cell,
        previous,
        dialogText,
        recovery: `ask the sheet owner for edit access to the range or write an unprotected cell; read ${cell} back with anti.sheet.extract before assuming it changed`,
      });
    };
    const lines = finalValue.split(/\r?\n/);
    let typingBegan = false;
    let commitPressed = false;
    try {
      const focus = await browser.agentClick({ selector: formulaBarSelector, trusted: true, tabId }, target, signal);
      if (!focus.clicked) {
        throw new CapabilityError('SHEET_NOT_EDITABLE', 'The formula bar could not be activated for input; nothing was written', {
          cause: 'a trusted click on the formula bar was not delivered',
          recovery: 'open the spreadsheet in edit mode and retry',
        });
      }
      typingBegan = true;
      for (let index = 0; index < lines.length; index += 1) {
        if (index > 0) {
          const broke = await browser.keyboardPress({ key: 'Enter', modifiers: ['Alt'], tabId }, target, signal);
          if (!broke.success) throw unverified(`A line break could not be inserted into the draft for ${cell}; nothing was committed`, { step: 'insert a line break with Alt+Enter' });
        }
        const text = lines[index] as string;
        if (index > 0 && text === '') continue;
        const typed = await browser.agentType({ selector: formulaBarSelector, text, clear: index === 0, trusted: true, tabId }, target, signal);
        if (!typed.typed) throw unverified(`The value for ${cell} could not be typed; the cell was not confirmed`, { step: 'type the value' });
      }
      if (lines.length > 1) {
        // Alt+Enter in the formula bar cannot be proven offline, so the draft is checked before it can be committed.
        const draft = (await readState()).formulaBar;
        if (!draft || normalizeNewlines(draft.value) !== normalizeNewlines(finalValue)) {
          throw unverified(`The multi-line draft for ${cell} does not read back as typed; nothing was committed and the draft is discarded`, {
            step: 'verify the multi-line draft before the commit',
            actual: draft ? draft.value : null,
          });
        }
      }
      const committed = await browser.keyboardPress({ key: 'Enter', tabId }, target, signal);
      if (!committed.success) throw unverified(`The value for ${cell} was typed but not committed`, { step: 'commit with Enter' });
      commitPressed = true;
    } catch (err) {
      if (err instanceof CapabilityError && err.code === 'SHEET_PROTECTED_RANGE') throw err;
      // A protected cell raises its dialog while the draft is open: look before Escape removes the evidence.
      if (typingBegan && !commitPressed) await throwIfProtected();
      if (typingBegan && !commitPressed) await discardDraft();
      if (err instanceof CapabilityError && (err.code === 'SHEET_NOT_EDITABLE' || err.code === 'SHEET_WRITE_UNVERIFIED')) throw err;
      throw unverified(`Writing ${cell} was interrupted: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err instanceof CapabilityError ? err.code : 'UNKNOWN_ERROR',
      });
    }
    await throwIfProtected();

    let readBack: SelectOutcome;
    try {
      readBack = await selectCell();
    } catch (err) {
      await throwIfProtected();
      throw unverified(`${cell} could not be re-selected to read the value back: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err instanceof CapabilityError ? err.code : 'UNKNOWN_ERROR',
      });
    }
    if (!readBack.ok) {
      await throwIfProtected();
      throw unverified(`${cell} could not be re-selected to read the value back (failed to ${readBack.step})`, { actualNameBox: readBack.actualNameBox });
    }
    const actual = readBack.state.formulaBar!.value;
    if (normalizeNewlines(actual) !== normalizeNewlines(finalValue)) {
      await throwIfProtected();
      throw unverified(`${cell} reads back ${JSON.stringify(actual)} after the write, not the value that was written`, { actual });
    }

    // 5. Independent read-back: the editor echoing the draft proves nothing about the saved cell.
    const base = {
      cell,
      previous,
      value: finalValue,
      mode,
      ...(mode === 'append' ? { appended: value } : {}),
      gid: openGid,
      selectionConfirmed: true,
      committedSource: 'gviz',
    };
    if (finalValue.startsWith('=')) {
      const evaluated = await readGviz();
      return {
        ...base,
        success: true,
        verified: false,
        status: 'FORMULA_EDITOR_CONFIRMED',
        reason: 'formula-not-comparable',
        observed: evaluated.ok ? evaluated.observed : null,
        note: 'the formula text is confirmed in the editor only; the spreadsheet stores its evaluated result, which cannot be compared with the formula',
      };
    }
    // Autosave can lag by tens of seconds: poll until the window closes. The window never reaches into the
    // execution budget's reserve, so the answer is delivered rather than aborted by the platform.
    const readbackStartedAt = Date.now();
    const windowMs = Math.max(0, Math.min(confirmTimeoutMs, budgetEndsAtMs - readbackStartedAt - SHEET_WRITE_READBACK_RESERVE_MS));
    const windowEndsAt = readbackStartedAt + windowMs;
    let attempts = 0;
    let delayMs = GVIZ_POLL_MIN_DELAY_MS;
    let lastRead: GvizRead = { ok: false, error: 'the spreadsheet was never read back' };
    for (;;) {
      attempts += 1;
      lastRead = await readGviz();
      if (lastRead.ok && committedValueMatches(finalValue, lastRead.observed)) {
        return { ...base, success: true, verified: true, observed: lastRead.observed, attempts, waitedMs: Date.now() - readbackStartedAt };
      }
      const remainingMs = windowEndsAt - Date.now();
      if (remainingMs <= 0) break;
      await pause(Math.min(delayMs, remainingMs), signal);
      delayMs = Math.min(GVIZ_POLL_MAX_DELAY_MS, Math.round(delayMs * GVIZ_POLL_BACKOFF));
    }
    const waitedMs = Date.now() - readbackStartedAt;
    await throwIfProtected();
    // "Neither the written nor the previous value" is only a conflict when the saved cell moved away from what
    // GViz showed before the commit. The previous value comes from the formula bar, so a formula or a formatted
    // number never equals its own GViz display value; a read that still equals the pre-commit GViz value is a
    // save that has not landed yet.
    const unchangedFromBaseline = lastRead.ok && gvizBefore !== undefined && gvizBefore.ok && committedValueMatches(gvizBefore.observed, lastRead.observed);
    if (lastRead.ok && !committedValueMatches(previous, lastRead.observed) && !unchangedFromBaseline) {
      throw unverified(
        `${cell} reads ${JSON.stringify(lastRead.observed)} in the saved spreadsheet, which is neither the value that was written nor the previous one`,
        { observed: lastRead.observed, source: 'gviz', actual, attempts, waitedMs }
      );
    }
    const tabHidden = lastRead.tabHidden === true;
    return {
      ...base,
      success: false,
      verified: false,
      status: 'SAVED_UNCONFIRMED',
      committed: 'unknown',
      reason: lastRead.ok ? 'gviz-still-previous' : 'gviz-unreadable',
      observed: lastRead.ok ? lastRead.observed : null,
      ...(lastRead.ok ? {} : { unavailable: lastRead.error, ...(lastRead.status !== undefined ? { httpStatus: lastRead.status } : {}) }),
      attempts,
      waitedMs,
      ...(lastRead.tabHidden !== undefined ? { tabHidden } : {}),
      ...(tabHidden
        ? { recovery: 'the sheet tab is hidden, so Sheets may not have flushed its autosave: bring it forward (anti.browser.tabs.activate, with restoreWindow:true when the window is minimized), then re-read with anti.sheet.extract' }
        : {}),
      recheck: 'anti.sheet.extract',
      note: `the editor accepted the value, but the spreadsheet did not show it within ${waitedMs}ms${tabHidden ? ' (the tab is hidden)' : ''}; it may still be saving. success is false because the write is not confirmed: re-read the cell with anti.sheet.extract before writing it again`,
    };
  };

  const rangeWrite = async (
    params: SheetRangeParams,
    context: CapabilityRequestContext | AuthenticatedCapabilityContext
  ): Promise<Record<string, unknown>> => {
    const label = 'anti.sheet.write_range';
    const startedAt = Date.now();
    const signal = context.signal;
    if (typeof params.cell !== 'string' || !CELL_NOTATION.test(params.cell.trim())) {
      throw invalid('cell must be the A1 notation of the top-left cell of the range, for example "F12"', label);
    }
    const anchor = params.cell.trim().toUpperCase();
    const anchorColumn = columnIndexOf(anchor.replace(/[0-9]+$/, ''));
    const anchorRow = Number.parseInt(anchor.replace(/^[A-Z]+/, ''), 10);
    const values = readMatrix('values', params.values, true, label) as string[][];
    const expectedPrevious = readMatrix('expectedPrevious', params.expectedPrevious, false, label);
    const width = Math.max(...values.map((r) => r.length));
    const cellCount = values.reduce((sum, r) => sum + r.length, 0);
    if (cellCount > SHEET_RANGE_MAX_CELLS) throw invalid(`values holds ${cellCount} cells; at most ${SHEET_RANGE_MAX_CELLS} are written per call (split the range)`, label);
    if (anchorColumn + width - 1 > MAX_COLUMN_INDEX || anchorRow + values.length - 1 > MAX_ROW_INDEX) throw invalid('the range runs past the last column or row the notation can address', label);
    if (expectedPrevious && (expectedPrevious.length !== values.length || expectedPrevious.some((r, i) => r.length !== (values[i] as string[]).length))) {
      throw invalid('expectedPrevious must have the same shape as values', label);
    }
    if (params.gid !== undefined && typeof params.gid !== 'string') throw invalid('gid must be a string', label);
    if (params.allowHeader !== undefined && typeof params.allowHeader !== 'boolean') throw invalid('allowHeader must be a boolean', label);
    if (params.mode !== undefined && params.mode !== 'replace' && params.mode !== 'append') throw invalid('mode must be "replace" or "append"', label);
    if (anchorRow <= HEADER_ROW && params.allowHeader !== true) {
      throw new CapabilityError('SHEET_HEADER_PROTECTED', `The range starts in row ${HEADER_ROW}, the header row, which is not written without allowHeader`, {
        cell: anchor,
        recovery: 'pass allowHeader: true to write the header row deliberately, or start the range below it',
      });
    }
    const mode: 'replace' | 'append' = params.mode === 'append' ? 'append' : 'replace';
    const budgetEndsAt = startedAt + SHEET_RANGE_EXECUTION_BUDGET_MS;

    const cells: CellOutcome[] = [];
    const total = cellCount;
    let attempted = 0;
    for (let r = 0; r < values.length; r += 1) {
      const rowValues = values[r] as string[];
      for (let c = 0; c < rowValues.length; c += 1) {
        const cell = `${columnLettersOf(anchorColumn + c)}${anchorRow + r}`;
        if (signal?.aborted) throw new CapabilityError('WAIT_ABORTED', 'anti.sheet.write_range was aborted');
        if (budgetEndsAt - Date.now() < SHEET_RANGE_MIN_CELL_BUDGET_MS) {
          return {
            success: false,
            complete: false,
            stopped: 'budget',
            mode,
            anchor,
            total,
            written: cells.length,
            notAttempted: total - attempted,
            nextCell: cell,
            cells,
            note: `the range budget ended before ${cell}; every cell listed in cells is confirmed. Continue with a new call that starts at ${cell}`,
          };
        }
        attempted += 1;
        try {
          const res = await write(
            {
              tabId: params.tabId,
              cell,
              value: rowValues[c],
              gid: params.gid,
              allowHeader: params.allowHeader,
              confirmTimeoutMs: params.confirmTimeoutMs,
              mode,
              ...(expectedPrevious ? { expectedPrevious: (expectedPrevious[r] as string[])[c] } : {}),
            },
            context,
            budgetEndsAt
          );
          const outcome: CellOutcome = {
            cell,
            status: res.status === 'FORMULA_EDITOR_CONFIRMED' ? 'FORMULA_EDITOR_CONFIRMED' : res.verified === true ? 'VERIFIED' : String(res.status ?? 'UNVERIFIED'),
            verified: res.verified === true,
            previous: res.previous as string,
            observed: (res.observed as string | null | undefined) ?? null,
            ...(typeof res.reason === 'string' ? { reason: res.reason } : {}),
          };
          cells.push(outcome);
          if (res.success !== true) {
            return {
              success: false,
              complete: false,
              stopped: 'unverified',
              mode,
              anchor,
              total,
              written: cells.length - 1,
              notAttempted: total - attempted,
              failedAt: { index: attempted - 1, cell, status: outcome.status, reason: res.reason, note: res.note, ...(res.tabHidden !== undefined ? { tabHidden: res.tabHidden } : {}) },
              cells,
            };
          }
        } catch (err) {
          if (signal?.aborted || !(err instanceof CapabilityError)) throw err;
          cells.push({ cell, status: err.code, verified: false });
          return {
            success: false,
            complete: false,
            stopped: 'error',
            mode,
            anchor,
            total,
            written: cells.length - 1,
            notAttempted: total - attempted,
            failedAt: { index: attempted - 1, cell, status: err.code, code: err.code, message: err.message, details: err.details },
            cells,
          };
        }
      }
    }
    const unconfirmedFormulas = cells.filter((entry) => entry.status === 'FORMULA_EDITOR_CONFIRMED').length;
    return {
      success: true,
      complete: true,
      mode,
      anchor,
      total,
      written: cells.length,
      ...(unconfirmedFormulas > 0 ? { formulaEditorConfirmed: unconfirmedFormulas } : {}),
      cells,
    };
  };

  const findRows = async (
    params: SheetFindRowsParams,
    context: CapabilityRequestContext | AuthenticatedCapabilityContext
  ): Promise<Record<string, unknown>> => {
    const label = 'anti.sheet.find_rows';
    if (typeof params.query !== 'string' || params.query.trim() === '') throw invalid('query must be a non-empty string', label);
    if (params.query.length > FIND_ROWS_MAX_QUERY_CHARS) throw invalid(`query is longer than ${FIND_ROWS_MAX_QUERY_CHARS} characters`, label);
    if (params.column !== undefined && (typeof params.column !== 'string' || params.column.trim() === '')) throw invalid('column must be a column letter ("C") or the text of a header cell', label);
    if (params.gid !== undefined && typeof params.gid !== 'string') throw invalid('gid must be a string', label);
    if (params.exact !== undefined && typeof params.exact !== 'boolean') throw invalid('exact must be a boolean', label);
    if (params.caseSensitive !== undefined && typeof params.caseSensitive !== 'boolean') throw invalid('caseSensitive must be a boolean', label);
    if (params.limit !== undefined && (typeof params.limit !== 'number' || !Number.isInteger(params.limit) || params.limit < 1 || params.limit > FIND_ROWS_MAX_LIMIT)) {
      throw invalid(`limit must be an integer from 1 to ${FIND_ROWS_MAX_LIMIT}`, label);
    }
    const tabId = typeof params.tabId === 'string' && params.tabId.trim() ? params.tabId.trim() : undefined;
    const target = context.browserTarget as BrowserTarget;
    const opening = parseEditorState(await browser.eval(target, readEditorStateScript(), tabId));
    const sheetId = (/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(opening.href) || [])[1];
    if (!sheetId || !/^https:\/\/docs\.google\.com\/spreadsheets\/d\//.test(opening.href)) {
      throw new CapabilityError('SHEET_NOT_EDITABLE', 'The tab is not a Google Sheets document', {
        cause: 'its URL is not a docs.google.com spreadsheet URL',
        observedUrl: opening.href,
        recovery: 'bind the tab that has the spreadsheet open (anti.browser.tabs.list), then retry',
      });
    }
    const raw = (await browser.eval(
      target,
      findRowsFromGvizScript(sheetId, typeof params.gid === 'string' && params.gid.trim() ? params.gid.trim() : undefined, {
        query: params.query,
        column: typeof params.column === 'string' ? params.column.trim() : undefined,
        exact: params.exact === true,
        caseSensitive: params.caseSensitive === true,
        limit: typeof params.limit === 'number' ? params.limit : FIND_ROWS_DEFAULT_LIMIT,
      }),
      tabId
    )) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object' || raw.ok !== true) {
      const failure = raw && typeof raw === 'object' ? raw : {};
      return {
        success: false,
        error: typeof failure.error === 'string' ? failure.error : 'the GViz probe returned no result',
        ...(typeof failure.status === 'number' ? { httpStatus: failure.status } : {}),
        ...(typeof failure.code === 'string' ? { code: failure.code } : {}),
        ...(Array.isArray(failure.headers) ? { headers: failure.headers } : {}),
        ...(typeof failure.visibility === 'string' ? { tabHidden: failure.visibility === 'hidden' } : {}),
      };
    }
    return {
      success: true,
      sheetId: raw.sheetId,
      gid: raw.gid,
      query: params.query,
      ...(typeof params.column === 'string' ? { column: params.column.trim() } : {}),
      totalRows: raw.totalRows,
      headers: raw.headers,
      matchCount: raw.matchCount,
      truncated: raw.truncated,
      matches: raw.matches,
      ...(typeof raw.visibility === 'string' ? { tabHidden: raw.visibility === 'hidden' } : {}),
    };
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
      confirmTimeoutMs: { type: 'number', minimum: 0, maximum: CONFIRM_TIMEOUT_MAX_MS, description: `Milliseconds to wait for the spreadsheet to show the saved value (default ${CONFIRM_TIMEOUT_DEFAULT_MS}, max ${CONFIRM_TIMEOUT_MAX_MS}); a value still not visible then returns success:false, verified:false with status SAVED_UNCONFIRMED instead of an error` },
      mode: { type: 'string', enum: ['replace', 'append'], description: 'replace (default) overwrites the cell; append writes the live value followed immediately by value (put any separator, such as a newline, inside value) and is refused when the editor and the saved spreadsheet disagree about the live value' },
    },
    required: ['cell', 'value'],
  });
  const rangeInputSchema = (): Record<string, unknown> => ({
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Actual Google Sheets tab ID (defaults to the bound tab)' },
      cell: { type: 'string', pattern: '^[A-Za-z]{1,3}[1-9][0-9]{0,6}$', description: 'A1 notation of the top-left cell of the range, for example "F12"' },
      values: { type: 'array', minItems: 1, maxItems: SHEET_RANGE_MAX_CELLS, items: { type: 'array', minItems: 1, items: { type: ['string', 'number', 'boolean'] } }, description: `Rows of values, written row by row starting at cell (at most ${SHEET_RANGE_MAX_CELLS} cells per call)` },
      expectedPrevious: { type: 'array', items: { type: 'array', items: { type: ['string', 'number', 'boolean'] } }, description: 'Optional precondition per cell, same shape as values: the live values the caller last read' },
      gid: { type: 'string', description: 'Sheet tab gid' },
      allowHeader: { type: 'boolean', description: 'Allow writing to the header row' },
      confirmTimeoutMs: { type: 'number', minimum: 0, maximum: CONFIRM_TIMEOUT_MAX_MS, description: `Per-cell milliseconds to wait for the spreadsheet to show the saved value (default ${CONFIRM_TIMEOUT_DEFAULT_MS}, max ${CONFIRM_TIMEOUT_MAX_MS})` },
      mode: { type: 'string', enum: ['replace', 'append'], description: 'Applied to every cell; see anti.sheet.write_cell' },
    },
    required: ['cell', 'values'],
  });
  const findRowsInputSchema = (): Record<string, unknown> => ({
    type: 'object',
    properties: {
      tabId: { type: 'string', description: 'Actual Google Sheets tab ID (defaults to the bound tab)' },
      query: { type: 'string', description: 'Text to look for in the cells (case-insensitive substring unless exact or caseSensitive is set)' },
      column: { type: 'string', description: 'Restrict the search to one column: a column letter such as "C" or the exact text of a header cell in row 1' },
      gid: { type: 'string', description: 'Sheet tab gid (defaults to the open sheet tab)' },
      exact: { type: 'boolean', description: 'Match a whole cell instead of a substring' },
      caseSensitive: { type: 'boolean', description: 'Match case' },
      limit: { type: 'number', minimum: 1, maximum: FIND_ROWS_MAX_LIMIT, description: `Maximum rows returned (default ${FIND_ROWS_DEFAULT_LIMIT}, max ${FIND_ROWS_MAX_LIMIT}); matchCount still counts every match` },
    },
    required: ['query'],
  });
  const policy = () =>
    browserCaps.makeBrowserPolicy({
      effect: 'interactive-effect',
      risk: 'write',
      requiresBrowserTarget: true,
      lane: 'viewport-gate',
      timeoutMs: SHEET_WRITE_EXECUTION_BUDGET_MS + SHEET_WRITE_CANCELLATION_ACK_MS,
      cancellationAckTimeoutMs: SHEET_WRITE_CANCELLATION_ACK_MS,
    });
  const rangePolicy = () =>
    browserCaps.makeBrowserPolicy({
      effect: 'interactive-effect',
      risk: 'write',
      requiresBrowserTarget: true,
      lane: 'viewport-gate',
      timeoutMs: SHEET_RANGE_EXECUTION_BUDGET_MS + SHEET_WRITE_CANCELLATION_ACK_MS,
      cancellationAckTimeoutMs: SHEET_WRITE_CANCELLATION_ACK_MS,
    });

  catalogue.register({
    name: 'anti.sheet.write_cell',
    description:
      'Write one cell of a Google Sheet through its authenticated in-tab editor: the cell is selected through the Name Box and the selection is confirmed before typing, the header row is protected unless allowHeader is set, a supplied expectedPrevious must equal the live cell value, and the written value is read back from the spreadsheet itself (GViz CSV, not the editor) and returned with the previous one. A value with line breaks is typed with Alt+Enter and checked in the formula bar before the commit. mode append writes the live value plus value. success and verified are true only when the independent read-back matches (polled up to confirmTimeoutMs); a different value or a failed commit fails with SHEET_WRITE_UNVERIFIED, an edit Sheets refuses because the cell is protected fails with SHEET_PROTECTED_RANGE, a value not yet visible when the window ends returns success:false, verified:false with status SAVED_UNCONFIRMED (re-check with anti.sheet.extract; tabHidden marks a hidden tab whose autosave may not flush), and a formula returns success:true, verified:false with status FORMULA_EDITOR_CONFIRMED and reason formula-not-comparable',
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

  catalogue.register({
    name: 'anti.sheet.write_range',
    description:
      `Write a block of cells (values: rows of values, starting at cell) by running the anti.sheet.write_cell pipeline once per cell, row by row, so every gate of a single write applies to every cell: confirmed selection, header protection, expectedPrevious, editor read-back and the independent GViz read-back. It stops at the first cell that is not confirmed and returns success:false with cells (the status of every cell attempted), failedAt and notAttempted; a formula cell is editor-confirmed (success stays true). Never a bulk paste. At most ${SHEET_RANGE_MAX_CELLS} cells and about ${Math.round(SHEET_RANGE_EXECUTION_BUDGET_MS / 1000)} s per call: when the budget ends the answer carries stopped:'budget' and nextCell to continue from`,
    risk: 'write',
    requiresBrowserTarget: true,
    policy: rangePolicy(),
    inputSchema: rangeInputSchema(),
    execute: (params: SheetRangeParams, context) => rangeWrite(params, context),
  });

  catalogue.register({
    name: 'anti.sheet.find_rows',
    description:
      'Find the rows of a Google Sheet whose cells contain a query, in one authenticated in-tab GViz read (cache bypassed). Returns each matching row with its sheet row number, its cell values and the matched columns (1-indexed), plus headers, totalRows and matchCount. Restrict to a column letter or a header name with column; exact matches whole cells.',
    risk: 'read',
    requiresBrowserTarget: true,
    policy: browserCaps.makeBrowserPolicy({ effect: 'read', risk: 'read', requiresBrowserTarget: true, lane: 'viewport-gate' }),
    inputSchema: findRowsInputSchema(),
    execute: (params: SheetFindRowsParams, context) => findRows(params, context),
  });
}

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
 *      A differing read-back is `SHEET_WRITE_UNVERIFIED`. A read-back that still shows the previous
 *      value (or cannot be read) when the confirm window ends is NOT an error: the editor accepted the
 *      value and the spreadsheet may simply still be saving, so the call returns `verified: false` with
 *      `status: 'SAVED_UNCONFIRMED'` and `committed: 'unknown'` for the caller to re-check. A formula's
 *      GViz value is its evaluated result, which cannot be compared with the formula text, so a formula
 *      is reported as `verified: false` with the reason `formula-not-comparable`.
 *   6. a value with line breaks is typed as one segment per line with Alt+Enter between them, and the
 *      formula bar is read back BEFORE the commit: a draft that lost a line break is discarded with
 *      Escape and nothing is committed. Any failure or abort after typing began and before the commit
 *      also discards the draft with Escape (on its own short signal, so an aborted call still cleans up).
 *   7. `mode: 'append'` writes `previous + value`; it is refused unless the editor's previous value
 *      equals the spreadsheet's own (GViz) value, so a formula bar that lost line breaks can never
 *      produce a corrupted append.
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
      if (typingBegan && !commitPressed) await discardDraft();
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
    if (normalizeNewlines(actual) !== normalizeNewlines(finalValue)) {
      throw unverified(`${cell} reads back ${JSON.stringify(actual)} after the write, not the value that was written`, { actual });
    }

    // 5. Independent read-back: the editor echoing the draft proves nothing about the saved cell.
    const base = {
      success: true,
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
        verified: false,
        reason: 'formula-not-comparable',
        observed: evaluated.ok ? evaluated.observed : null,
        note: 'the formula text is confirmed in the editor only; the spreadsheet stores its evaluated result, which cannot be compared with the formula',
      };
    }
    // Autosave can lag by tens of seconds: poll until the window closes. The window never reaches into the
    // execution budget's reserve, so the answer is delivered rather than aborted by the platform.
    const readbackStartedAt = Date.now();
    const windowMs = Math.max(0, Math.min(confirmTimeoutMs, startedAt + SHEET_WRITE_EXECUTION_BUDGET_MS - readbackStartedAt - SHEET_WRITE_READBACK_RESERVE_MS));
    const windowEndsAt = readbackStartedAt + windowMs;
    let attempts = 0;
    let delayMs = GVIZ_POLL_MIN_DELAY_MS;
    let lastRead: GvizRead = { ok: false, error: 'the spreadsheet was never read back' };
    for (;;) {
      attempts += 1;
      lastRead = await readGviz();
      if (lastRead.ok && committedValueMatches(finalValue, lastRead.observed)) {
        return { ...base, verified: true, observed: lastRead.observed, attempts, waitedMs: Date.now() - readbackStartedAt };
      }
      const remainingMs = windowEndsAt - Date.now();
      if (remainingMs <= 0) break;
      await pause(Math.min(delayMs, remainingMs), signal);
      delayMs = Math.min(GVIZ_POLL_MAX_DELAY_MS, Math.round(delayMs * GVIZ_POLL_BACKOFF));
    }
    const waitedMs = Date.now() - readbackStartedAt;
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
    return {
      ...base,
      verified: false,
      status: 'SAVED_UNCONFIRMED',
      committed: 'unknown',
      reason: lastRead.ok ? 'gviz-still-previous' : 'gviz-unreadable',
      observed: lastRead.ok ? lastRead.observed : null,
      ...(lastRead.ok ? {} : { unavailable: lastRead.error, ...(lastRead.status !== undefined ? { httpStatus: lastRead.status } : {}) }),
      attempts,
      waitedMs,
      recheck: 'anti.sheet.extract',
      note: `the editor accepted the value, but the spreadsheet did not show it within ${waitedMs}ms; it may still be saving. Re-read the cell with anti.sheet.extract before writing it again`,
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
      confirmTimeoutMs: { type: 'number', minimum: 0, maximum: CONFIRM_TIMEOUT_MAX_MS, description: `Milliseconds to wait for the spreadsheet to show the saved value (default ${CONFIRM_TIMEOUT_DEFAULT_MS}, max ${CONFIRM_TIMEOUT_MAX_MS}); a value still not visible then returns verified:false with status SAVED_UNCONFIRMED instead of an error` },
      mode: { type: 'string', enum: ['replace', 'append'], description: 'replace (default) overwrites the cell; append writes the live value followed immediately by value (put any separator, such as a newline, inside value) and is refused when the editor and the saved spreadsheet disagree about the live value' },
    },
    required: ['cell', 'value'],
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

  catalogue.register({
    name: 'anti.sheet.write_cell',
    description:
      'Write one cell of a Google Sheet through its authenticated in-tab editor: the cell is selected through the Name Box and the selection is confirmed before typing, the header row is protected unless allowHeader is set, a supplied expectedPrevious must equal the live cell value, and the written value is read back from the spreadsheet itself (GViz CSV, not the editor) and returned with the previous one. A value with line breaks is typed with Alt+Enter and checked in the formula bar before the commit. mode append writes the live value plus value. verified is true only when the independent read-back matches (polled up to confirmTimeoutMs); a different value or a failed commit fails with SHEET_WRITE_UNVERIFIED, a value not yet visible when the window ends returns verified:false with status SAVED_UNCONFIRMED (re-check with anti.sheet.extract), and a formula returns verified:false with reason formula-not-comparable',
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

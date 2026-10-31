// anti.sheet.write_cell drives Google Sheets through trusted input. These tests run the real capability
// against the DOM fixture of the editor in sheet-fixture.ts (Name Box input + formula bar) whose fake host
// behaves like the sheet: Enter in the Name Box selects a cell, Enter in the formula bar commits the typed value.
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { committedValueMatches } from '../../src/main/tools/sheet-capabilities';
import { makeSheet, refusal, withFakeTime } from './sheet-fixture';

const requireFromHere = createRequire(__filename);

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
    const policy = sheet.catalogue.getPolicy('anti.sheet.write_cell');
    assert.strictEqual(policy?.timeoutMs, 130_000, 'execution budget 120 s plus the cancellation ack');
    assert.strictEqual(policy?.cancellationAckTimeoutMs, 10_000);
    const alias = sheet.catalogue.getPolicy('antifan_sheet_write_cell');
    assert.deepStrictEqual([alias?.timeoutMs, alias?.cancellationAckTimeoutMs], [130_000, 10_000]);
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
    assert.strictEqual(urls.length, 2, 'one pre-commit baseline read and one read-back');
    assert.ok(urls[0]?.includes('/spreadsheets/d/1AbCdEfGhIjKlMnOp/gviz/tq?tqx=out:csv&headers=0&gid=0'), urls[0]);
    const kinds = sheet.calls.map((c) => c.kind);
    const lastKey = kinds.lastIndexOf('key');
    const lastFetch = kinds.lastIndexOf('fetch');
    assert.ok(lastFetch > lastKey, 'the independent read-back happens after the last editor interaction');
    const commitClick = sheet.calls.findIndex((c) => c.kind === 'click' && c.selector === '#t-formula-bar-input');
    assert.ok(kinds.indexOf('fetch') < commitClick, 'the baseline read happens before the formula bar is touched');
  });

  it('returns SAVED_UNCONFIRMED, not an error, when the sheet still shows the previous value after the confirm window', async () => {
    const sheet = makeSheet({ grid: { G53: 'old' }, draftSticksInFormulaBar: true });
    const res = await sheet.write({ cell: 'G53', value: 'new', confirmTimeoutMs: 100 });
    assert.strictEqual(res.success, false, 'an unconfirmed write must not read as a success');
    assert.strictEqual(res.verified, false);
    assert.strictEqual(res.status, 'SAVED_UNCONFIRMED');
    assert.strictEqual(res.committed, 'unknown');
    assert.strictEqual(res.observed, 'old');
    assert.strictEqual(res.previous, 'old');
    assert.strictEqual(res.recheck, 'anti.sheet.extract');
    assert.strictEqual(res.attempts, 2);
    assert.strictEqual(sheet.fetchedUrls().length, 3, 'baseline plus two read-back attempts');
    assert.strictEqual(sheet.grid.G53, 'old');
  });

  it('polls the spreadsheet for the whole confirm window, with a growing delay, before giving up', async () => {
    const sheet = makeSheet({ grid: { G53: 'old' }, draftSticksInFormulaBar: true });
    const res = await withFakeTime(() => sheet.write({ cell: 'G53', value: 'new', confirmTimeoutMs: 4_000 }));
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.status, 'SAVED_UNCONFIRMED');
    assert.ok((res.attempts as number) >= 4, `attempts ${String(res.attempts)}`);
    assert.ok((res.waitedMs as number) >= 4_000, `waitedMs ${String(res.waitedMs)}`);
    assert.strictEqual(sheet.fetchedUrls().length, (res.attempts as number) + 1, 'baseline plus every read-back attempt');
  });

  it('keeps polling past the third read: a value that shows up on the fifth read is verified', async () => {
    const sheet = makeSheet({ grid: { B2: 'old' }, gvizLagReads: 4 });
    const res = await withFakeTime(() => sheet.write({ cell: 'B2', value: 'new' }));
    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.observed, 'new');
    assert.strictEqual(res.attempts, 5);
    assert.strictEqual(sheet.fetchedUrls().length, 6, 'baseline plus five read-back attempts');
    assert.ok((res.waitedMs as number) >= 5_000, `waitedMs ${String(res.waitedMs)}`);
  });

  it('treats an empty read-back of an empty previous cell as not yet saved, not as a failure', async () => {
    const sheet = makeSheet({ draftSticksInFormulaBar: true });
    const res = await sheet.write({ cell: 'C3', value: 'x', confirmTimeoutMs: 0 });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.status, 'SAVED_UNCONFIRMED');
    assert.strictEqual(res.observed, '');
    assert.strictEqual(res.attempts, 1);
  });

  it('still refuses as unverified when the spreadsheet moves to a third value after the commit', async () => {
    const sheet = makeSheet({ grid: { D4: 'before' }, draftSticksInFormulaBar: true, gvizAfterCommit: { D4: 'someone else' } });
    const err = await refusal(sheet.write({ cell: 'D4', value: 'new', confirmTimeoutMs: 0 }));
    assert.strictEqual(err.code, 'SHEET_WRITE_UNVERIFIED');
    assert.strictEqual(err.details?.source, 'gviz');
    assert.strictEqual(err.details?.observed, 'someone else');
    assert.strictEqual(err.details?.previous, 'before');
    assert.strictEqual(err.details?.expected, 'new');
  });

  it('returns SAVED_UNCONFIRMED, not an error, when a formula cell still shows its display value because the save is slow', async () => {
    // The formula bar holds "=SUM(A1:A2)" (the previous value) while GViz serves the evaluated "3" before and after.
    const sheet = makeSheet({ grid: { B2: '=SUM(A1:A2)' }, draftSticksInFormulaBar: true, gvizAlways: { B2: '3' } });
    const res = await sheet.write({ cell: 'B2', value: 'new', confirmTimeoutMs: 0 });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.status, 'SAVED_UNCONFIRMED');
    assert.strictEqual(res.verified, false);
    assert.strictEqual(res.observed, '3');
    assert.strictEqual(res.previous, '=SUM(A1:A2)');
  });

  it('returns SAVED_UNCONFIRMED when a formatted number still shows its display text, and still refuses once GViz moves to a different value', async () => {
    const stale = makeSheet({ grid: { C3: '1234.5' }, draftSticksInFormulaBar: true, gvizAlways: { C3: '$1,234.50' } });
    const res = await stale.write({ cell: 'C3', value: 'new', confirmTimeoutMs: 0 });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.status, 'SAVED_UNCONFIRMED');
    assert.strictEqual(res.observed, '$1,234.50');
    const moved = makeSheet({ grid: { C3: '1234.5' }, draftSticksInFormulaBar: true, gvizAfterCommit: { C3: '$9.99' } });
    const err = await refusal(moved.write({ cell: 'C3', value: 'new', confirmTimeoutMs: 0 }));
    assert.strictEqual(err.code, 'SHEET_WRITE_UNVERIFIED');
    assert.strictEqual(err.details?.observed, '$9.99');
  });

  it('returns SAVED_UNCONFIRMED when GViz is unreachable, with the HTTP status and no observed value', async () => {
    const sheet = makeSheet({ gvizStatus: 403 });
    const res = await sheet.write({ cell: 'B2', value: 'new', confirmTimeoutMs: 0 });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.status, 'SAVED_UNCONFIRMED');
    assert.strictEqual(res.reason, 'gviz-unreadable');
    assert.strictEqual(res.observed, null);
    assert.strictEqual(res.httpStatus, 403);
    assert.strictEqual(res.verified, false);
  });

  it('rejects a mode or confirmTimeoutMs it cannot honour before touching the page', async () => {
    const sheet = makeSheet();
    for (const bad of [{ mode: 'prepend' }, { mode: 1 }, { confirmTimeoutMs: -1 }, { confirmTimeoutMs: 90_001 }, { confirmTimeoutMs: '5' }, { confirmTimeoutMs: Number.NaN }]) {
      const err = await refusal(sheet.write({ cell: 'B2', value: 'x', ...bad }));
      assert.strictEqual(err.code, 'INVALID_ARGUMENT', JSON.stringify(bad));
    }
    assert.deepStrictEqual(sheet.calls, []);
  });

  it('waits out autosave lag: a stale first GViz read is retried and then verified', async () => {
    const sheet = makeSheet({ grid: { B2: 'old' }, gvizLagReads: 1 });
    const res = await sheet.write({ cell: 'B2', value: 'new' });
    assert.strictEqual(res.verified, true);
    assert.strictEqual(sheet.fetchedUrls().length, 3, 'baseline plus two read-back attempts');
  });

  it('compares quoted CSV values exactly, including commas, quotes and line breaks', async () => {
    const sheet = makeSheet({ grid: { B2: 'old', A2: 'neighbour' } });
    const res = await sheet.write({ cell: 'B2', value: 'a, "b"\nc' });
    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.observed, 'a, "b"\nc');
  });

  it('types a multi-line value one segment per line with Alt+Enter between them and commits once, with CRLF treated as one break', async () => {
    const sheet = makeSheet({ grid: { B2: 'old' } });
    const res = await sheet.write({ cell: 'B2', value: 'one\r\ntwo\nthree' });
    assert.strictEqual(res.verified, true);
    assert.deepStrictEqual(sheet.formulaBarSteps().slice(0, 6), ['type:one', 'Alt+Enter', 'type:two', 'Alt+Enter', 'type:three', 'Enter']);
    assert.strictEqual(sheet.calls.filter((c) => c.kind === 'type' && c.selector === '#t-formula-bar-input').map((c) => c.clear).join(), 'true,false,false', 'only the first segment clears the cell');
    assert.strictEqual(sheet.grid.B2, 'one\ntwo\nthree');
  });

  it('discards a multi-line draft that lost its line breaks before the commit: Escape, no Enter, nothing saved', async () => {
    const sheet = makeSheet({ grid: { B2: 'old' }, altEnterIgnored: true });
    const err = await refusal(sheet.write({ cell: 'B2', value: 'one\ntwo' }));
    assert.strictEqual(err.code, 'SHEET_WRITE_UNVERIFIED');
    assert.strictEqual(err.details?.step, 'verify the multi-line draft before the commit');
    assert.match(err.message, /nothing was committed/);
    assert.deepStrictEqual(sheet.formulaBarSteps(), ['type:one', 'Alt+Enter', 'type:two', 'Escape']);
    assert.strictEqual(sheet.grid.B2, 'old');
    assert.strictEqual(sheet.fetchedUrls().length, 1, 'only the pre-commit baseline read happens; no read-back is attempted for a write that never committed');
  });

  it('discards the draft with a fresh signal when the call aborts mid-write, and leaves the gate usable', async () => {
    const controller = new AbortController();
    const sheet = makeSheet({ grid: { B2: 'old' }, onFormulaBarType: () => controller.abort() });
    const err = await refusal(sheet.write({ cell: 'B2', value: 'new' }, { signal: controller.signal }));
    assert.strictEqual(err.code, 'SHEET_WRITE_UNVERIFIED');
    assert.strictEqual(sheet.grid.B2, 'old', 'the commit never ran');
    const escapes = sheet.keyPresses.filter((k) => k.key === 'Escape');
    assert.strictEqual(escapes.length, 1);
    assert.strictEqual(escapes[0]?.signalAborted, false, 'the discard must not ride the aborted call signal');
    assert.deepStrictEqual(sheet.formulaBarSteps(), ['type:new', 'Escape'], 'Enter is never pressed after the abort');

    const again = await sheet.write({ cell: 'B2', value: 'new' });
    assert.strictEqual(again.verified, true, 'the viewport gate is acquirable after the abort');
    assert.strictEqual(sheet.grid.B2, 'new');
  });

  it('appends literally: previous + value, with the separator supplied inside value', async () => {
    const sheet = makeSheet({ grid: { B2: 'first' } });
    const res = await sheet.write({ cell: 'B2', value: '\nsecond', mode: 'append' });
    assert.strictEqual(res.verified, true);
    assert.strictEqual(res.mode, 'append');
    assert.strictEqual(res.appended, '\nsecond');
    assert.strictEqual(res.value, 'first\nsecond');
    assert.strictEqual(sheet.grid.B2, 'first\nsecond');

    const plain = makeSheet({ grid: { B2: 'ab' } });
    assert.strictEqual((await plain.write({ cell: 'B2', value: 'cd', mode: 'append' })).verified, true);
    assert.strictEqual(plain.grid.B2, 'abcd');
  });

  it('refuses to append when the editor and the saved spreadsheet disagree about the live value', async () => {
    const sheet = makeSheet({ grid: { B2: 'ab' }, gvizAlways: { B2: 'a\nb' } });
    const err = await refusal(sheet.write({ cell: 'B2', value: 'cd', mode: 'append' }));
    assert.strictEqual(err.code, 'SHEET_PRECONDITION_FAILED');
    assert.strictEqual(err.details?.editorPrevious, 'ab');
    assert.strictEqual(err.details?.savedValue, 'a\nb');
    assert.strictEqual(sheet.typedIntoFormulaBar().length, 0);
    assert.strictEqual(sheet.grid.B2, 'ab');

    const unreachable = makeSheet({ grid: { B2: 'ab' }, gvizStatus: 403 });
    const blocked = await refusal(unreachable.write({ cell: 'B2', value: 'cd', mode: 'append' }));
    assert.strictEqual(blocked.code, 'SHEET_PRECONDITION_FAILED');
    assert.strictEqual(unreachable.typedIntoFormulaBar().length, 0, 'an append that cannot be checked is not written');
  });

  it('does not claim a formula was verified: its GViz value is the evaluated result', async () => {
    const sheet = makeSheet({ grid: { B2: '1' } });
    const res = await sheet.write({ cell: 'B2', value: '=SUM(A2:A3)' });
    assert.strictEqual(res.success, true, 'the editor confirmed the formula text');
    assert.strictEqual(res.verified, false);
    assert.strictEqual(res.status, 'FORMULA_EDITOR_CONFIRMED');
    assert.strictEqual(res.reason, 'formula-not-comparable');
  });

  it('reads GViz with the HTTP cache bypassed and a different nonce on every read', async () => {
    const sheet = makeSheet({ grid: { B2: 'old' }, gvizLagReads: 1 });
    const res = await sheet.write({ cell: 'B2', value: 'new' });
    assert.strictEqual(res.verified, true);
    const fetches = sheet.calls.filter((c) => c.kind === 'fetch');
    assert.ok(fetches.length >= 3);
    for (const fetched of fetches) {
      // The object was built inside the jsdom realm, so compare its JSON rather than its prototype.
      assert.strictEqual(JSON.stringify(fetched.init), JSON.stringify({ credentials: 'include', cache: 'no-store' }));
    }
    const nonces = fetches.map((c) => /[?&]_=([a-z0-9]+)$/.exec(c.text as string)?.[1]);
    assert.ok(nonces.every((n) => typeof n === 'string' && n.length >= 8), `nonces ${nonces.join()}`);
    assert.strictEqual(new Set(nonces).size, nonces.length, 'a nonce is never reused, so no cached copy can answer a later read');
  });

  it('flags a hidden tab on an unconfirmed write and points at tabs.activate with restoreWindow', async () => {
    const hidden = makeSheet({ grid: { G53: 'old' }, draftSticksInFormulaBar: true, visibilityState: 'hidden' });
    const res = await hidden.write({ cell: 'G53', value: 'new', confirmTimeoutMs: 0 });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.status, 'SAVED_UNCONFIRMED');
    assert.strictEqual(res.tabHidden, true);
    assert.match(String(res.recovery), /tabs\.activate/);
    assert.match(String(res.recovery), /restoreWindow/);

    const visible = makeSheet({ grid: { G53: 'old' }, draftSticksInFormulaBar: true, visibilityState: 'visible' });
    const shown = await visible.write({ cell: 'G53', value: 'new', confirmTimeoutMs: 0 });
    assert.strictEqual(shown.tabHidden, false);
    assert.strictEqual(shown.recovery, undefined);
  });

  it('reports SHEET_PROTECTED_RANGE when Sheets raises its protected-cell dialog, dismisses it and stores nothing', async () => {
    const sheet = makeSheet({ grid: { B2: 'locked' }, protectedCells: ['B2'] });
    const err = await refusal(sheet.write({ cell: 'B2', value: 'new' }));
    assert.strictEqual(err.code, 'SHEET_PROTECTED_RANGE');
    assert.strictEqual(err.details?.cell, 'B2');
    assert.strictEqual(err.details?.previous, 'locked');
    assert.match(String(err.details?.dialogText), /protected cell/);
    assert.strictEqual(sheet.grid.B2, 'locked');
    assert.ok(sheet.keyPresses.some((k) => k.key === 'Escape'), 'the dialog is dismissed with Escape');
    const again = await sheet.write({ cell: 'C3', value: 'free' });
    assert.strictEqual(again.verified, true, 'the editor is usable after the dismissed dialog');
  });

  it('recognises the Vietnamese protected-range dialog', async () => {
    const sheet = makeSheet({ grid: { B2: 'khoa' }, protectedCells: ['B2'], protectedDialogText: 'Bạn đang cố chỉnh sửa một ô hoặc đối tượng được bảo vệ.' });
    const err = await refusal(sheet.write({ cell: 'B2', value: 'moi' }));
    assert.strictEqual(err.code, 'SHEET_PROTECTED_RANGE');
  });

  it('does not mistake an unrelated dialog for a protected range', async () => {
    const sheet = makeSheet({ grid: { B2: 'old' }, unrelatedDialogText: 'Share this document with collaborators' });
    const res = await sheet.write({ cell: 'B2', value: 'new' });
    assert.strictEqual(res.verified, true);
  });
});

describe('committedValueMatches', () => {
  it('matches trimmed text, booleans in any case and numbers with thousands separators', () => {
    assert.strictEqual(committedValueMatches('abc', ' abc '), true);
    assert.strictEqual(committedValueMatches('true', 'TRUE'), true);
    assert.strictEqual(committedValueMatches('1234.5', '1,234.5'), true);
    assert.strictEqual(committedValueMatches('', ''), true);
  });

  it('treats CR, CRLF and LF line breaks as the same break', () => {
    assert.strictEqual(committedValueMatches('a\r\nb', 'a\nb'), true);
    assert.strictEqual(committedValueMatches('a\nb', 'a\r\nb'), true);
    assert.strictEqual(committedValueMatches('a\nb', 'a b'), false);
  });

  it('rejects a different, stale or empty observed value', () => {
    assert.strictEqual(committedValueMatches('new', 'old'), false);
    assert.strictEqual(committedValueMatches('new', ''), false);
    assert.strictEqual(committedValueMatches('0', ''), false);
    assert.strictEqual(committedValueMatches('12', '13'), false);
  });
});

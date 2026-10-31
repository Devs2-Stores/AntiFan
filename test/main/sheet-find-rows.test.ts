// anti.sheet.find_rows reads the GViz CSV once and returns the matching rows. It runs against the shared
// sheet fixture, whose fake GViz serves the grid as CSV.
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { makeSheet, refusal } from './sheet-fixture';

const GRID = {
  A1: 'Task', B1: 'Stage', C1: 'Note',
  A2: 'Fix header', B2: 'Done', C2: 'ok',
  A3: 'Cart page', B3: 'Feedback', C3: 'done by Tai',
  A4: 'Footer', B4: 'DONE', C4: '',
};

interface Match {
  row: number;
  cells: string[];
  matchedColumns: number[];
}

describe('anti.sheet.find_rows', () => {
  it('returns every row with a cell containing the query, case-insensitively, with row numbers and matched columns', async () => {
    const sheet = makeSheet({ grid: GRID });
    const res = await sheet.findRows({ query: 'done' });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.matchCount, 3);
    assert.strictEqual(res.truncated, false);
    assert.strictEqual(res.totalRows, 4);
    assert.deepStrictEqual(res.headers, ['Task', 'Stage', 'Note']);
    const matches = res.matches as Match[];
    assert.deepStrictEqual(matches.map((m) => [m.row, m.matchedColumns]), [[2, [2]], [3, [3]], [4, [2]]]);
    assert.deepStrictEqual(matches[0]?.cells, ['Fix header', 'Done', 'ok']);
    assert.strictEqual(sheet.fetchedUrls().length, 1, 'one GViz read');
  });

  it('restricts the search to a column letter or to the exact text of a header cell', async () => {
    const sheet = makeSheet({ grid: GRID });
    const byLetter = await sheet.findRows({ query: 'done', column: 'B' });
    assert.deepStrictEqual((byLetter.matches as Match[]).map((m) => m.row), [2, 4]);
    const byHeader = await sheet.findRows({ query: 'done', column: 'note' });
    assert.deepStrictEqual((byHeader.matches as Match[]).map((m) => m.row), [3]);
  });

  it('reports an unknown header instead of silently searching everything', async () => {
    const sheet = makeSheet({ grid: GRID });
    const res = await sheet.findRows({ query: 'done', column: 'Owner' });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.code, 'COLUMN_NOT_FOUND');
    assert.deepStrictEqual(res.headers, ['Task', 'Stage', 'Note']);
  });

  it('honours exact and caseSensitive', async () => {
    const sheet = makeSheet({ grid: GRID });
    const exact = await sheet.findRows({ query: 'Done', exact: true, caseSensitive: true });
    assert.deepStrictEqual((exact.matches as Match[]).map((m) => m.row), [2]);
    const whole = await sheet.findRows({ query: 'done', exact: true });
    assert.deepStrictEqual((whole.matches as Match[]).map((m) => m.row), [2, 4], 'a whole cell, in any case');
  });

  it('caps the returned rows at limit while matchCount still counts every match', async () => {
    const sheet = makeSheet({ grid: GRID });
    const res = await sheet.findRows({ query: 'done', limit: 2 });
    assert.strictEqual(res.matchCount, 3);
    assert.strictEqual((res.matches as Match[]).length, 2);
    assert.strictEqual(res.truncated, true);
  });

  it('reads the requested gid even when another sheet tab is open, bypassing the HTTP cache', async () => {
    const sheet = makeSheet({ grid: GRID });
    const res = await sheet.findRows({ query: 'footer', gid: '77' });
    assert.strictEqual(res.gid, '77');
    const first = sheet.calls.find((c) => c.kind === 'fetch');
    assert.match(String(first?.text), /gid=77&_=[a-z0-9]+$/);
    assert.strictEqual(JSON.stringify(first?.init), JSON.stringify({ credentials: 'include', cache: 'no-store' }));
  });

  it('reports an unreachable GViz as success:false with the HTTP status, and marks a hidden tab', async () => {
    const down = makeSheet({ grid: GRID, gvizStatus: 403, visibilityState: 'hidden' });
    const res = await down.findRows({ query: 'x' });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.httpStatus, 403);
    assert.strictEqual(res.tabHidden, true);
  });

  it('rejects bad arguments and a tab that is not a spreadsheet', async () => {
    const sheet = makeSheet({ grid: GRID });
    for (const params of [{}, { query: '' }, { query: '  ' }, { query: 'x', column: '' }, { query: 'x', limit: 0 }, { query: 'x', limit: 201 }, { query: 'x', exact: 'yes' }, { query: 'x', gid: 1 }]) {
      assert.strictEqual((await refusal(sheet.findRows(params))).code, 'INVALID_ARGUMENT', JSON.stringify(params));
    }
    assert.deepStrictEqual(sheet.calls, []);
    const other = makeSheet({ url: 'https://example.com/page' });
    assert.strictEqual((await refusal(other.findRows({ query: 'x' }))).code, 'SHEET_NOT_EDITABLE');
  });

  it('is a read capability', () => {
    const sheet = makeSheet();
    assert.strictEqual(sheet.catalogue.get('anti.sheet.find_rows')?.risk, 'read');
    assert.strictEqual(sheet.catalogue.getPolicy('anti.sheet.find_rows')?.effect, 'read');
  });
});
